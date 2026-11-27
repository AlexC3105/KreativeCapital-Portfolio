// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title CampaignManager: EDUCATIONAL KT CROWDFUNDING (local development only)
 * @notice Registry, escrow and pull-based settlement for KT-denominated crowdfunding campaigns.
 *         Unaudited educational code. Not for real funds; never deploy to a public network.
 * @dev    Specification: docs/financial-model.md and docs/architecture.md.
 *         Lifecycle: Active -> Successful | Failed. Contributions only while
 *         block.timestamp < deadline; anyone may finalize once at or after the deadline;
 *         finalization is accounting only. Successful: fee = floor(total * 1%), creator gets
 *         the remainder. Failed: every contributor reclaims exactly their recorded total.
 *         All payouts are pull-based and paid to the entitled caller only.
 *
 *         Ledger: `totalOutstanding` = Σ active escrow + Σ unpaid creator entitlements
 *         + Σ unrefunded failed contributions + platform fees outstanding.
 *         Solvency guard: contribute and every outgoing claim revert with
 *         `Insolvent` while token.balanceOf(this) < totalOutstanding. Creation, finalization
 *         and views stay available; claims resume automatically once backing is restored.
 *         Unsolicited token transfers are never credited to any campaign, fee or claimant.
 *         There is no owner override, freeze, sweep, escrow withdrawal or upgrade path.
 */
contract CampaignManager is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        Active,
        Successful,
        Failed
    }

    enum Phase {
        Open,
        AwaitingFinalization,
        Successful,
        Failed
    }

    struct Campaign {
        address creator;
        uint64 createdAt;
        uint64 deadline;
        Status status;
        bool creatorPaid;
        uint256 goal;
        uint256 totalContributed;
        uint256 platformFee;
        uint256 creatorEntitlement;
        /// @dev This campaign's unpaid obligations (escrow, creator entitlement or unrefunded
        ///      contributions). The fee leaves this bucket at finalization.
        uint256 outstanding;
        string name;
        string description;
    }

    /// @notice The single funding asset (KreativeToken in deployments).
    IERC20 public immutable token;

    uint256 public constant FEE_BPS = 100; // 1%
    uint256 public constant BPS = 10_000;
    uint64 public constant MIN_DURATION = 60;
    uint64 public constant MAX_DURATION = 365 days;
    /// @notice Metadata limits count bytes of the encoded string (UTF-8 byte length).
    uint256 public constant MAX_NAME_BYTES = 64;
    uint256 public constant MAX_DESCRIPTION_BYTES = 500;
    uint256 public constant MAX_PAGE_SIZE = 50;

    uint256 private _campaignCount;
    mapping(uint256 => Campaign) private _campaigns;
    mapping(uint256 => mapping(address => uint256)) private _contributions;
    mapping(uint256 => mapping(address => bool)) private _refundClaimed;

    /// @notice Earned, unclaimed platform fees (owned by the ownership role).
    uint256 public platformFeesOutstanding;
    /// @notice Aggregate outstanding liabilities L across all campaigns and fees.
    uint256 public totalOutstanding;

    event CampaignCreated(uint256 indexed id, address indexed creator, uint256 goal, uint64 deadline, string name);
    event Contributed(uint256 indexed id, address indexed contributor, uint256 amount, uint256 newTotal);
    event Finalized(uint256 indexed id, bool successful, uint256 totalContributed, uint256 platformFee);
    event CreatorPaid(uint256 indexed id, address indexed creator, uint256 amount);
    event Refunded(uint256 indexed id, address indexed contributor, uint256 amount);
    event PlatformFeesClaimed(address indexed to, uint256 amount);

    error UnknownCampaign(uint256 id);
    error InvalidGoal();
    error InvalidDuration();
    error InvalidName();
    error InvalidDescription();
    error ZeroAmount();
    error CampaignEnded();
    error CampaignNotEnded();
    error AlreadyFinalized();
    error NotFinalized();
    error NotSuccessful();
    error NotFailed();
    error NotCreator();
    error AlreadyClaimed();
    error NothingToClaim();
    error ReceivedAmountMismatch(uint256 expected, uint256 received);
    error RenounceDisabled();
    error Insolvent(uint256 balance, uint256 liabilities);
    error InvalidPageSize(uint256 limit);

    constructor(IERC20 token_) {
        token = token_;
    }

    // ---------------------------------------------------------------- lifecycle

    /**
     * @notice Create a campaign. The caller becomes its creator.
     * @param goal Funding goal in token base units (0 < goal <= token total supply).
     * @param duration Seconds until the deadline (60 s to 365 days, inclusive).
     * @param name 1-64 bytes. @param description 0-500 bytes. Names are metadata, not ids.
     */
    function createCampaign(
        uint256 goal,
        uint64 duration,
        string calldata name,
        string calldata description
    ) external returns (uint256 id) {
        if (goal == 0 || goal > token.totalSupply()) revert InvalidGoal();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert InvalidDuration();
        uint256 nameLength = bytes(name).length;
        if (nameLength == 0 || nameLength > MAX_NAME_BYTES) revert InvalidName();
        if (bytes(description).length > MAX_DESCRIPTION_BYTES) revert InvalidDescription();

        id = ++_campaignCount;
        Campaign storage c = _campaigns[id];
        c.creator = msg.sender;
        c.createdAt = uint64(block.timestamp);
        c.deadline = uint64(block.timestamp) + duration;
        c.goal = goal;
        c.name = name;
        c.description = description;
        emit CampaignCreated(id, msg.sender, goal, c.deadline, name);
    }

    /**
     * @notice Contribute `amount` tokens (requires prior approval) before the deadline.
     * @dev The amount is recorded only if exactly `amount` was received. The inbound
     *      transfer precedes the bookkeeping because the receipt must be measured; the
     *      function is nonReentrant and any failure reverts atomically.
     */
    function contribute(uint256 id, uint256 amount) external nonReentrant {
        Campaign storage c = _existing(id);
        if (c.status != Status.Active || block.timestamp >= c.deadline) revert CampaignEnded();
        if (amount == 0) revert ZeroAmount();
        _requireSolvent();

        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - balanceBefore;
        if (received != amount) revert ReceivedAmountMismatch(amount, received);

        _contributions[id][msg.sender] += amount;
        c.totalContributed += amount;
        c.outstanding += amount;
        totalOutstanding += amount;
        emit Contributed(id, msg.sender, amount, c.totalContributed);
    }

    /**
     * @notice Finalize a campaign at or after its deadline. Permissionless; executes once.
     * @dev Accounting only: no token transfers. `totalOutstanding` is unchanged (escrow is
     *      reclassified into creator entitlement + platform fee, or into refunds).
     */
    function finalize(uint256 id) external {
        Campaign storage c = _existing(id);
        if (c.status != Status.Active) revert AlreadyFinalized();
        if (block.timestamp < c.deadline) revert CampaignNotEnded();

        uint256 total = c.totalContributed;
        if (total >= c.goal) {
            uint256 fee = (total * FEE_BPS) / BPS;
            c.status = Status.Successful;
            c.platformFee = fee;
            c.creatorEntitlement = total - fee;
            c.outstanding = total - fee;
            platformFeesOutstanding += fee;
            emit Finalized(id, true, total, fee);
        } else {
            c.status = Status.Failed;
            emit Finalized(id, false, total, 0);
        }
    }

    // ---------------------------------------------------------------- claims (pull-based)

    /// @notice Creator claims the entitlement of their own successful campaign, once.
    function claimCreatorPayout(uint256 id) external nonReentrant {
        Campaign storage c = _existing(id);
        if (c.status == Status.Active) revert NotFinalized();
        if (c.status != Status.Successful) revert NotSuccessful();
        if (msg.sender != c.creator) revert NotCreator();
        if (c.creatorPaid) revert AlreadyClaimed();
        _requireSolvent();

        uint256 amount = c.creatorEntitlement;
        c.creatorPaid = true;
        c.outstanding -= amount;
        totalOutstanding -= amount;
        token.safeTransfer(msg.sender, amount);
        emit CreatorPaid(id, msg.sender, amount);
    }

    /// @notice Contributor reclaims their full recorded contribution to a failed campaign, once.
    function claimRefund(uint256 id) external nonReentrant {
        Campaign storage c = _existing(id);
        if (c.status == Status.Active) revert NotFinalized();
        if (c.status != Status.Failed) revert NotFailed();
        uint256 amount = _contributions[id][msg.sender];
        if (amount == 0) revert NothingToClaim();
        if (_refundClaimed[id][msg.sender]) revert AlreadyClaimed();
        _requireSolvent();

        _refundClaimed[id][msg.sender] = true;
        c.outstanding -= amount;
        totalOutstanding -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Refunded(id, msg.sender, amount);
    }

    /// @notice The current owner claims all earned, unclaimed platform fees.
    function claimPlatformFees() external onlyOwner nonReentrant {
        uint256 amount = platformFeesOutstanding;
        if (amount == 0) revert NothingToClaim();
        _requireSolvent();

        platformFeesOutstanding = 0;
        totalOutstanding -= amount;
        token.safeTransfer(msg.sender, amount);
        emit PlatformFeesClaimed(msg.sender, amount);
    }

    /// @notice Disabled: renouncing would strand earned platform fees.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ---------------------------------------------------------------- views

    function campaignCount() external view returns (uint256) {
        return _campaignCount;
    }

    function getCampaign(uint256 id) external view returns (Campaign memory) {
        return _existing(id);
    }

    /**
     * @notice Campaigns `firstId` .. `firstId + limit - 1` (clamped to the last id).
     * @dev Reverts for `firstId == 0` or `limit > MAX_PAGE_SIZE`; returns an empty array when
     *      `limit == 0` or `firstId` is beyond the last id.
     */
    function getCampaigns(uint256 firstId, uint256 limit) external view returns (Campaign[] memory page) {
        if (limit > MAX_PAGE_SIZE) revert InvalidPageSize(limit);
        if (firstId == 0) revert UnknownCampaign(0);
        uint256 count = _campaignCount;
        if (limit == 0 || firstId > count) return new Campaign[](0);
        uint256 last = firstId + limit - 1;
        if (last > count) last = count;
        page = new Campaign[](last - firstId + 1);
        for (uint256 i = 0; i < page.length; i++) {
            page[i] = _campaigns[firstId + i];
        }
    }

    function phase(uint256 id) external view returns (Phase) {
        Campaign storage c = _existing(id);
        if (c.status == Status.Successful) return Phase.Successful;
        if (c.status == Status.Failed) return Phase.Failed;
        return block.timestamp < c.deadline ? Phase.Open : Phase.AwaitingFinalization;
    }

    function contributionOf(uint256 id, address contributor) external view returns (uint256) {
        _existing(id);
        return _contributions[id][contributor];
    }

    function refundClaimed(uint256 id, address contributor) external view returns (bool) {
        _existing(id);
        return _refundClaimed[id][contributor];
    }

    /// @notice Actual token balance held by this contract (never reverts).
    function tokenBalance() public view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice True iff the token balance covers all outstanding liabilities.
    function isSolvent() public view returns (bool) {
        return tokenBalance() >= totalOutstanding;
    }

    /// @notice Balance above liabilities (unsolicited tokens; locked, no sweep). 0 if insolvent.
    function excessBalance() external view returns (uint256) {
        uint256 balance = tokenBalance();
        return balance > totalOutstanding ? balance - totalOutstanding : 0;
    }

    /// @notice Liabilities not covered by the balance. 0 if solvent.
    function shortfall() external view returns (uint256) {
        uint256 balance = tokenBalance();
        return totalOutstanding > balance ? totalOutstanding - balance : 0;
    }

    // ---------------------------------------------------------------- internal

    function _existing(uint256 id) internal view returns (Campaign storage) {
        if (id == 0 || id > _campaignCount) revert UnknownCampaign(id);
        return _campaigns[id];
    }

    function _requireSolvent() internal view {
        uint256 balance = token.balanceOf(address(this));
        uint256 liabilities = totalOutstanding;
        if (balance < liabilities) revert Insolvent(balance, liabilities);
    }
}

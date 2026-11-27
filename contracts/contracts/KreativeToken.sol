// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title KreativeToken (KT): EDUCATIONAL TOKEN
 * @notice Fixed-supply ERC-20 used by the KreativeCapital educational crowdfunding project.
 *         KT has NO promised value, NO redemption rights and NO real-world backing. It is
 *         intended for a local development chain only; never deploy to a public network.
 * @dev    Rules (see docs/financial-model.md):
 *         - 1,000,000 KT minted once to this contract as the sale reserve. No mint,
 *           no burn, no owner allocation, no owner access to the reserve.
 *         - `saleReserve` is a recorded counter; unsolicited KT sent here never increases it.
 *         - 1 wei buys exactly 100 base units (100 KT per ETH; both 18 decimals). No caps.
 *         - Sale proceeds are recorded; the owner role withdraws only recorded, unwithdrawn
 *           proceeds. Unsolicited (forced) ETH and unsolicited KT stay locked (no sweep).
 *         - Two-step ownership; renunciation disabled.
 *         The original 2024 capstone design is summarised in docs/project-history.md.
 */
contract KreativeToken is ERC20, Ownable2Step, ReentrancyGuard {
    /// @notice Fixed total supply: 1,000,000 KT in base units (18 decimals).
    uint256 public constant TOTAL_SUPPLY = 1_000_000 ether;
    /// @notice Base units of KT bought per wei of ETH (100 KT per ETH).
    uint256 public constant TOKENS_PER_ETH = 100;

    /// @notice KT still available for sale (recorded; decreases only through purchases).
    uint256 public saleReserve;
    /// @notice Cumulative ETH received through `buyTokens` (recorded).
    uint256 public totalProceeds;
    /// @notice Cumulative ETH withdrawn by the owner role.
    uint256 public proceedsWithdrawn;

    event TokensPurchased(address indexed buyer, uint256 ethPaid, uint256 tokensBought);
    event ProceedsWithdrawn(address indexed to, uint256 amount);

    error ZeroPurchase();
    error InsufficientReserve(uint256 requested, uint256 available);
    error NoProceeds();
    error RenounceDisabled();
    error EthTransferFailed();

    constructor() ERC20("KreativeToken", "KT") {
        _mint(address(this), TOTAL_SUPPLY);
        saleReserve = TOTAL_SUPPLY;
    }

    /**
     * @notice Buy KT from the sale reserve at exactly 100 base units per wei.
     * @dev Reverts on zero payment or if the request exceeds the recorded reserve (no partial fill).
     */
    function buyTokens() external payable nonReentrant {
        if (msg.value == 0) revert ZeroPurchase();
        uint256 tokens = msg.value * TOKENS_PER_ETH;
        uint256 available = saleReserve;
        if (tokens > available) revert InsufficientReserve(tokens, available);

        saleReserve = available - tokens;
        totalProceeds += msg.value;
        _transfer(address(this), msg.sender, tokens);
        emit TokensPurchased(msg.sender, msg.value, tokens);
    }

    /**
     * @notice Withdraw all recorded, not yet withdrawn sale proceeds to the current owner.
     * @dev State is updated before the external call; a failed call reverts everything, so the
     *      proceeds remain recorded and withdrawable. Never touches KT supply or balances.
     */
    function withdrawProceeds() external onlyOwner nonReentrant {
        uint256 amount = totalProceeds - proceedsWithdrawn;
        if (amount == 0) revert NoProceeds();
        proceedsWithdrawn += amount;

        address to = owner();
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert EthTransferFailed();
        emit ProceedsWithdrawn(to, amount);
    }

    /// @notice KT sold so far.
    function tokensSold() external view returns (uint256) {
        return TOTAL_SUPPLY - saleReserve;
    }

    /// @notice Recorded proceeds not yet withdrawn.
    function unwithdrawnProceeds() public view returns (uint256) {
        return totalProceeds - proceedsWithdrawn;
    }

    /// @notice KT held by this contract beyond the recorded sale reserve (locked; never sold).
    function unsolicitedTokenBalance() external view returns (uint256) {
        uint256 held = balanceOf(address(this));
        return held > saleReserve ? held - saleReserve : 0;
    }

    /// @notice ETH held beyond recorded unwithdrawn proceeds (forced ETH; locked; never withdrawn).
    function unsolicitedEthBalance() external view returns (uint256) {
        uint256 held = address(this).balance;
        uint256 recorded = unwithdrawnProceeds();
        return held > recorded ? held - recorded : 0;
    }

    /// @notice Disabled: renouncing would strand recorded proceeds.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }
}

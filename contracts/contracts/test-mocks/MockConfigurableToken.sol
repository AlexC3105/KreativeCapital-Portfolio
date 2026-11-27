// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockConfigurableToken (TEST ONLY)
 * @notice ERC-20 with switchable misbehaviour, used to verify CampaignManager failure handling:
 *         transfers that return false, transfers that revert, fee-on-transfer receipts and a
 *         reentrancy attempt during outgoing transfers. Never deployed by project scripts and
 *         never used with the canonical KreativeToken.
 */
contract MockConfigurableToken is ERC20 {
    enum Mode {
        Normal,
        ReturnFalse,
        Revert,
        FeeOnTransfer,
        Reenter
    }

    Mode public mode;
    address public reentryTarget;
    bytes public reentryData;

    constructor() ERC20("Mock Token", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setMode(Mode newMode) external {
        mode = newMode;
    }

    function setReentry(address target, bytes calldata data) external {
        reentryTarget = target;
        reentryData = data;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (mode == Mode.ReturnFalse) return false;
        if (mode == Mode.Revert) revert("MockToken: transfer reverted");
        if (mode == Mode.Reenter && reentryTarget != address(0)) {
            (bool ok, bytes memory ret) = reentryTarget.call(reentryData);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (mode == Mode.Reenter && reentryTarget != address(0)) {
            (bool ok, bytes memory ret) = reentryTarget.call(reentryData);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        if (mode == Mode.FeeOnTransfer) {
            uint256 fee = amount / 100 + 1;
            _spendAllowance(from, _msgSender(), amount);
            _transfer(from, to, amount - fee);
            _burn(from, fee);
            return true;
        }
        return super.transferFrom(from, to, amount);
    }
}

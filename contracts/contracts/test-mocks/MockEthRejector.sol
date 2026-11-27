// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title MockEthRejector (TEST ONLY)
 * @notice Test helper that can become a contract owner and refuse ETH. Used to verify
 *         that failed ETH transfers roll back state. Never deployed by project scripts.
 */
interface IOwnable2StepLike {
    function acceptOwnership() external;
}

contract MockEthRejector {
    bool public acceptEth;
    address public reentryTarget;
    bytes public reentryData;

    /// @notice When set, `receive` first re-calls `target` with `data` (reentrancy probe).
    function setReentry(address target, bytes calldata data) external {
        reentryTarget = target;
        reentryData = data;
    }

    function setAcceptEth(bool value) external {
        acceptEth = value;
    }

    function acceptOwnershipOf(address target) external {
        IOwnable2StepLike(target).acceptOwnership();
    }

    /// @notice Forward a call and bubble up any revert data unchanged.
    function forward(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    receive() external payable {
        if (reentryTarget != address(0)) {
            (bool ok, bytes memory ret) = reentryTarget.call(reentryData);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        require(acceptEth, "MockEthRejector: ETH rejected");
    }
}

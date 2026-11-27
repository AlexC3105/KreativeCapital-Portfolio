// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// TEST-ONLY. A non-standard token outside the project's supported scope: when `taxSender` is
/// set, its outgoing transfers burn an extra 1% from the sender (the sender loses amount + fee
/// while the recipient receives amount). Used to document that CampaignManager's solvency guard
/// assumes exact outgoing transfers, which the canonical KreativeToken provides.
contract MockOutgoingFeeToken is ERC20 {
    address public taxSender;

    constructor() ERC20("Mock outgoing-fee token", "MOFT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTaxSender(address sender) external {
        taxSender = sender;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (msg.sender == taxSender && taxSender != address(0)) _burn(msg.sender, amount / 100);
        return super.transfer(to, amount);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ICrowdfunding {
    function contribute(uint256 campaignId) external payable;
    function claimRefund(uint256 campaignId) external;
}

/// Test helper only, do not deploy. Tries to claim a refund twice by
/// re-entering claimRefund from receive().
contract RefundAttacker {
    ICrowdfunding public target;
    uint256 public campaignId;
    uint256 public reentryAttempts;

    constructor(address target_) { target = ICrowdfunding(target_); }

    function fund(uint256 id) external payable {
        campaignId = id;
        target.contribute{value: msg.value}(id);
    }

    function attack() external { target.claimRefund(campaignId); }

    receive() external payable {
        // Keep re-entering while the contract still holds other backers' ETH.
        if (address(target).balance >= msg.value) {
            reentryAttempts++;
            target.claimRefund(campaignId);
        }
    }
}

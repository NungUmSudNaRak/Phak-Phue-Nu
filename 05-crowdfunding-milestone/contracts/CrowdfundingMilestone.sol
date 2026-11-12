// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title InnovateFund - Milestone-based Crowdfunding
/// @notice Backers' ETH stays in this contract and is paid to the campaign owner
///         one milestone at a time, only after backers vote to approve it.
/// @dev The owner has no withdraw function. ETH leaves the contract only as an
///      approved milestone payout or as a refund to backers. Milestone budgets
///      must add up to the goal and contributions stop at the goal, so payouts
///      can never exceed the funds raised.
contract CrowdfundingMilestone {
    /// @notice Share of all contributed ETH, in percent, that must vote to approve
    ///         a milestone. Voting weight equals the amount contributed.
    uint256 public constant APPROVAL_PERCENT = 50;
    uint256 public constant MAX_MILESTONES = 10;

    enum CampaignStatus {
        Funding, // accepting contributions until the goal or the deadline
        Failed, // goal or a milestone deadline missed; backers can claim refunds
        Active, // goal reached; milestones are being delivered
        Completed // every milestone has been paid
    }

    enum MilestoneStatus {
        Pending, // release not requested yet
        Voting, // owner submitted evidence and backers are voting
        Rejected, // last vote failed; owner may resubmit before the deadline
        Released // approved and paid to the owner
    }

    /// @dev Input format for createCampaign.
    struct MilestoneInput {
        string description;
        uint256 amount; // wei
        uint256 duration; // seconds, counted from the previous milestone's deadline
    }

    struct Campaign {
        address owner;
        string title;
        string description;
        uint256 goal;
        uint256 deadline; // end of the funding period
        uint256 votingPeriod; // seconds each milestone vote stays open
        uint256 totalRaised;
        uint256 totalReleased;
        uint256 totalRefunded;
        uint256 backerCount;
        uint256 currentMilestone; // index of the next milestone to pay
        uint256 createdAt;
    }

    struct Milestone {
        string description;
        uint256 amount;
        uint256 deadline; // must be approved by this time or the campaign fails
        MilestoneStatus status;
        string evidence; // latest proof of completion, e.g. a URL or IPFS CID
        uint256 attempts; // number of release requests so far
        uint256 votingEndsAt;
        uint256 approveWeight; // wei held by backers who approved
        uint256 rejectWeight; // wei held by backers who rejected
        uint256 releasedAt;
    }

    uint256 public campaignCount;

    mapping(uint256 => Campaign) private campaigns;
    mapping(uint256 => Milestone[]) private milestones;
    mapping(uint256 => mapping(address => uint256)) public contributions;
    mapping(uint256 => mapping(address => bool)) public hasRefunded;
    /// @dev campaignId => milestone index => backer => attempt they last voted in.
    ///      A new release request increments `attempts`, which resets every vote.
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) private lastVotedAttempt;

    bool private locked;

    event CampaignCreated(
        uint256 indexed campaignId,
        address indexed owner,
        string title,
        uint256 goal,
        uint256 deadline
    );
    event Contributed(
        uint256 indexed campaignId,
        address indexed backer,
        uint256 amount,
        uint256 totalRaised
    );
    event MilestoneReleaseRequested(
        uint256 indexed campaignId,
        uint256 indexed milestoneIndex,
        uint256 attempt,
        string evidence,
        uint256 votingEndsAt
    );
    event MilestoneVoted(
        uint256 indexed campaignId,
        uint256 indexed milestoneIndex,
        address indexed backer,
        bool approve,
        uint256 weight
    );
    event MilestoneRejected(uint256 indexed campaignId, uint256 indexed milestoneIndex, uint256 attempt);
    event MilestoneReleased(
        uint256 indexed campaignId,
        uint256 indexed milestoneIndex,
        address indexed owner,
        uint256 amount
    );
    event Refunded(uint256 indexed campaignId, address indexed backer, uint256 amount);

    error CampaignNotFound(uint256 campaignId);
    error NotCampaignOwner();
    error EmptyValue();
    error ZeroValue();
    error InvalidMilestoneCount(uint256 count);
    error MilestoneTotalMismatch(uint256 goal, uint256 milestoneTotal);
    error InvalidMilestoneIndex(uint256 index);
    error WrongStatus(CampaignStatus expected, CampaignStatus actual);
    error OwnerCannotContribute();
    error ExceedsGoal(uint256 remaining);
    error VoteInProgress();
    error NoVoteInProgress();
    error VotingClosed();
    error VotingStillOpen();
    error NotBacker();
    error AlreadyVoted();
    error ExceedsAllocatedFunds();
    error AlreadyRefunded();
    error NothingToRefund();
    error TransferFailed();
    error ReentrantCall();

    modifier campaignExists(uint256 campaignId) {
        if (campaigns[campaignId].owner == address(0)) revert CampaignNotFound(campaignId);
        _;
    }

    /// @dev Blocks a receiver from calling back in while ETH is being sent.
    modifier nonReentrant() {
        if (locked) revert ReentrantCall();
        locked = true;
        _;
        locked = false;
    }

    // ---------------------------------------------------------------------
    // Requirement 1: Create Campaign
    // ---------------------------------------------------------------------

    /// @notice Creates a campaign. Milestone amounts must add up to `goal`.
    /// @param fundingDuration Seconds from now until funding closes.
    /// @param votingPeriod Seconds each milestone vote stays open.
    /// @param milestoneInputs Milestones in delivery order. Each deadline is the
    ///        previous deadline (the funding deadline for the first) plus `duration`.
    function createCampaign(
        string calldata title,
        string calldata description,
        uint256 goal,
        uint256 fundingDuration,
        uint256 votingPeriod,
        MilestoneInput[] calldata milestoneInputs
    ) external returns (uint256 campaignId) {
        if (bytes(title).length == 0) revert EmptyValue();
        if (goal == 0 || fundingDuration == 0 || votingPeriod == 0) revert ZeroValue();
        if (milestoneInputs.length == 0 || milestoneInputs.length > MAX_MILESTONES) {
            revert InvalidMilestoneCount(milestoneInputs.length);
        }

        campaignId = ++campaignCount;
        Campaign storage c = campaigns[campaignId];
        c.owner = msg.sender;
        c.title = title;
        c.description = description;
        c.goal = goal;
        c.deadline = block.timestamp + fundingDuration;
        c.votingPeriod = votingPeriod;
        c.createdAt = block.timestamp;

        uint256 milestoneTotal = _storeMilestones(campaignId, c.deadline, milestoneInputs);
        if (milestoneTotal != goal) revert MilestoneTotalMismatch(goal, milestoneTotal);

        emit CampaignCreated(campaignId, msg.sender, title, goal, c.deadline);
    }

    // ---------------------------------------------------------------------
    // Requirement 2: Contribute Funds
    // ---------------------------------------------------------------------

    /// @notice Sends ETH to a campaign. The total can never go above the goal.
    function contribute(uint256 campaignId) external payable campaignExists(campaignId) {
        _requireStatus(campaignId, CampaignStatus.Funding);
        Campaign storage c = campaigns[campaignId];
        // The owner would otherwise vote on their own milestones with this weight.
        if (msg.sender == c.owner) revert OwnerCannotContribute();
        if (msg.value == 0) revert ZeroValue();

        uint256 remaining = c.goal - c.totalRaised;
        if (msg.value > remaining) revert ExceedsGoal(remaining);

        if (contributions[campaignId][msg.sender] == 0) c.backerCount++;
        contributions[campaignId][msg.sender] += msg.value;
        c.totalRaised += msg.value;

        emit Contributed(campaignId, msg.sender, msg.value, c.totalRaised);
    }

    // ---------------------------------------------------------------------
    // Requirement 4: Request Fund Release
    // ---------------------------------------------------------------------

    /// @notice The owner submits proof for the current milestone and opens a vote.
    ///         After a rejected vote the owner may submit again before the deadline.
    /// @param evidence Proof of completion, such as a URL or an IPFS CID.
    function requestRelease(uint256 campaignId, string calldata evidence)
        external
        campaignExists(campaignId)
    {
        Campaign storage c = campaigns[campaignId];
        if (msg.sender != c.owner) revert NotCampaignOwner();
        // Active also means the current milestone's deadline has not passed.
        _requireStatus(campaignId, CampaignStatus.Active);
        if (bytes(evidence).length == 0) revert EmptyValue();

        uint256 index = c.currentMilestone;
        Milestone storage m = milestones[campaignId][index];
        if (m.status == MilestoneStatus.Voting) revert VoteInProgress();

        m.status = MilestoneStatus.Voting;
        m.evidence = evidence;
        m.attempts++;
        m.votingEndsAt = block.timestamp + c.votingPeriod;
        m.approveWeight = 0;
        m.rejectWeight = 0;

        emit MilestoneReleaseRequested(campaignId, index, m.attempts, evidence, m.votingEndsAt);
    }

    // ---------------------------------------------------------------------
    // Requirement 5: Approve Milestone
    // ---------------------------------------------------------------------

    /// @notice A backer votes on the current milestone. Weight = ETH contributed.
    function voteOnMilestone(uint256 campaignId, bool approve) external campaignExists(campaignId) {
        _requireStatus(campaignId, CampaignStatus.Active);
        uint256 index = campaigns[campaignId].currentMilestone;
        Milestone storage m = milestones[campaignId][index];
        if (m.status != MilestoneStatus.Voting) revert NoVoteInProgress();
        if (block.timestamp >= m.votingEndsAt) revert VotingClosed();

        uint256 weight = contributions[campaignId][msg.sender];
        if (weight == 0) revert NotBacker();
        if (lastVotedAttempt[campaignId][index][msg.sender] == m.attempts) revert AlreadyVoted();

        lastVotedAttempt[campaignId][index][msg.sender] = m.attempts;
        if (approve) {
            m.approveWeight += weight;
        } else {
            m.rejectWeight += weight;
        }

        emit MilestoneVoted(campaignId, index, msg.sender, approve, weight);
    }

    /// @notice Closes the vote and pays the owner if it passed. Anyone can call it
    ///         once the result is certain or the voting period has ended.
    function finalizeMilestone(uint256 campaignId) external nonReentrant campaignExists(campaignId) {
        _requireStatus(campaignId, CampaignStatus.Active);
        Campaign storage c = campaigns[campaignId];
        uint256 index = c.currentMilestone;
        Milestone storage m = milestones[campaignId][index];
        if (m.status != MilestoneStatus.Voting) revert NoVoteInProgress();

        bool approved = _hasPassed(m.approveWeight, c.totalRaised);
        bool cannotPass = _cannotPass(m.rejectWeight, c.totalRaised);
        if (!approved && !cannotPass && block.timestamp < m.votingEndsAt) revert VotingStillOpen();

        if (!approved) {
            m.status = MilestoneStatus.Rejected;
            emit MilestoneRejected(campaignId, index, m.attempts);
            return;
        }

        // Business rule: never pay out more than was raised. Budgets summing to
        // the goal already guarantee this; the check makes the rule explicit.
        if (c.totalReleased + m.amount > c.totalRaised) revert ExceedsAllocatedFunds();

        m.status = MilestoneStatus.Released;
        m.releasedAt = block.timestamp;
        c.totalReleased += m.amount;
        c.currentMilestone = index + 1;

        emit MilestoneReleased(campaignId, index, c.owner, m.amount);
        _sendEth(c.owner, m.amount);
    }

    // ---------------------------------------------------------------------
    // Requirement 6: Refund Contribution
    // ---------------------------------------------------------------------

    /// @notice Returns a backer's ETH once the campaign has failed. If some
    ///         milestones were already paid, each backer gets back their share
    ///         of the ETH that is left.
    function claimRefund(uint256 campaignId) external nonReentrant campaignExists(campaignId) {
        _requireStatus(campaignId, CampaignStatus.Failed);
        if (hasRefunded[campaignId][msg.sender]) revert AlreadyRefunded();

        uint256 amount = _refundAmount(campaignId, msg.sender);
        if (amount == 0) revert NothingToRefund();

        // Update state before sending ETH (checks-effects-interactions).
        hasRefunded[campaignId][msg.sender] = true;
        campaigns[campaignId].totalRefunded += amount;

        emit Refunded(campaignId, msg.sender, amount);
        _sendEth(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Requirements 3 and 7: views for the progress and transparency dashboard.
    // The full money in/out history comes from the Contributed,
    // MilestoneReleased and Refunded events.
    // ---------------------------------------------------------------------

    /// @notice Requirement 3: amount raised, goal and seconds left to contribute.
    function getFundingProgress(uint256 campaignId)
        external
        view
        campaignExists(campaignId)
        returns (uint256 totalRaised, uint256 goal, uint256 timeLeft, uint256 backerCount)
    {
        Campaign storage c = campaigns[campaignId];
        totalRaised = c.totalRaised;
        goal = c.goal;
        timeLeft = block.timestamp < c.deadline ? c.deadline - block.timestamp : 0;
        backerCount = c.backerCount;
    }

    /// @notice Requirement 7: campaign details, money totals and current status.
    function getCampaign(uint256 campaignId)
        external
        view
        campaignExists(campaignId)
        returns (Campaign memory campaign, CampaignStatus status)
    {
        campaign = campaigns[campaignId];
        status = _statusOf(campaignId);
    }

    /// @notice Requirement 7: every milestone with its budget, status and votes.
    function getMilestones(uint256 campaignId)
        external
        view
        campaignExists(campaignId)
        returns (Milestone[] memory)
    {
        return milestones[campaignId];
    }

    function getCampaignStatus(uint256 campaignId)
        external
        view
        campaignExists(campaignId)
        returns (CampaignStatus)
    {
        return _statusOf(campaignId);
    }

    /// @notice How much a backer could claim with claimRefund right now.
    function getRefundAmount(uint256 campaignId, address backer)
        external
        view
        campaignExists(campaignId)
        returns (uint256)
    {
        if (_statusOf(campaignId) != CampaignStatus.Failed || hasRefunded[campaignId][backer]) {
            return 0;
        }
        return _refundAmount(campaignId, backer);
    }

    /// @notice The chain's current time, the clock every deadline here is checked
    ///         against. Frontends use it because the viewer's clock can be wrong.
    function currentTime() external view returns (uint256) {
        return block.timestamp;
    }

    /// @notice Whether a backer has voted on the latest release request of a milestone.
    function hasVoted(uint256 campaignId, uint256 milestoneIndex, address backer)
        external
        view
        campaignExists(campaignId)
        returns (bool)
    {
        if (milestoneIndex >= milestones[campaignId].length) revert InvalidMilestoneIndex(milestoneIndex);
        uint256 attempts = milestones[campaignId][milestoneIndex].attempts;
        return attempts != 0 && lastVotedAttempt[campaignId][milestoneIndex][backer] == attempts;
    }

    // ---------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------

    function _storeMilestones(
        uint256 campaignId,
        uint256 fundingDeadline,
        MilestoneInput[] calldata inputs
    ) private returns (uint256 total) {
        uint256 deadline = fundingDeadline;
        for (uint256 i = 0; i < inputs.length; i++) {
            if (bytes(inputs[i].description).length == 0) revert EmptyValue();
            if (inputs[i].amount == 0 || inputs[i].duration == 0) revert ZeroValue();

            deadline += inputs[i].duration;
            total += inputs[i].amount;

            Milestone storage m = milestones[campaignId].push();
            m.description = inputs[i].description;
            m.amount = inputs[i].amount;
            m.deadline = deadline;
        }
    }

    /// @dev Status is worked out from stored data and the current time, so no
    ///      transaction is needed for a deadline to take effect.
    function _statusOf(uint256 campaignId) private view returns (CampaignStatus) {
        Campaign storage c = campaigns[campaignId];
        if (c.totalRaised < c.goal) {
            return block.timestamp < c.deadline ? CampaignStatus.Funding : CampaignStatus.Failed;
        }

        Milestone[] storage list = milestones[campaignId];
        if (c.currentMilestone == list.length) return CampaignStatus.Completed;

        // A vote that has not been finalized can still pass, so the campaign
        // fails only when the deadline has passed and no vote is pending.
        Milestone storage m = list[c.currentMilestone];
        if (block.timestamp >= m.deadline && m.status != MilestoneStatus.Voting) {
            return CampaignStatus.Failed;
        }
        return CampaignStatus.Active;
    }

    function _requireStatus(uint256 campaignId, CampaignStatus expected) private view {
        CampaignStatus actual = _statusOf(campaignId);
        if (actual != expected) revert WrongStatus(expected, actual);
    }

    /// @dev True when approvals are more than APPROVAL_PERCENT of all contributions.
    function _hasPassed(uint256 approveWeight, uint256 totalRaised) private pure returns (bool) {
        return approveWeight * 100 > totalRaised * APPROVAL_PERCENT;
    }

    /// @dev True when enough has been rejected that approvals can no longer pass.
    function _cannotPass(uint256 rejectWeight, uint256 totalRaised) private pure returns (bool) {
        return rejectWeight * 100 >= totalRaised * (100 - APPROVAL_PERCENT);
    }

    /// @dev Share of the remaining ETH. Equals the full contribution when nothing
    ///      was paid out, which is the case when the funding goal was missed.
    function _refundAmount(uint256 campaignId, address backer) private view returns (uint256) {
        uint256 contributed = contributions[campaignId][backer];
        if (contributed == 0) return 0;
        Campaign storage c = campaigns[campaignId];
        return (contributed * (c.totalRaised - c.totalReleased)) / c.totalRaised;
    }

    function _sendEth(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

contract RentalDeposit {
    uint256 public constant INSPECTION_WINDOW = 7 days;
    uint256 public constant RESPONSE_WINDOW = 7 days;
    uint256 public constant ARBITRATION_WINDOW = 14 days;

    enum Status { Draft, Active, Proposed, Disputed, Settled, Cancelled }

    struct Property {
        address owner;
        string referenceCode;
        uint256 rent;
        uint256 deposit;
        uint256 currentAgreement;
    }

    struct Terms {
        address tenant;
        address arbitrator;
        uint64 startsAt;
        uint64 endsAt;
        uint64 periodSeconds;
        bytes32 documentHash;
    }

    struct Agreement {
        uint256 propertyId;
        address owner;
        Terms terms;
        uint256 rent;
        uint256 deposit;
        uint256 escrow;
        bool ownerConfirmed;
        bool tenantConfirmed;
        Status status;
        uint256 proposedRefund;
        uint256 deadline;
    }

    struct Payment {
        uint256 amount;
        uint256 paidAt;
    }

    uint256 public propertyCount;
    uint256 public agreementCount;
    mapping(uint256 => Property) public properties;
    mapping(uint256 => Agreement) private agreements;
    mapping(uint256 => mapping(uint256 => Payment)) public payments;
    mapping(address => uint256) public withdrawable;

    event PropertyRegistered(uint256 indexed propertyId, address indexed owner);
    event AgreementCreated(uint256 indexed agreementId, uint256 indexed propertyId, address indexed tenant);
    event AgreementConfirmed(uint256 indexed agreementId, address indexed party);
    event AgreementCancelled(uint256 indexed agreementId);
    event SecurityDeposited(uint256 indexed agreementId, uint256 amount);
    event RentPaid(uint256 indexed agreementId, uint256 indexed period, address indexed tenant, uint256 amount);
    event RefundProposed(uint256 indexed agreementId, uint256 refund, bytes32 inspectionHash, bytes32 deductionReasonHash);
    event DisputeOpened(uint256 indexed agreementId, bytes32 reasonHash);
    event DisputeResolved(uint256 indexed agreementId, uint256 refund, bytes32 decisionHash, bytes32 deductionReasonHash);
    event DepositSettled(uint256 indexed agreementId, address indexed authorizedBy, uint256 refund, uint256 deduction);
    event Withdrawal(address indexed beneficiary, address indexed recipient, uint256 amount);

    function registerProperty(string calldata referenceCode, uint256 rent, uint256 deposit)
        external returns (uint256 id)
    {
        require(bytes(referenceCode).length > 0 && rent > 0 && deposit > 0, "Invalid property");
        id = ++propertyCount;
        properties[id] = Property(msg.sender, referenceCode, rent, deposit, 0);
        emit PropertyRegistered(id, msg.sender);
    }

    function createAgreement(uint256 propertyId, Terms calldata terms) external returns (uint256 id) {
        Property storage property = properties[propertyId];
        require(msg.sender == property.owner, "Owner only");
        require(property.currentAgreement == 0, "Property reserved");
        require(terms.tenant != address(0) && terms.tenant != msg.sender, "Invalid tenant");
        require(
            terms.arbitrator != address(0) && terms.arbitrator != msg.sender &&
            terms.arbitrator != terms.tenant, "Invalid arbitrator"
        );
        require(terms.startsAt > block.timestamp && terms.endsAt > terms.startsAt, "Invalid dates");
        require(terms.periodSeconds > 0 && terms.documentHash != bytes32(0), "Invalid terms");
        require((terms.endsAt - terms.startsAt) % terms.periodSeconds == 0, "Incomplete period");

        id = ++agreementCount;
        Agreement storage agreement = agreements[id];
        agreement.propertyId = propertyId;
        agreement.owner = msg.sender;
        agreement.terms = terms;
        agreement.rent = property.rent;
        agreement.deposit = property.deposit;
        property.currentAgreement = id;
        emit AgreementCreated(id, propertyId, terms.tenant);
    }

    function getAgreement(uint256 id) external view returns (Agreement memory) {
        return _agreement(id);
    }

    function confirmAgreement(uint256 id) external {
        Agreement storage agreement = _agreement(id);
        require(agreement.status == Status.Draft && block.timestamp <= agreement.terms.startsAt, "Draft unavailable");
        if (msg.sender == agreement.owner) {
            require(!agreement.ownerConfirmed, "Already confirmed");
            agreement.ownerConfirmed = true;
        } else {
            require(msg.sender == agreement.terms.tenant, "Party only");
            require(!agreement.tenantConfirmed, "Already confirmed");
            agreement.tenantConfirmed = true;
        }
        emit AgreementConfirmed(id, msg.sender);
    }

    function cancelDraft(uint256 id) external {
        Agreement storage agreement = _agreement(id);
        require(agreement.status == Status.Draft, "Draft only");
        require(
            msg.sender == agreement.owner || msg.sender == agreement.terms.tenant ||
            block.timestamp > agreement.terms.startsAt, "Party only before expiry"
        );
        agreement.status = Status.Cancelled;
        properties[agreement.propertyId].currentAgreement = 0;
        emit AgreementCancelled(id);
    }

    function depositSecurity(uint256 id) external payable {
        Agreement storage agreement = _agreement(id);
        require(msg.sender == agreement.terms.tenant, "Tenant only");
        require(agreement.status == Status.Draft && block.timestamp <= agreement.terms.startsAt, "Draft unavailable");
        require(agreement.ownerConfirmed && agreement.tenantConfirmed, "Confirm first");
        require(msg.value == agreement.deposit, "Incorrect deposit");
        agreement.escrow = msg.value;
        agreement.status = Status.Active;
        emit SecurityDeposited(id, msg.value);
    }

    function payRent(uint256 id, uint256 period) external payable {
        Agreement storage agreement = _agreement(id);
        require(msg.sender == agreement.terms.tenant, "Tenant only");
        require(agreement.status == Status.Active, "Active only");
        uint256 endsAt = agreement.terms.endsAt;
        uint256 startsAt = agreement.terms.startsAt;
        uint256 length = agreement.terms.periodSeconds;
        require(block.timestamp >= startsAt && block.timestamp < endsAt, "Outside rental dates");
        require(period > 0 && period <= (endsAt - startsAt) / length, "Invalid period");
        require(block.timestamp >= startsAt + (period - 1) * length, "Period not started");
        require(payments[id][period].paidAt == 0 && msg.value == agreement.rent, "Duplicate or incorrect rent");
        payments[id][period] = Payment(msg.value, block.timestamp);
        withdrawable[agreement.owner] += msg.value;
        emit RentPaid(id, period, msg.sender, msg.value);
    }

    function proposeRefund(uint256 id, uint256 refund, bytes32 inspectionHash, bytes32 deductionReasonHash) external {
        Agreement storage agreement = _agreement(id);
        require(msg.sender == agreement.owner, "Owner only");
        require(agreement.status == Status.Active && block.timestamp >= agreement.terms.endsAt, "Await rental end");
        require(block.timestamp < agreement.terms.endsAt + INSPECTION_WINDOW, "Inspection expired");
        require(inspectionHash != bytes32(0), "Inspection required");
        _checkRefund(agreement, refund, deductionReasonHash);

        emit RefundProposed(id, refund, inspectionHash, deductionReasonHash);
        if (refund == agreement.escrow) {
            _settle(id, agreement, refund);
        } else {
            agreement.proposedRefund = refund;
            agreement.deadline = block.timestamp + RESPONSE_WINDOW;
            agreement.status = Status.Proposed;
        }
    }

    function acceptRefund(uint256 id) external {
        Agreement storage agreement = _agreement(id);
        require(msg.sender == agreement.terms.tenant, "Tenant only");
        require(agreement.status == Status.Proposed && block.timestamp < agreement.deadline, "Proposal unavailable");
        _settle(id, agreement, agreement.proposedRefund);
    }

    function openDispute(uint256 id, bytes32 reasonHash) external {
        Agreement storage agreement = _agreement(id);
        require(reasonHash != bytes32(0), "Reason required");
        require(agreement.status == Status.Proposed && block.timestamp < agreement.deadline, "Proposal unavailable");
        require(msg.sender == agreement.terms.tenant, "Tenant only");
        agreement.status = Status.Disputed;
        agreement.deadline = block.timestamp + ARBITRATION_WINDOW;
        emit DisputeOpened(id, reasonHash);
    }

    function resolveDispute(uint256 id, uint256 refund, bytes32 decisionHash, bytes32 deductionReasonHash) external {
        Agreement storage agreement = _agreement(id);
        require(msg.sender == agreement.terms.arbitrator, "Arbitrator only");
        require(agreement.status == Status.Disputed && block.timestamp < agreement.deadline, "Dispute unavailable");
        require(decisionHash != bytes32(0), "Decision required");
        _checkRefund(agreement, refund, deductionReasonHash);
        emit DisputeResolved(id, refund, decisionHash, deductionReasonHash);
        _settle(id, agreement, refund);
    }

    function refundAfterTimeout(uint256 id) external {
        Agreement storage agreement = _agreement(id);
        if (agreement.status == Status.Active) {
            require(block.timestamp >= agreement.terms.endsAt + INSPECTION_WINDOW, "Inspection pending");
        } else {
            require(agreement.status == Status.Proposed || agreement.status == Status.Disputed, "No pending refund");
            require(block.timestamp >= agreement.deadline, "Response pending");
        }
        _settle(id, agreement, agreement.escrow);
    }

    function withdraw(address payable recipient) external {
        require(recipient != address(0) && recipient != address(this), "Invalid recipient");
        uint256 amount = withdrawable[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        withdrawable[msg.sender] = 0;
        (bool paid,) = recipient.call{value: amount}("");
        require(paid, "Withdrawal failed");
        emit Withdrawal(msg.sender, recipient, amount);
    }

    function _agreement(uint256 id) private view returns (Agreement storage agreement) {
        agreement = agreements[id];
        require(agreement.owner != address(0), "Unknown agreement");
    }

    function _checkRefund(Agreement storage agreement, uint256 refund, bytes32 deductionReasonHash) private view {
        require(refund <= agreement.escrow, "Refund exceeds escrow");
        require(refund == agreement.escrow || deductionReasonHash != bytes32(0), "Deduction reason required");
    }

    function _settle(uint256 id, Agreement storage agreement, uint256 refund) private {
        uint256 deduction = agreement.escrow - refund;
        agreement.escrow = 0;
        agreement.status = Status.Settled;
        properties[agreement.propertyId].currentAgreement = 0;
        withdrawable[agreement.terms.tenant] += refund;
        withdrawable[agreement.owner] += deduction;
        emit DepositSettled(id, msg.sender, refund, deduction);
    }
}

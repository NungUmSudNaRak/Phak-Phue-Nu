// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title GreenFarm Traceability - ระบบตรวจสอบย้อนกลับสินค้าเกษตรปลอดภัย
/// @notice ครอบคลุม 6 ฟังก์ชันตามโจทย์ + กฎ "เปลี่ยนผู้ครอบครองต้องได้รับการยืนยัน"
contract GreenFarmTraceability {
    // ───────────── Types ─────────────
    enum Role { None, Farmer, Transporter, Distributor, Admin }
    enum Status { Harvested, InTransit, AtWarehouse, DeliveredToStore }
    enum RecallState { Active, Resolved }

    struct Stakeholder {
        string name;
        Role role;
        bool active;
    }

    struct Batch {
        string lotCode;
        string productName;
        uint64 harvestDate;      // Unix timestamp
        string origin;           // แหล่งผลิต
        string certification;    // ข้อมูลการรับรอง เช่น GAP / Organic
        address farmer;
        address custodian;       // ผู้ครอบครองปัจจุบัน
        Status status;
        bool exists;
    }

    struct TransferRecord {
        address from;
        address to;
        uint64 initiatedAt;
        uint64 confirmedAt;
        string note;
    }

    struct PendingTransfer {
        address to;
        uint64 initiatedAt;
        string note;
        bool exists;
    }

    struct StatusRecord {
        Status status;
        address by;
        uint64 at;
        string note;
    }

    struct RecallRecord {
        RecallState state;
        string reason;
        address by;
        uint64 at;
    }

    // ───────────── Storage ─────────────
    mapping(address => Stakeholder) public stakeholders;
    mapping(bytes32 => Batch) private batches;
    mapping(bytes32 => TransferRecord[]) private transferHistory;
    mapping(bytes32 => StatusRecord[]) private statusHistory;
    mapping(bytes32 => RecallRecord[]) private recallHistory;
    mapping(bytes32 => PendingTransfer) public pendingTransfers;

    // ───────────── Events ─────────────
    event StakeholderRegistered(address indexed account, Role role, string name);
    event StakeholderDeactivated(address indexed account);
    event BatchRegistered(string lotCode, address indexed farmer);
    event TransferInitiated(string lotCode, address indexed from, address indexed to);
    event TransferConfirmed(string lotCode, address indexed from, address indexed to);
    event TransferCancelled(string lotCode, address indexed by);
    event StatusUpdated(string lotCode, Status status, address indexed by);
    event RecallIssued(string lotCode, address indexed by, string reason);
    event RecallResolved(string lotCode, address indexed by, string note);

    // ───────────── Modifiers ─────────────
    modifier onlyRole(Role r) {
        require(stakeholders[msg.sender].active && stakeholders[msg.sender].role == r, "Not authorized");
        _;
    }

    modifier batchExists(string calldata lotCode) {
        require(batches[_key(lotCode)].exists, "Batch not found");
        _;
    }

    modifier notRecalled(string calldata lotCode) {
        require(!_hasActiveRecall(_key(lotCode)), "Batch under recall");
        _;
    }

    constructor() {
        stakeholders[msg.sender] = Stakeholder("System Admin", Role.Admin, true);
        emit StakeholderRegistered(msg.sender, Role.Admin, "System Admin");
    }

    // ───────────── 1. Register Stakeholders ─────────────
    function registerStakeholder(address account, string calldata name, Role role)
        external
        onlyRole(Role.Admin)
    {
        require(account != address(0), "Zero address");
        require(role != Role.None, "Invalid role");
        stakeholders[account] = Stakeholder(name, role, true);
        emit StakeholderRegistered(account, role, name);
    }

    function deactivateStakeholder(address account) external onlyRole(Role.Admin) {
        require(account != msg.sender, "Admin cannot deactivate self");
        stakeholders[account].active = false;
        emit StakeholderDeactivated(account);
    }

    // ───────────── 2. Register Product Batch ─────────────
    function registerBatch(
        string calldata lotCode,
        string calldata productName,
        uint64 harvestDate,
        string calldata origin,
        string calldata certification
    ) external onlyRole(Role.Farmer) {
        bytes32 k = _key(lotCode);
        require(bytes(lotCode).length > 0, "Empty lot code");
        require(!batches[k].exists, "Lot code already used");

        batches[k] = Batch({
            lotCode: lotCode,
            productName: productName,
            harvestDate: harvestDate,
            origin: origin,
            certification: certification,
            farmer: msg.sender,
            custodian: msg.sender,
            status: Status.Harvested,
            exists: true
        });
        statusHistory[k].push(StatusRecord(Status.Harvested, msg.sender, uint64(block.timestamp), "Registered"));
        emit BatchRegistered(lotCode, msg.sender);
    }

    // ───────────── 3. Transfer Custody (2-step confirmation) ─────────────
    /// @notice ผู้ครอบครองปัจจุบันเสนอส่งมอบ
    function initiateTransfer(string calldata lotCode, address to, string calldata note)
        external
        batchExists(lotCode)
        notRecalled(lotCode)
    {
        bytes32 k = _key(lotCode);
        require(batches[k].custodian == msg.sender, "Not current custodian");
        require(stakeholders[to].active, "Recipient not registered");
        require(stakeholders[to].role != Role.Admin, "Cannot transfer to admin");
        require(to != msg.sender, "Cannot transfer to self");
        require(!pendingTransfers[k].exists, "Transfer already pending");

        pendingTransfers[k] = PendingTransfer(to, uint64(block.timestamp), note, true);
        emit TransferInitiated(lotCode, msg.sender, to);
    }

    /// @notice ผู้รับยืนยันรับสินค้า -> สิทธิ์ครอบครองเปลี่ยนมือ
    function confirmTransfer(string calldata lotCode)
        external
        batchExists(lotCode)
        notRecalled(lotCode)
    {
        bytes32 k = _key(lotCode);
        PendingTransfer memory p = pendingTransfers[k];
        require(p.exists, "No pending transfer");
        require(p.to == msg.sender, "Only recipient can confirm");

        address from = batches[k].custodian;
        batches[k].custodian = msg.sender;
        transferHistory[k].push(
            TransferRecord(from, msg.sender, p.initiatedAt, uint64(block.timestamp), p.note)
        );
        delete pendingTransfers[k];
        emit TransferConfirmed(lotCode, from, msg.sender);
    }

    function cancelTransfer(string calldata lotCode) external batchExists(lotCode) {
        bytes32 k = _key(lotCode);
        require(pendingTransfers[k].exists, "No pending transfer");
        require(batches[k].custodian == msg.sender, "Not current custodian");
        delete pendingTransfers[k];
        emit TransferCancelled(lotCode, msg.sender);
    }

    // ───────────── 4. Update Product Status ─────────────
    /// @notice อัปเดตสถานะได้เฉพาะผู้ครอบครอง และต้องเดินหน้าเท่านั้น (ย้อนไม่ได้)
    function updateStatus(string calldata lotCode, Status newStatus, string calldata note)
        external
        batchExists(lotCode)
        notRecalled(lotCode)
    {
        bytes32 k = _key(lotCode);
        require(batches[k].custodian == msg.sender, "Not current custodian");
        require(uint8(newStatus) > uint8(batches[k].status), "Status must move forward");

        batches[k].status = newStatus;
        statusHistory[k].push(StatusRecord(newStatus, msg.sender, uint64(block.timestamp), note));
        emit StatusUpdated(lotCode, newStatus, msg.sender);
    }

    // ───────────── 5. Trace Product History (read-only, สำหรับ QR Code) ─────────────
    /// @dev QR Code เก็บ lotCode แล้วให้หน้าเว็บเรียกฟังก์ชัน view เหล่านี้
    function getBatch(string calldata lotCode)
        external
        view
        batchExists(lotCode)
        returns (Batch memory)
    {
        return batches[_key(lotCode)];
    }

    function getTransferHistory(string calldata lotCode) external view returns (TransferRecord[] memory) {
        return transferHistory[_key(lotCode)];
    }

    function getStatusHistory(string calldata lotCode) external view returns (StatusRecord[] memory) {
        return statusHistory[_key(lotCode)];
    }

    function getRecallHistory(string calldata lotCode) external view returns (RecallRecord[] memory) {
        return recallHistory[_key(lotCode)];
    }

    function isRecalled(string calldata lotCode) external view returns (bool) {
        return _hasActiveRecall(_key(lotCode));
    }

    // ───────────── 6. Product Recall ─────────────
    /// @notice Admin หรือเกษตรกรเจ้าของล็อตสามารถประกาศเรียกคืนได้
    function issueRecall(string calldata lotCode, string calldata reason)
        external
        batchExists(lotCode)
    {
        bytes32 k = _key(lotCode);
        bool isAdmin = stakeholders[msg.sender].active && stakeholders[msg.sender].role == Role.Admin;
        require(isAdmin || batches[k].farmer == msg.sender, "Not authorized to recall");
        require(bytes(reason).length > 0, "Reason required");
        require(!_hasActiveRecall(k), "Already recalled");

        recallHistory[k].push(RecallRecord(RecallState.Active, reason, msg.sender, uint64(block.timestamp)));
        emit RecallIssued(lotCode, msg.sender, reason);
    }

    function resolveRecall(string calldata lotCode, string calldata note)
        external
        onlyRole(Role.Admin)
        batchExists(lotCode)
    {
        bytes32 k = _key(lotCode);
        require(_hasActiveRecall(k), "No active recall");
        recallHistory[k].push(RecallRecord(RecallState.Resolved, note, msg.sender, uint64(block.timestamp)));
        emit RecallResolved(lotCode, msg.sender, note);
    }

    // ───────────── Internal ─────────────
    function _key(string memory lotCode) internal pure returns (bytes32) {
        return keccak256(bytes(lotCode));
    }

    function _hasActiveRecall(bytes32 k) internal view returns (bool) {
        uint256 n = recallHistory[k].length;
        return n > 0 && recallHistory[k][n - 1].state == RecallState.Active;
    }
}

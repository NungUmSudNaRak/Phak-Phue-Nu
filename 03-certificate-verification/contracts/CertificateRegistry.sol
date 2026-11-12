// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SkillTrust Academy - Digital Certificate Registry
/// @notice Issues, verifies and revokes training certificates.
/// @dev Personal data stays off-chain. Only salted hashes and the recipient's
///      wallet address are stored, because all contract data is public.
contract CertificateRegistry {
    enum Status {
        NotFound,
        Valid,
        Revoked
    }

    struct Course {
        string code;
        string name;
        string details;
        uint256 createdAt;
        bool exists;
    }

    struct Certificate {
        string certificateId;
        string courseCode;
        address recipient;
        bytes32 recipientDataHash; // hash of salted recipient data kept off-chain
        bytes32 documentHash; // hash of the certificate PDF
        address issuedBy;
        uint256 issuedAt;
        bool revoked;
        address revokedBy;
        uint256 revokedAt;
        bytes32 revocationReasonHash; // the reason itself may contain personal data
    }

    mapping(address => bool) public isAdmin;
    mapping(address => bool) public isIssuer;

    mapping(string => Course) private courses;
    mapping(string => Certificate) private certificates;
    mapping(address => string[]) private certificateIdsByRecipient;

    event AdminUpdated(address indexed account, bool allowed, address indexed updatedBy);
    event IssuerUpdated(address indexed account, bool allowed, address indexed updatedBy);
    event CourseCreated(string code, string name, address indexed createdBy);
    event CertificateIssued(
        string certificateId,
        string courseCode,
        address indexed recipient,
        bytes32 indexed documentHash,
        address indexed issuedBy
    );
    event CertificateRevoked(string certificateId, bytes32 reasonHash, address indexed revokedBy);

    error NotAdmin();
    error NotIssuer();
    error ZeroAddress();
    error EmptyValue();
    error CannotRemoveSelf();
    error CourseAlreadyExists(string code);
    error CourseNotFound(string code);
    error CertificateAlreadyExists(string certificateId);
    error CertificateNotFound(string certificateId);
    error CertificateAlreadyRevoked(string certificateId);

    modifier onlyAdmin() {
        if (!isAdmin[msg.sender]) revert NotAdmin();
        _;
    }

    modifier onlyIssuer() {
        if (!isIssuer[msg.sender]) revert NotIssuer();
        _;
    }

    /// @notice The deployer becomes the first admin and issuer.
    constructor() {
        isAdmin[msg.sender] = true;
        isIssuer[msg.sender] = true;
        emit AdminUpdated(msg.sender, true, msg.sender);
        emit IssuerUpdated(msg.sender, true, msg.sender);
    }

    /// @notice Grants or removes admin rights. Admins cannot remove themselves,
    ///         so the contract always keeps at least one admin.
    function setAdmin(address account, bool allowed) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        if (account == msg.sender && !allowed) revert CannotRemoveSelf();
        isAdmin[account] = allowed;
        emit AdminUpdated(account, allowed, msg.sender);
    }

    /// @notice Grants or removes the right to issue certificates.
    function setIssuer(address account, bool allowed) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        isIssuer[account] = allowed;
        emit IssuerUpdated(account, allowed, msg.sender);
    }

    /// @notice Requirement 1: registers a training course.
    function createCourse(
        string calldata code,
        string calldata name,
        string calldata details
    ) external onlyAdmin {
        if (bytes(code).length == 0 || bytes(name).length == 0) revert EmptyValue();
        if (courses[code].exists) revert CourseAlreadyExists(code);

        courses[code] = Course(code, name, details, block.timestamp, true);
        emit CourseCreated(code, name, msg.sender);
    }

    /// @notice Requirements 2 and 3: issues a certificate and records its hash.
    /// @param certificateId Unique reference code, also usable as QR code content.
    /// @param recipientDataHash Hash of the salted recipient data held off-chain.
    /// @param documentHash Hash of the certificate document.
    function issueCertificate(
        string calldata certificateId,
        string calldata courseCode,
        address recipient,
        bytes32 recipientDataHash,
        bytes32 documentHash
    ) external onlyIssuer {
        if (bytes(certificateId).length == 0) revert EmptyValue();
        if (recipientDataHash == bytes32(0) || documentHash == bytes32(0)) revert EmptyValue();
        if (recipient == address(0)) revert ZeroAddress();
        if (!courses[courseCode].exists) revert CourseNotFound(courseCode);
        if (certificates[certificateId].issuedAt != 0) {
            revert CertificateAlreadyExists(certificateId);
        }

        Certificate storage cert = certificates[certificateId];
        cert.certificateId = certificateId;
        cert.courseCode = courseCode;
        cert.recipient = recipient;
        cert.recipientDataHash = recipientDataHash;
        cert.documentHash = documentHash;
        cert.issuedBy = msg.sender;
        cert.issuedAt = block.timestamp;

        certificateIdsByRecipient[recipient].push(certificateId);
        emit CertificateIssued(certificateId, courseCode, recipient, documentHash, msg.sender);
    }

    /// @notice Requirement 5: revokes a certificate while keeping its issue history.
    /// @param reasonHash Hash of the reason held off-chain.
    function revokeCertificate(string calldata certificateId, bytes32 reasonHash) external onlyAdmin {
        Certificate storage cert = certificates[certificateId];
        if (cert.issuedAt == 0) revert CertificateNotFound(certificateId);
        if (cert.revoked) revert CertificateAlreadyRevoked(certificateId);

        cert.revoked = true;
        cert.revokedBy = msg.sender;
        cert.revokedAt = block.timestamp;
        cert.revocationReasonHash = reasonHash;
        emit CertificateRevoked(certificateId, reasonHash, msg.sender);
    }

    /// @notice Requirement 4: looks up a certificate's status by ID or QR code content.
    function verifyCertificate(string calldata certificateId)
        external
        view
        returns (Status status, Certificate memory certificate)
    {
        certificate = certificates[certificateId];
        status = _statusOf(certificate);
    }

    /// @notice Requirement 4: checks a document against the recorded hash.
    /// @return isValid True only if the document matches and the certificate is not revoked.
    function verifyDocument(string calldata certificateId, bytes32 documentHash)
        external
        view
        returns (bool isValid, Status status)
    {
        Certificate storage cert = certificates[certificateId];
        status = _statusOf(cert);
        isValid = status == Status.Valid && cert.documentHash == documentHash;
    }

    /// @notice Requirement 6: lists certificates, including revoked ones, for a wallet.
    function getCertificatesByRecipient(address recipient)
        external
        view
        returns (Certificate[] memory result)
    {
        string[] storage ids = certificateIdsByRecipient[recipient];
        result = new Certificate[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            result[i] = certificates[ids[i]];
        }
    }

    /// @notice Returns a course. Check `exists` to tell whether it was found.
    function getCourse(string calldata code) external view returns (Course memory) {
        return courses[code];
    }

    function _statusOf(Certificate memory cert) private pure returns (Status) {
        if (cert.issuedAt == 0) return Status.NotFound;
        return cert.revoked ? Status.Revoked : Status.Valid;
    }
}

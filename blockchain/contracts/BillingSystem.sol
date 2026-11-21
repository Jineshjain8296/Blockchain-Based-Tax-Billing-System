// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract TaxBillingSystem {

    // =========================
    // ROLES
    // =========================

    enum Role {
        None,
        Admin,
        TaxOfficer,
        Auditor
    }

    // Address => Role
    mapping(address => Role) public roles;

    // =========================
    // TAX RECORD
    // =========================

    struct TaxRecord {
        uint256 id;
        string taxpayerName;
        string panNumber;
        string productName;
        uint256 productAmount;
        uint256 taxAmount;
        string state;
        uint256 timestamp;
    }

    uint256 public recordCount;

    mapping(uint256 => TaxRecord) public records;


    // =========================
    // EVENTS
    // =========================

    event RoleAssigned(
        address indexed user,
        Role role
    );

    event TaxRecordCreated(
        uint256 indexed id,
        address indexed officer,
        string taxpayerName,
        uint256 taxAmount
    );


    // =========================
    // CONSTRUCTOR
    // =========================

    constructor() {

        // Person deploying the contract becomes Admin
        roles[msg.sender] = Role.Admin;

        emit RoleAssigned(
            msg.sender,
            Role.Admin
        );
    }


    // =========================
    // MODIFIERS
    // =========================

    modifier onlyAdmin() {

        require(
            roles[msg.sender] == Role.Admin,
            "Only Admin can perform this action"
        );

        _;
    }


    modifier onlyTaxOfficer() {

        require(
            roles[msg.sender] == Role.TaxOfficer,
            "Only Tax Officer can create tax records"
        );

        _;
    }


    modifier onlyAuditor() {

        require(
            roles[msg.sender] == Role.Auditor,
            "Only Auditor can perform this action"
        );

        _;
    }


    // =========================
    // ROLE MANAGEMENT
    // =========================

    function assignTaxOfficer(
        address _user
    ) public onlyAdmin {

        require(
            _user != address(0),
            "Invalid address"
        );

        roles[_user] = Role.TaxOfficer;

        emit RoleAssigned(
            _user,
            Role.TaxOfficer
        );
    }


    function assignAuditor(
        address _user
    ) public onlyAdmin {

        require(
            _user != address(0),
            "Invalid address"
        );

        roles[_user] = Role.Auditor;

        emit RoleAssigned(
            _user,
            Role.Auditor
        );
    }


    function removeRole(
        address _user
    ) public onlyAdmin {

        require(
            _user != msg.sender,
            "Admin cannot remove own role"
        );

        roles[_user] = Role.None;

        emit RoleAssigned(
            _user,
            Role.None
        );
    }


    // =========================
    // CHECK USER ROLE
    // =========================

    function getRole(
        address _user
    ) public view returns (Role) {

        return roles[_user];
    }


    // =========================
    // CREATE TAX RECORD
    // =========================

    function createTaxRecord(
        string memory _taxpayerName,
        string memory _panNumber,
        string memory _productName,
        uint256 _productAmount,
        uint256 _taxAmount,
        string memory _state
    ) public onlyTaxOfficer {

        recordCount++;

        records[recordCount] = TaxRecord(
            recordCount,
            _taxpayerName,
            _panNumber,
            _productName,
            _productAmount,
            _taxAmount,
            _state,
            block.timestamp
        );

        emit TaxRecordCreated(
            recordCount,
            msg.sender,
            _taxpayerName,
            _taxAmount
        );
    }


    // =========================
    // GET TAX RECORD
    // =========================

    function getTaxRecord(
        uint256 _id
    ) public view returns (
        uint256,
        string memory,
        string memory,
        string memory,
        uint256,
        uint256,
        string memory,
        uint256
    ) {

        TaxRecord memory r = records[_id];

        return (
            r.id,
            r.taxpayerName,
            r.panNumber,
            r.productName,
            r.productAmount,
            r.taxAmount,
            r.state,
            r.timestamp
        );
    }


    // =========================
    // GET RECORD COUNT
    // =========================

    function getRecordCount()
        public
        view
        returns (uint256)
    {

        return recordCount;
    }


    // =========================
    // AUDITOR VERIFICATION
    // =========================

    function verifyTaxRecord(
        uint256 _id
    )
        public
        view
        onlyAuditor
        returns (
            bool exists,
            string memory taxpayerName,
            uint256 taxAmount,
            uint256 timestamp
        )
    {

        TaxRecord memory r = records[_id];

        if(r.id == 0) {

            return (
                false,
                "",
                0,
                0
            );

        }

        return (
            true,
            r.taxpayerName,
            r.taxAmount,
            r.timestamp
        );
    }


    // =====================================================================
    // MULTI-SOURCE INCOME LEDGER  (salary + professional fees + TDS/GST/advance)
    // =====================================================================
    // All money values are in PAISE (1 rupee = 100 paise) so nothing is lost
    // to rounding. PANs are never stored in plaintext here: callers pass a
    // salted keccak256 hash (computed by the backend). Records are
    // append-only; a mistake is corrected by VOIDING (or superseding) an
    // entry with a reason, so the full history stays on-chain.

    enum IncomeType { Salary, ProfessionalFees, Other }
    enum TaxType { TDS, GST, AdvanceTax }

    struct IncomeEntry {
        uint256 id;
        bytes32 panHash;
        string financialYear;      // e.g. "2025-26"
        IncomeType incomeType;
        string payerName;          // deductor, e.g. college / university
        string payerTAN;
        uint256 grossAmountPaise;
        uint256 timestamp;
        address filedBy;
        bool voided;
        uint256 supersededBy;      // 0 if not superseded
        string voidReason;
    }

    struct TaxPayment {
        uint256 id;
        bytes32 panHash;
        string financialYear;
        TaxType taxType;
        uint256 relatedIncomeId;   // mandatory for TDS; optional for GST / AdvanceTax
        uint256 amountPaise;
        uint256 timestamp;
        address filedBy;
        bool voided;
        string voidReason;
    }

    uint256 public incomeCount;
    uint256 public paymentCount;

    mapping(uint256 => IncomeEntry) private incomeEntries;
    mapping(uint256 => TaxPayment) private taxPayments;
    mapping(bytes32 => uint256[]) private incomeIdsByPan;
    mapping(bytes32 => uint256[]) private paymentIdsByPan;

    event IncomeEntryFiled(
        uint256 indexed id,
        bytes32 indexed panHash,
        string financialYear,
        IncomeType incomeType,
        address indexed officer,
        uint256 grossAmountPaise
    );

    event TaxPaymentFiled(
        uint256 indexed id,
        bytes32 indexed panHash,
        string financialYear,
        TaxType taxType,
        uint256 relatedIncomeId,
        address indexed officer,
        uint256 amountPaise
    );

    event IncomeEntryVoided(
        uint256 indexed id,
        address indexed by,
        string reason,
        uint256 supersededBy
    );

    event TaxPaymentVoided(
        uint256 indexed id,
        address indexed by,
        string reason
    );

    // ---------- filing ----------

    function addIncomeEntry(
        bytes32 _panHash,
        string memory _financialYear,
        IncomeType _incomeType,
        string memory _payerName,
        string memory _payerTAN,
        uint256 _grossAmountPaise
    ) public onlyTaxOfficer returns (uint256) {
        return _addIncome(
            _panHash, _financialYear, _incomeType,
            _payerName, _payerTAN, _grossAmountPaise
        );
    }

    function _addIncome(
        bytes32 _panHash,
        string memory _financialYear,
        IncomeType _incomeType,
        string memory _payerName,
        string memory _payerTAN,
        uint256 _grossAmountPaise
    ) internal returns (uint256) {

        require(_panHash != bytes32(0), "PAN hash required");
        require(bytes(_financialYear).length > 0, "Financial year required");
        require(_grossAmountPaise > 0, "Amount must be > 0");

        incomeCount++;
        uint256 id = incomeCount;

        IncomeEntry storage e = incomeEntries[id];
        e.id = id;
        e.panHash = _panHash;
        e.financialYear = _financialYear;
        e.incomeType = _incomeType;
        e.payerName = _payerName;
        e.payerTAN = _payerTAN;
        e.grossAmountPaise = _grossAmountPaise;
        e.timestamp = block.timestamp;
        e.filedBy = msg.sender;

        incomeIdsByPan[_panHash].push(id);

        emit IncomeEntryFiled(
            id, _panHash, _financialYear, _incomeType,
            msg.sender, _grossAmountPaise
        );

        return id;
    }

    function addTaxPayment(
        bytes32 _panHash,
        string memory _financialYear,
        TaxType _taxType,
        uint256 _relatedIncomeId,
        uint256 _amountPaise
    ) public onlyTaxOfficer returns (uint256) {

        require(_panHash != bytes32(0), "PAN hash required");
        require(bytes(_financialYear).length > 0, "Financial year required");
        require(_amountPaise > 0, "Amount must be > 0");

        if (_taxType == TaxType.TDS) {
            require(_relatedIncomeId != 0, "TDS must reference an income entry");
        }

        if (_relatedIncomeId != 0) {
            require(_relatedIncomeId <= incomeCount, "Income entry not found");
            IncomeEntry storage inc = incomeEntries[_relatedIncomeId];
            require(!inc.voided, "Related income entry is voided");
            require(inc.panHash == _panHash, "Related income belongs to a different PAN");
            require(
                keccak256(bytes(inc.financialYear)) == keccak256(bytes(_financialYear)),
                "Related income is for a different financial year"
            );
        }

        paymentCount++;
        uint256 id = paymentCount;

        TaxPayment storage p = taxPayments[id];
        p.id = id;
        p.panHash = _panHash;
        p.financialYear = _financialYear;
        p.taxType = _taxType;
        p.relatedIncomeId = _relatedIncomeId;
        p.amountPaise = _amountPaise;
        p.timestamp = block.timestamp;
        p.filedBy = msg.sender;

        paymentIdsByPan[_panHash].push(id);

        emit TaxPaymentFiled(
            id, _panHash, _financialYear, _taxType,
            _relatedIncomeId, msg.sender, _amountPaise
        );

        return id;
    }

    // ---------- corrections (void / supersede — never delete) ----------

    // The officer who filed an entry, or the Admin, may void it.
    function _requireCanModify(address _filedBy) internal view {
        Role r = roles[msg.sender];
        require(
            r == Role.Admin || (r == Role.TaxOfficer && _filedBy == msg.sender),
            "Only the filing officer or Admin can void this entry"
        );
    }

    function voidIncomeEntry(
        uint256 _id,
        string memory _reason
    ) public {
        _voidIncome(_id, _reason, 0);
    }

    function _voidIncome(
        uint256 _id,
        string memory _reason,
        uint256 _supersededBy
    ) internal {
        require(_id != 0 && _id <= incomeCount, "Income entry not found");
        require(bytes(_reason).length > 0, "Reason required");

        IncomeEntry storage e = incomeEntries[_id];
        require(!e.voided, "Already voided");
        _requireCanModify(e.filedBy);

        e.voided = true;
        e.voidReason = _reason;
        e.supersededBy = _supersededBy;

        emit IncomeEntryVoided(_id, msg.sender, _reason, _supersededBy);
    }

    // Replace a wrong income entry with a corrected one in a single tx.
    // The old entry stays on-chain, marked voided and linked to the new id.
    // Only the officer who filed it (or Admin) may do this; the new entry is
    // filed under the caller, so it requires the TaxOfficer role.
    function supersedeIncomeEntry(
        uint256 _oldId,
        bytes32 _panHash,
        string memory _financialYear,
        IncomeType _incomeType,
        string memory _payerName,
        string memory _payerTAN,
        uint256 _grossAmountPaise,
        string memory _reason
    ) public onlyTaxOfficer returns (uint256) {

        require(_oldId != 0 && _oldId <= incomeCount, "Income entry not found");

        uint256 newId = _addIncome(
            _panHash, _financialYear, _incomeType,
            _payerName, _payerTAN, _grossAmountPaise
        );

        _voidIncome(_oldId, _reason, newId);

        return newId;
    }

    function voidTaxPayment(
        uint256 _id,
        string memory _reason
    ) public {
        require(_id != 0 && _id <= paymentCount, "Payment not found");
        require(bytes(_reason).length > 0, "Reason required");

        TaxPayment storage p = taxPayments[_id];
        require(!p.voided, "Already voided");
        _requireCanModify(p.filedBy);

        p.voided = true;
        p.voidReason = _reason;

        emit TaxPaymentVoided(_id, msg.sender, _reason);
    }

    // ---------- reads ----------

    function getIncomeEntry(
        uint256 _id
    ) public view returns (IncomeEntry memory) {
        require(_id != 0 && _id <= incomeCount, "Income entry not found");
        return incomeEntries[_id];
    }

    function getTaxPayment(
        uint256 _id
    ) public view returns (TaxPayment memory) {
        require(_id != 0 && _id <= paymentCount, "Payment not found");
        return taxPayments[_id];
    }

    function getIncomeIdsByPan(
        bytes32 _panHash
    ) public view returns (uint256[] memory) {
        return incomeIdsByPan[_panHash];
    }

    function getPaymentIdsByPan(
        bytes32 _panHash
    ) public view returns (uint256[] memory) {
        return paymentIdsByPan[_panHash];
    }
}

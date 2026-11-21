require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { buildSummary, INCOME_TYPES, TAX_TYPES } = require("./taxEngine");

const {
    getContract,
    getAuditorContract,
    getAdminContract,
    provider
} = require("./blockchain");

const app = express();

// -------------------------------------------------------------------
// Transaction hashes are rebuilt from on-chain EVENTS, so they survive a
// backend restart (previously they lived only in memory and were lost).
// -------------------------------------------------------------------
const txHashes = { legacy: {}, income: {}, payment: {} };
let lastHashBlock = -1;

async function syncTxHashes() {
    const contract = await getAdminContract();
    const latest = await provider.getBlockNumber();
    if (latest <= lastHashBlock) return;

    const from = lastHashBlock + 1;

    const legacy = await contract.queryFilter(contract.filters.TaxRecordCreated(), from, latest);
    for (const log of legacy) txHashes.legacy[Number(log.args.id)] = log.transactionHash;

    const income = await contract.queryFilter(contract.filters.IncomeEntryFiled(), from, latest);
    for (const log of income) txHashes.income[Number(log.args.id)] = log.transactionHash;

    const payments = await contract.queryFilter(contract.filters.TaxPaymentFiled(), from, latest);
    for (const log of payments) txHashes.payment[Number(log.args.id)] = log.transactionHash;

    lastHashBlock = latest;
}

// Never let a hash-sync problem break a normal request.
async function safeSyncTxHashes() {
    try { await syncTxHashes(); } catch (e) { console.warn("Tx hash sync skipped:", e.message); }
}

// -------------------------------------------------------------------
// PAN privacy: only a SALTED HASH of the PAN goes on-chain (chain data is
// public). Keep PAN_SALT secret and do not change it after data exists,
// or old records can no longer be found by PAN.
// -------------------------------------------------------------------
if (!process.env.PAN_SALT) {
    console.warn("WARNING: PAN_SALT is not set in .env - using an insecure development default.");
}
const PAN_SALT = process.env.PAN_SALT || "dev-only-change-me";

function hashPan(pan) {
    return ethers.keccak256(ethers.toUtf8Bytes(`${PAN_SALT}:${pan}`));
}

// Human-readable labels for the on-chain Role enum
// (0=None, 1=Admin, 2=TaxOfficer, 3=Auditor)
const ROLE_LABELS = ["None", "Admin", "TaxOfficer", "Auditor"];

app.use(cors());
app.use(express.json());


// ===============================
// AUTH — password-per-role login
// ===============================
// Simple, dependency-free session auth suitable for a demo/college
// project. Passwords live in .env (never commit real passwords).
// Sessions are kept in memory, so they reset if the backend restarts.

const ROLE_PASSWORDS = {
    admin: process.env.ADMIN_PASSWORD || "admin123",
    officer: process.env.OFFICER_PASSWORD || "officer123",
    auditor: process.env.AUDITOR_PASSWORD || "auditor123"
};

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const sessions = new Map(); // token -> { role, expiresAt }

function createSession(role) {
    const token = crypto.randomBytes(24).toString("hex");
    sessions.set(token, {
        role,
        expiresAt: Date.now() + SESSION_TTL_MS
    });
    return token;
}

function getSession(token) {
    const session = sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
        sessions.delete(token);
        return null;
    }
    return session;
}

// Middleware factory: requireRole('admin') or requireRole('admin','officer')
function requireRole(...allowedRoles) {
    return (req, res, next) => {

        const header = req.headers.authorization || "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : null;

        const session = token ? getSession(token) : null;

        if (!session) {
            return res.status(401).json({
                success: false,
                message: "Not logged in, or session expired. Please log in again."
            });
        }

        if (!allowedRoles.includes(session.role)) {
            return res.status(403).json({
                success: false,
                message: `This action requires role: ${allowedRoles.join(" or ")}`
            });
        }

        req.role = session.role;
        next();
    };
}

app.post("/login", (req, res) => {

    const { role, password } = req.body;

    if (!role || !ROLE_PASSWORDS[role]) {
        return res.status(400).json({
            success: false,
            message: "Unknown role"
        });
    }

    if (password !== ROLE_PASSWORDS[role]) {
        return res.status(401).json({
            success: false,
            message: "Incorrect password"
        });
    }

    const token = createSession(role);

    res.json({
        success: true,
        role,
        token
    });

});

app.post("/logout", (req, res) => {

    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (token) sessions.delete(token);

    res.json({ success: true });

});


// ===============================
// HOME
// ===============================

app.get("/", (req, res) => {
    res.send("Blockchain Backend Running");
});


// ===============================
// DEMO ACCOUNTS (Admin / Tax Officer / Auditor)
// ===============================
// This project uses 3 fixed Hardhat accounts to represent the 3 roles,
// since there is no wallet-connect flow in the frontend. Account #0 is
// always Admin (the deployer), #1 is Tax Officer, #2 is Auditor.

app.get("/accounts", requireRole("admin"), async (req, res) => {

    try {

        const admin = await (await provider.getSigner(0)).getAddress();
        const officer = await (await provider.getSigner(1)).getAddress();
        const auditor = await (await provider.getSigner(2)).getAddress();

        res.json({
            success: true,
            accounts: {
                admin,
                officer,
                auditor
            }
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: err.message
        });

    }

});


// ===============================
// ROLES — LIST CURRENT ASSIGNMENTS
// ===============================

app.get("/roles", requireRole("admin"), async (req, res) => {

    try {

        const contract = await getAdminContract();

        const admin = await (await provider.getSigner(0)).getAddress();
        const officer = await (await provider.getSigner(1)).getAddress();
        const auditor = await (await provider.getSigner(2)).getAddress();

        const addresses = { admin, officer, auditor };
        const roles = {};

        for (const [label, address] of Object.entries(addresses)) {
            const roleIndex = await contract.getRole(address);
            roles[label] = {
                address,
                role: ROLE_LABELS[Number(roleIndex)]
            };
        }

        res.json({
            success: true,
            roles
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: err.message
        });

    }

});


// ===============================
// ROLES — ASSIGN / REMOVE (Admin only)
// ===============================
// These calls are made with the Admin signer (account #0). The contract's
// onlyAdmin modifier is the real enforcement — if this were ever called
// with a non-admin signer, the transaction would revert on-chain.

app.post("/assign-tax-officer", requireRole("admin"), async (req, res) => {

    try {

        const { address } = req.body;

        if (!address) {
            return res.status(400).json({
                success: false,
                message: "address is required"
            });
        }

        const contract = await getAdminContract();

        const tx = await contract.assignTaxOfficer(address);
        await tx.wait();

        res.json({
            success: true,
            message: `Tax Officer role assigned to ${address}`,
            transactionHash: tx.hash
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: err.reason || err.message
        });

    }

});

app.post("/assign-auditor", requireRole("admin"), async (req, res) => {

    try {

        const { address } = req.body;

        if (!address) {
            return res.status(400).json({
                success: false,
                message: "address is required"
            });
        }

        const contract = await getAdminContract();

        const tx = await contract.assignAuditor(address);
        await tx.wait();

        res.json({
            success: true,
            message: `Auditor role assigned to ${address}`,
            transactionHash: tx.hash
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: err.reason || err.message
        });

    }

});

app.post("/remove-role", requireRole("admin"), async (req, res) => {

    try {

        const { address } = req.body;

        if (!address) {
            return res.status(400).json({
                success: false,
                message: "address is required"
            });
        }

        const contract = await getAdminContract();

        const tx = await contract.removeRole(address);
        await tx.wait();

        res.json({
            success: true,
            message: `Role removed from ${address}`,
            transactionHash: tx.hash
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: err.reason || err.message
        });

    }

});


// ===============================
// CREATE TAX RECORD
// ===============================

app.post("/create-tax", requireRole("admin", "officer"), async (req, res) => {

    try {

        const {
            taxpayerName,
            panNumber,
            productName,
            productAmount,
            taxAmount,
            state
        } = req.body;

        // uint256 on the contract can't hold decimals — round to the
        // nearest rupee here too, so a decimal value from any client
        // (not just the bundled frontend) can't cause an ethers
        // "underflow" error on the contract call below.
        const roundedProductAmount = Math.round(Number(productAmount));
        const roundedTaxAmount = Math.round(Number(taxAmount));

        if (!taxpayerName || !panNumber || !state) {
            return res.status(400).json({
                success: false,
                message: "taxpayerName, panNumber, and state are required"
            });
        }

        if (!Number.isFinite(roundedTaxAmount) || roundedTaxAmount <= 0) {
            return res.status(400).json({
                success: false,
                message: "taxAmount must be a positive number"
            });
        }

        const contract = await getContract();

        const tx = await contract.createTaxRecord(
            taxpayerName,
            panNumber,
            productName,
            roundedProductAmount,
            roundedTaxAmount,
            state
        );

        const receipt = await tx.wait();

        // The new record gets the latest recordCount
        const recordId = await contract.recordCount();

        // Remember the hash right away (also rebuilt from events on restart)
        txHashes.legacy[Number(recordId)] = tx.hash;

        res.json({
        success: true,
        recordId: Number(recordId),
        transactionHash: tx.hash
    });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: err.message
        });

    }

});




// ===============================
// GET ALL TAX RECORDS
// ===============================

app.get("/records", requireRole("admin", "officer", "auditor"), async (req, res) => {

    try {

        const contract = await getContract();

        await safeSyncTxHashes();

        const count = await contract.getRecordCount();

        const records = [];

        for (let i = 1; i <= Number(count); i++) {

            const record = await contract.getTaxRecord(i);

            records.push({
            id: Number(record[0]),
            taxpayerName: record[1],
            panNumber: record[2],
            productName: record[3],
            productAmount: Number(record[4]),
            taxAmount: Number(record[5]),
            state: record[6],
            timestamp: Number(record[7]),

            transactionHash:
            txHashes.legacy[Number(record[0])] || null
            });

        }

        res.json({
            success: true,
            count: records.length,
            records: records
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: err.message
        });

    }

});


app.get("/verify/:id", requireRole("admin", "officer", "auditor"), async (req, res) => {

    try {

        const id = Number(req.params.id);

        if (!id || id <= 0) {
            return res.status(400).json({
                success: false,
                verified: false,
                message: "Invalid record ID"
            });
        }

        const contract = await getAuditorContract();

        const record = await contract.getTaxRecord(id);

        if (Number(record[0]) === 0) {
            return res.json({
                success: false,
                verified: false,
                message: "Tax record not found"
            });
        }

        res.json({
            success: true,
            verified: true,

            record: {
                id: Number(record[0]),
                taxpayerName: record[1],
                panNumber: record[2],
                productName: record[3],
                productAmount: Number(record[4]),
                taxAmount: Number(record[5]),
                state: record[6],
                timestamp: Number(record[7])
            }
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            verified: false,
            message: err.message
        });

    }

});

// ===============================
// GET SINGLE TAX RECORD
// ===============================

app.get("/record/:id", requireRole("admin", "officer", "auditor"), async (req, res) => {

    try {

        const id = Number(req.params.id);

        const contract = await getContract();

        const record = await contract.getTaxRecord(id);

        res.json({
            success: true,
            record: {
                id: Number(record[0]),
                taxpayerName: record[1],
                panNumber: record[2],
                productName: record[3],
                productAmount: Number(record[4]),
                taxAmount: Number(record[5]),
                state: record[6],
                timestamp: Number(record[7])
            }
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: err.message
        });

    }

});


// ===============================
// DASHBOARD DATA
// ===============================

app.get("/dashboard", requireRole("admin", "officer", "auditor"), async (req, res) => {

    try {

        const contract = await getContract();

        const count = await contract.getRecordCount();

        let totalRevenue = 0;
        const taxpayers = new Set();

        for (let i = 1; i <= Number(count); i++) {

            const record = await contract.getTaxRecord(i);

            const pan = record[2];
            const taxAmount = Number(record[5]);

            totalRevenue += taxAmount;

            taxpayers.add(pan);
        }

        // Income ledger totals, kept SEPARATE by kind so TDS, GST and advance
        // tax are never added together as if they were one "revenue" figure.
        const ledger = {
            incomeEntries: 0,
            taxPayments: 0,
            grossIncomePaise: 0,
            tdsPaise: 0,
            gstPaise: 0,
            advanceTaxPaise: 0
        };

        const incomeCount = Number(await contract.incomeCount());
        for (let i = 1; i <= incomeCount; i++) {
            const e = await contract.getIncomeEntry(i);
            if (e.voided) continue;
            ledger.incomeEntries++;
            ledger.grossIncomePaise += Number(e.grossAmountPaise);
        }

        const paymentCount = Number(await contract.paymentCount());
        for (let i = 1; i <= paymentCount; i++) {
            const p = await contract.getTaxPayment(i);
            if (p.voided) continue;
            ledger.taxPayments++;
            const type = TAX_TYPES[Number(p.taxType)];
            if (type === "TDS") ledger.tdsPaise += Number(p.amountPaise);
            else if (type === "GST") ledger.gstPaise += Number(p.amountPaise);
            else ledger.advanceTaxPaise += Number(p.amountPaise);
        }

        res.json({
            success: true,
            totalRevenue: totalRevenue,
            totalRevenueNote: "Legacy flat records only. See 'ledger' for TDS / GST / advance tax shown separately.",
            taxpayers: taxpayers.size,
            blocks: Number(count),
            chainIntegrity: 100,
            ledger
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: err.message
        });

    }

});



// ===============================
// MULTI-SOURCE INCOME LEDGER
// ===============================
// Deductors (college, university...) file income entries and tax payments
// through the Tax Officer account. Corrections are made by VOIDING or
// SUPERSEDING an entry with a reason - nothing is ever deleted on-chain.

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;

function badRequest(res, message) {
    return res.status(400).json({ success: false, message });
}

// "150000", "1500.50" -> paise (integer). Rejects negatives / >2 decimals.
function rupeesToPaise(value) {
    const str = String(value ?? "").trim();
    if (!/^\d+(\.\d{1,2})?$/.test(str)) return null;
    const paise = Math.round(Number(str) * 100);
    return paise > 0 ? paise : null;
}

function validFinancialYear(fy) {
    const m = /^(20\d\d)-(\d\d)$/.exec(String(fy || ""));
    if (!m) return false;
    return (Number(m[1]) + 1) % 100 === Number(m[2]);
}

function parseIncomeBody(body) {
    const pan = String(body.pan || "").trim().toUpperCase();
    const payerTAN = String(body.payerTAN || "").trim().toUpperCase();
    const incomeTypeIndex = INCOME_TYPES.indexOf(body.incomeType);
    const grossPaise = rupeesToPaise(body.grossAmount);
    const payerName = String(body.payerName || "").trim();

    if (!PAN_RE.test(pan)) return { error: "Invalid PAN (expected format ABCDE1234F)" };
    if (!validFinancialYear(body.financialYear)) return { error: "financialYear must look like 2025-26" };
    if (incomeTypeIndex < 0) return { error: `incomeType must be one of: ${INCOME_TYPES.join(", ")}` };
    if (!payerName) return { error: "payerName is required" };
    if (payerTAN && !TAN_RE.test(payerTAN)) return { error: "Invalid payer TAN (expected format ABCD12345E)" };
    if (grossPaise === null) return { error: "grossAmount must be a positive number (max 2 decimals)" };

    return {
        args: [hashPan(pan), body.financialYear, incomeTypeIndex, payerName, payerTAN, grossPaise]
    };
}

function toIncomeEntry(e) {
    return {
        id: Number(e.id),
        financialYear: e.financialYear,
        incomeType: INCOME_TYPES[Number(e.incomeType)],
        payerName: e.payerName,
        payerTAN: e.payerTAN,
        grossPaise: Number(e.grossAmountPaise),
        timestamp: Number(e.timestamp),
        voided: e.voided,
        supersededBy: Number(e.supersededBy),
        voidReason: e.voidReason,
        transactionHash: txHashes.income[Number(e.id)] || null
    };
}

function toTaxPayment(p) {
    return {
        id: Number(p.id),
        financialYear: p.financialYear,
        taxType: TAX_TYPES[Number(p.taxType)],
        relatedIncomeId: Number(p.relatedIncomeId),
        amountPaise: Number(p.amountPaise),
        timestamp: Number(p.timestamp),
        voided: p.voided,
        voidReason: p.voidReason,
        transactionHash: txHashes.payment[Number(p.id)] || null
    };
}

// Admin voids with the Admin signer, an officer with the Officer signer -
// the contract itself decides whether that account is allowed to void.
async function contractForVoid(role) {
    return role === "admin" ? getAdminContract() : getContract();
}

function sendChainError(res, err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.reason || err.shortMessage || err.message });
}

app.post("/income-entry", requireRole("admin", "officer"), async (req, res) => {
    try {
        const { args, error } = parseIncomeBody(req.body);
        if (error) return badRequest(res, error);

        const contract = await getContract();
        const tx = await contract.addIncomeEntry(...args);
        await tx.wait();

        const id = Number(await contract.incomeCount());
        txHashes.income[id] = tx.hash;

        res.json({ success: true, incomeEntryId: id, transactionHash: tx.hash });
    } catch (err) { sendChainError(res, err); }
});

app.post("/income-entry/:id/supersede", requireRole("admin", "officer"), async (req, res) => {
    try {
        const oldId = Number(req.params.id);
        const reason = String(req.body.reason || "").trim();
        if (!oldId) return badRequest(res, "Invalid entry id");
        if (!reason) return badRequest(res, "reason is required");

        const { args, error } = parseIncomeBody(req.body);
        if (error) return badRequest(res, error);

        const contract = await getContract();
        const tx = await contract.supersedeIncomeEntry(oldId, ...args, reason);
        await tx.wait();

        const id = Number(await contract.incomeCount());
        txHashes.income[id] = tx.hash;

        res.json({ success: true, supersededId: oldId, newIncomeEntryId: id, transactionHash: tx.hash });
    } catch (err) { sendChainError(res, err); }
});

app.post("/income-entry/:id/void", requireRole("admin", "officer"), async (req, res) => {
    try {
        const id = Number(req.params.id);
        const reason = String(req.body.reason || "").trim();
        if (!id) return badRequest(res, "Invalid entry id");
        if (!reason) return badRequest(res, "reason is required");

        const contract = await contractForVoid(req.role);
        const tx = await contract.voidIncomeEntry(id, reason);
        await tx.wait();

        res.json({ success: true, message: `Income entry #${id} voided`, transactionHash: tx.hash });
    } catch (err) { sendChainError(res, err); }
});

app.post("/tax-payment", requireRole("admin", "officer"), async (req, res) => {
    try {
        const pan = String(req.body.pan || "").trim().toUpperCase();
        const taxTypeIndex = TAX_TYPES.indexOf(req.body.taxType);
        const amountPaise = rupeesToPaise(req.body.amount);
        const relatedIncomeId = Number(req.body.relatedIncomeId || 0);

        if (!PAN_RE.test(pan)) return badRequest(res, "Invalid PAN (expected format ABCDE1234F)");
        if (!validFinancialYear(req.body.financialYear)) return badRequest(res, "financialYear must look like 2025-26");
        if (taxTypeIndex < 0) return badRequest(res, `taxType must be one of: ${TAX_TYPES.join(", ")}`);
        if (amountPaise === null) return badRequest(res, "amount must be a positive number (max 2 decimals)");
        if (!Number.isInteger(relatedIncomeId) || relatedIncomeId < 0) return badRequest(res, "Invalid relatedIncomeId");
        if (TAX_TYPES[taxTypeIndex] === "TDS" && !relatedIncomeId) {
            return badRequest(res, "TDS must reference the income entry it was deducted from (relatedIncomeId)");
        }

        const contract = await getContract();
        const tx = await contract.addTaxPayment(
            hashPan(pan), req.body.financialYear, taxTypeIndex, relatedIncomeId, amountPaise
        );
        await tx.wait();

        const id = Number(await contract.paymentCount());
        txHashes.payment[id] = tx.hash;

        res.json({ success: true, taxPaymentId: id, transactionHash: tx.hash });
    } catch (err) { sendChainError(res, err); }
});

app.post("/tax-payment/:id/void", requireRole("admin", "officer"), async (req, res) => {
    try {
        const id = Number(req.params.id);
        const reason = String(req.body.reason || "").trim();
        if (!id) return badRequest(res, "Invalid payment id");
        if (!reason) return badRequest(res, "reason is required");

        const contract = await contractForVoid(req.role);
        const tx = await contract.voidTaxPayment(id, reason);
        await tx.wait();

        res.json({ success: true, message: `Tax payment #${id} voided`, transactionHash: tx.hash });
    } catch (err) { sendChainError(res, err); }
});

// GET /summary/:pan/:financialYear?deductions=150000
// 'deductions' = total eligible Chapter VI-A deductions (80C, 80D, ...) in
// rupees; used only by regimes that allow them (old regime).
app.get("/summary/:pan/:financialYear", requireRole("admin", "officer", "auditor"), async (req, res) => {
    try {
        const pan = String(req.params.pan || "").trim().toUpperCase();
        const financialYear = req.params.financialYear;

        if (!PAN_RE.test(pan)) return badRequest(res, "Invalid PAN (expected format ABCDE1234F)");
        if (!validFinancialYear(financialYear)) return badRequest(res, "financialYear must look like 2025-26");

        let otherDeductionsPaise = 0;
        if (req.query.deductions !== undefined && req.query.deductions !== "") {
            const d = String(req.query.deductions);
            if (!/^\d+(\.\d{1,2})?$/.test(d)) return badRequest(res, "deductions must be a non-negative number");
            otherDeductionsPaise = Math.round(Number(d) * 100);
        }

        await safeSyncTxHashes();

        const contract = await getContract();
        const panHash = hashPan(pan);

        const incomeIds = await contract.getIncomeIdsByPan(panHash);
        const paymentIds = await contract.getPaymentIdsByPan(panHash);

        const incomeEntries = [];
        for (const id of incomeIds) {
            const e = toIncomeEntry(await contract.getIncomeEntry(id));
            if (e.financialYear === financialYear) incomeEntries.push(e);
        }

        const payments = [];
        for (const id of paymentIds) {
            const p = toTaxPayment(await contract.getTaxPayment(id));
            if (p.financialYear === financialYear) payments.push(p);
        }

        const summary = buildSummary({ financialYear, incomeEntries, payments, otherDeductionsPaise });

        res.json({
            success: true,
            pan: `${pan.slice(0, 2)}XXXXX${pan.slice(7)}`,
            amountsIn: "paise (1 rupee = 100 paise)",
            deductionsAppliedPaise: otherDeductionsPaise,
            incomeEntries,
            taxPayments: payments,
            summary,
            disclaimer: "Estimate for a resident individual using the slabs in taxConfig.json. Verify with a Chartered Accountant before filing."
        });
    } catch (err) {
        console.error(err);
        const clientError = /No tax slabs configured/.test(err.message);
        res.status(clientError ? 400 : 500).json({ success: false, message: err.message });
    }
});

// ===============================
// START SERVER
// ===============================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    safeSyncTxHashes();
});
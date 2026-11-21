# Multi-source income extension: what changed

## Run it
```bash
# 1. chain
cd blockchain && npm install
npx hardhat build          # regenerates artifacts for the NEW contract (needs internet once)
npx hardhat node           # terminal 1 - leave running
node scripts/deploy.js     # terminal 2 - copy the printed address into backend/.env as CONTRACT_ADDRESS

# 2. backend: keep your existing .env and ADD one line (see .env.example):
#    PAN_SALT=<long random string>      <- set once, never change, never commit
cd ../backend && npm install && node server.js

# 3. frontend: open frontend/index.html, log in, open the "Tax Summary" tab (🧮)

# tests
node tests/workedExample.js                      # tax logic only, no chain needed
OFFICER_PASSWORD=.. AUDITOR_PASSWORD=.. ADMIN_PASSWORD=.. node tests/e2e.js   # needs node + server running
```
Redeploy the contract: the ABI changed, so an old deployment will not have the new functions.

## Files
| File | Change |
|---|---|
| blockchain/contracts/BillingSystem.sol | Added IncomeEntry / TaxPayment ledger (paise, PAN hash, void/supersede, events). Legacy `createTaxRecord` etc. untouched. |
| backend/taxEngine.js (new) | Pure tax maths: both regimes, rebate, marginal relief, cess, TDS/advance credit, GST kept separate. |
| backend/taxConfig.json (new) | Slabs, rebate, standard deduction, cess per financial year (edit here, not in the contract). |
| backend/server.js | New endpoints, login required on all read endpoints, tx hashes rebuilt from events, dashboard splits TDS/GST/advance. |
| backend/tests/*.js (new) | Worked example (assertions) and end-to-end test. |
| backend/.env.example (new) | Shows the new `PAN_SALT` setting. |
| frontend/index.html | New "Tax Summary" tab: filing forms, void form, summary view. Read calls now use `authFetch`. |

## API (all amounts in rupees on input, paise on output)
| Method & path | Roles | Purpose |
|---|---|---|
| POST /income-entry | admin, officer | pan, financialYear, incomeType (Salary / ProfessionalFees / Other), payerName, payerTAN, grossAmount |
| POST /income-entry/:id/supersede | admin, officer | same body + reason; voids the old entry and files the corrected one in one tx |
| POST /income-entry/:id/void | admin, officer | reason |
| POST /tax-payment | admin, officer | pan, financialYear, taxType (TDS / GST / AdvanceTax), relatedIncomeId (required for TDS), amount |
| POST /tax-payment/:id/void | admin, officer | reason |
| GET /summary/:pan/:fy?deductions= | admin, officer, auditor | income by type, credits, GST (separate), both regimes, balance payable / refund |
| GET /records, /record/:id, /dashboard | admin, officer, auditor | now require login |
| GET /accounts, /roles | admin | now require login |

## Assumptions: verify with a CA
- FY 2025-26 and 2026-27 use the same slabs (Budget 2026 left them unchanged, per published summaries I checked). New regime: 0-4L nil, then 5/10/15/20/25/30%, std deduction 75,000, rebate up to 60,000 if taxable income <= 12L (with marginal relief). Old regime: 0-2.5L nil, 5% to 5L, 20% to 10L, 30% above, std deduction 50,000, rebate up to 12,500 if <= 5L. Cess 4%.
- From 1 April 2026 the Income-tax Act, 2025 replaces the 1961 Act, so section numbers in comments (192, 194J, 87A) may be renumbered. The rates used here are unchanged.
- No surcharge (income above 50L), no HRA / home-loan interest, no professional-expense deduction, no rounding to Rs 10, no interest (234A/B/C). Chapter VI-A deductions are a single number you type in, applied to the old regime only.
- GST is reported separately; it is never deducted from income or credited against income tax. Whether GST applies to a given VTU service is a separate question for a GST professional.
- TDS only counts as credit if its income entry is active; TDS pointing at a voided income entry is excluded and flagged.

## Known limits
- Legacy `createTaxRecord` still stores PAN in plaintext on-chain. Use the new ledger for real PANs.
- A hashed PAN can still be guessed if PAN_SALT leaks. Keep it secret.
- There is no "taxpayer" login role; the lecturer's view is read by an admin/officer/auditor.
- The backend still signs for all roles with fixed Hardhat accounts (demo design, unchanged).

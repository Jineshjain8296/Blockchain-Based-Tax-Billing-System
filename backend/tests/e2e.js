// End-to-end check against a RUNNING backend + local Hardhat node.
//   node tests/e2e.js            (expects http://localhost:5000, default passwords from .env)
// Env: API=http://localhost:5000  OFFICER_PASSWORD=...  AUDITOR_PASSWORD=...  ADMIN_PASSWORD=...
const assert = require("assert");
const API = process.env.API || "http://localhost:5000";
const PW = {
  admin: process.env.ADMIN_PASSWORD, officer: process.env.OFFICER_PASSWORD, auditor: process.env.AUDITOR_PASSWORD
};
// unique PAN per run so reruns on the same chain don't mix data
const L = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const r = () => L[Math.floor(Math.random() * L.length)];
const PAN = `${r()}${r()}${r()}${r()}${r()}${1000 + Math.floor(Math.random() * 8999)}${r()}`;
const FY = "2025-26";

async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}
const login = async (role) => (await call("POST", "/login", null, { role, password: PW[role] })).body.token;

(async () => {
  const officer = await login("officer");
  const auditor = await login("auditor");
  const admin = await login("admin");
  assert(officer && auditor && admin, "login failed - pass the role passwords as env vars");

  // 1. read endpoints now need a login
  for (const p of ["/records", "/dashboard", "/accounts", "/roles", `/summary/${PAN}/${FY}`]) {
    assert.equal((await call("GET", p)).status, 401, p + " should require login");
  }
  assert.equal((await call("GET", "/accounts", officer)).status, 403, "/accounts is admin-only");
  console.log("ok  read endpoints require login");

  // 2. file the worked example
  const sal = await call("POST", "/income-entry", officer, { pan: PAN, financialYear: FY, incomeType: "Salary", payerName: "ABC Engineering College", payerTAN: "BLRA12345B", grossAmount: "900000" });
  const vtu = await call("POST", "/income-entry", officer, { pan: PAN, financialYear: FY, incomeType: "ProfessionalFees", payerName: "VTU", payerTAN: "BLRV12345C", grossAmount: "150000" });
  assert(sal.body.success && vtu.body.success, JSON.stringify([sal.body, vtu.body]));
  const [salId, vtuId] = [sal.body.incomeEntryId, vtu.body.incomeEntryId];
  for (const [id, amt] of [[salId, "40000"], [vtuId, "15000"]]) {
    const t = await call("POST", "/tax-payment", officer, { pan: PAN, financialYear: FY, taxType: "TDS", relatedIncomeId: id, amount: amt });
    assert(t.body.success, JSON.stringify(t.body));
  }
  const g = await call("POST", "/tax-payment", officer, { pan: PAN, financialYear: FY, taxType: "GST", relatedIncomeId: vtuId, amount: "27000" });
  assert(g.body.success, JSON.stringify(g.body));
  console.log("ok  filed 2 income entries, 2 TDS, 1 GST");

  // 3. validation + on-chain rules
  assert.equal((await call("POST", "/income-entry", auditor, {})).status, 403, "auditor cannot file");
  assert.equal((await call("POST", "/tax-payment", officer, { pan: PAN, financialYear: FY, taxType: "TDS", amount: "10" })).status, 400, "TDS needs relatedIncomeId");
  const wrongPan = await call("POST", "/tax-payment", officer, { pan: "ZZZZZ9999Z", financialYear: FY, taxType: "TDS", relatedIncomeId: salId, amount: "10" });
  assert.equal(wrongPan.status, 500); assert(/different PAN/.test(wrongPan.body.message), wrongPan.body.message);
  console.log("ok  validation and on-chain checks");

  // 4. summary
  let s = (await call("GET", `/summary/${PAN}/${FY}`, auditor)).body;
  assert(s.success, JSON.stringify(s));
  assert.equal(s.summary.gstPaidPaise, 2700000);
  assert.equal(s.summary.creditsPaise.tds, 5500000);
  assert.equal(s.summary.regimes.new.balancePaise, -5500000);
  assert.equal(s.summary.regimes.old.balancePaise, 6200000);
  assert(s.incomeEntries.every((e) => e.transactionHash), "tx hashes present");
  assert(!JSON.stringify(s).includes(PAN), "full PAN must not be echoed back");
  console.log("ok  summary: new regime REFUND 55,000 | old regime PAYABLE 62,000 | GST 27,000 separate");

  // 5. deductions only affect the old regime
  s = (await call("GET", `/summary/${PAN}/${FY}?deductions=150000`, officer)).body;
  assert.equal(s.summary.regimes.old.balancePaise, 3080000);
  assert.equal(s.summary.regimes.new.totalTaxPaise, 0);
  console.log("ok  Chapter VI-A deductions applied to old regime only");

  // 6. supersede (correct the VTU amount) - history stays on-chain
  const sup = await call("POST", `/income-entry/${vtuId}/supersede`, officer, { pan: PAN, financialYear: FY, incomeType: "ProfessionalFees", payerName: "VTU", payerTAN: "BLRV12345C", grossAmount: "200000", reason: "Typo in amount" });
  assert(sup.body.success, JSON.stringify(sup.body));
  s = (await call("GET", `/summary/${PAN}/${FY}`, officer)).body;
  assert.equal(s.summary.incomeByTypePaise.ProfessionalFees, 20000000);
  const old = s.incomeEntries.find((e) => e.id === vtuId);
  assert(old.voided && old.supersededBy === sup.body.newIncomeEntryId && old.voidReason === "Typo in amount");
  assert(s.summary.warnings.some((w) => /NOT credited/.test(w)), "TDS pointing at voided income must warn");
  console.log("ok  supersede keeps the voided original and warns about orphaned TDS");

  // 7. void a payment; only filing officer / admin may
  const pays = s.taxPayments; const tds2 = pays.find((p) => p.taxType === "TDS" && p.relatedIncomeId === vtuId);
  assert.equal((await call("POST", `/tax-payment/${tds2.id}/void`, auditor, { reason: "x" })).status, 403);
  const v = await call("POST", `/tax-payment/${tds2.id}/void`, admin, { reason: "Re-filing against corrected entry" });
  assert(v.body.success, JSON.stringify(v.body));
  console.log("ok  void payment by admin; auditor blocked");

  // 8. dashboard keeps TDS / GST / advance separate
  const d = (await call("GET", "/dashboard", auditor)).body;
  assert(d.ledger && "tdsPaise" in d.ledger && "gstPaise" in d.ledger && "advanceTaxPaise" in d.ledger);
  console.log("ok  dashboard ledger totals:", JSON.stringify(d.ledger));

  console.log("\nPAN used:", PAN, "\nAll end-to-end checks passed.");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });

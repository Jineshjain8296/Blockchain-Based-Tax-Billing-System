// Run:  node tests/workedExample.js      (no blockchain needed)
// Scenario: lecturer with college salary + VTU professional fees.
const assert = require("assert");
const { buildSummary, toPaise } = require("../taxEngine");

const rs = (p) => (p < 0 ? "-" : "") + "Rs " + (Math.abs(p) / 100).toLocaleString("en-IN");
const incomeEntries = [
  { id: 1, incomeType: "Salary", payerName: "ABC Engineering College", grossPaise: toPaise(900000), voided: false },
  { id: 2, incomeType: "ProfessionalFees", payerName: "VTU", grossPaise: toPaise(150000), voided: false }
];
const payments = [
  { id: 1, taxType: "TDS", relatedIncomeId: 1, amountPaise: toPaise(40000), voided: false },  // s.192
  { id: 2, taxType: "TDS", relatedIncomeId: 2, amountPaise: toPaise(15000), voided: false },  // 194J
  { id: 3, taxType: "GST", relatedIncomeId: 2, amountPaise: toPaise(27000), voided: false }   // 18% of 1.5L
];

function show(title, s) {
  console.log(`\n=== ${title} ===`);
  console.log("Income:", Object.entries(s.incomeByTypePaise).map(([k, v]) => `${k} ${rs(v)}`).join(" | "));
  console.log(`TDS credit ${rs(s.creditsPaise.tds)} | Advance tax ${rs(s.creditsPaise.advanceTax)} | GST paid (separate, NOT credited) ${rs(s.gstPaidPaise)}`);
  for (const [k, r] of Object.entries(s.regimes)) {
    console.log(`\n  [${k.toUpperCase()}] ${r.label}`);
    console.log(`   Gross income        ${rs(r.grossIncomePaise)}`);
    console.log(`   - Std deduction     ${rs(r.standardDeductionPaise)}`);
    console.log(`   - Ch VI-A           ${rs(r.otherDeductionsPaise)}`);
    console.log(`   Taxable income      ${rs(r.taxableIncomePaise)}`);
    console.log(`   Slab tax            ${rs(r.slabTaxPaise)}`);
    console.log(`   - Rebate 87A        ${rs(r.rebatePaise + r.marginalReliefPaise)}`);
    console.log(`   + Cess 4%           ${rs(r.cessPaise)}`);
    console.log(`   Total tax           ${rs(r.totalTaxPaise)}`);
    console.log(`   - TDS & advance     ${rs(r.tdsCreditPaise + r.advanceTaxPaise)}`);
    console.log(`   ${r.status.padEnd(8)}            ${rs(Math.abs(r.balancePaise))}`);
  }
  console.log(`\n  Lower total tax: ${s.recommendedRegime ? s.recommendedRegime.toUpperCase() + ' regime' : 'same under both regimes'}`);
}

// Scenario A: no Chapter VI-A deductions
const a = buildSummary({ financialYear: "2025-26", incomeEntries, payments });
show("FY 2025-26, no Chapter VI-A deductions", a);
assert.equal(a.gstPaidPaise, toPaise(27000));
assert.equal(a.creditsPaise.tds, toPaise(55000));
// New: 10.5L - 75k = 9.75L; slab tax 37,500; fully rebated -> 0; refund of TDS
assert.equal(a.regimes.new.taxableIncomePaise, toPaise(975000));
assert.equal(a.regimes.new.slabTaxPaise, toPaise(37500));
assert.equal(a.regimes.new.totalTaxPaise, 0);
assert.equal(a.regimes.new.balancePaise, -toPaise(55000));
// Old: 10.5L - 50k = 10L; slab tax 1,12,500 + 4% cess 4,500 = 1,17,000; payable 62,000
assert.equal(a.regimes.old.taxableIncomePaise, toPaise(1000000));
assert.equal(a.regimes.old.totalTaxPaise, toPaise(117000));
assert.equal(a.regimes.old.balancePaise, toPaise(62000));

// Scenario B: Rs 1.5L of 80C/80D etc. (helps old regime only)
const b = buildSummary({ financialYear: "2025-26", incomeEntries, payments, otherDeductionsPaise: toPaise(150000) });
show("FY 2025-26, Rs 1,50,000 Chapter VI-A deductions", b);
assert.equal(b.regimes.old.taxableIncomePaise, toPaise(850000));
assert.equal(b.regimes.old.totalTaxPaise, toPaise(85800));   // 82,500 + 3,300 cess
assert.equal(b.regimes.old.balancePaise, toPaise(30800));
assert.equal(b.regimes.new.totalTaxPaise, 0);                // new regime ignores them

// Scenario C: voiding the VTU income must also stop its TDS being credited
const c = buildSummary({
  financialYear: "2025-26",
  incomeEntries: [incomeEntries[0], { ...incomeEntries[1], voided: true }],
  payments
});
assert.equal(c.creditsPaise.tds, toPaise(40000));
assert.equal(c.warnings.length >= 1, true);

console.log("\nAll assertions passed.");

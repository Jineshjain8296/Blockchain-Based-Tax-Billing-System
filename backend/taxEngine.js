// Pure tax computation - no blockchain, no I/O, so it can be unit-tested.
// ALL money values handled here are integers in PAISE (1 rupee = 100 paise).
//
// Scope / simplifications (verify with a CA):
//  - Resident individual below 50 lakh income (no surcharge modelled).
//  - Standard deduction applies only if there is salary income.
//  - Professional-fee expenses, HRA, 24(b), etc. are NOT modelled; other
//    Chapter VI-A deductions (80C, 80D...) are passed in as one number and
//    are only applied under regimes with allowChapterVIA = true.
//  - Rounding of income/tax to the nearest Rs 10 (s.288A/288B) is not applied.
//  - GST is an indirect tax on the service: it is reported separately and is
//    NEVER deducted from income or credited against income tax.
//  - TDS and advance tax are prepaid income tax and are credited.

const config = require("./taxConfig.json");

const INCOME_TYPES = ["Salary", "ProfessionalFees", "Other"];
const TAX_TYPES = ["TDS", "GST", "AdvanceTax"];
const toPaise = (rupees) => Math.round(rupees * 100);

function getFYConfig(fy, cfg = config) {
  let entry = cfg.financialYears[fy];
  if (entry && entry.sameAs) entry = cfg.financialYears[entry.sameAs];
  if (!entry) {
    throw new Error(
      `No tax slabs configured for FY ${fy}. Supported: ${Object.keys(cfg.financialYears).join(", ")}`
    );
  }
  return { regimes: entry.regimes, cessPercent: cfg.cessPercent };
}

function slabTax(taxablePaise, slabs) {
  let tax = 0;
  let lower = 0;
  for (const s of slabs) {
    const upper = s.upto === null ? Infinity : toPaise(s.upto);
    if (taxablePaise > lower) {
      const inSlab = Math.min(taxablePaise, upper) - lower;
      tax += Math.round((inSlab * s.rate) / 100);
    }
    lower = upper;
    if (taxablePaise <= upper) break;
  }
  return tax;
}

function computeRegime(regimeCfg, cessPercent, incomeByType, otherDeductionsPaise, creditsPaise) {
  const gross = INCOME_TYPES.reduce((a, t) => a + (incomeByType[t] || 0), 0);
  const salary = incomeByType.Salary || 0;

  const standardDeduction = salary > 0
    ? Math.min(salary, toPaise(regimeCfg.standardDeductionSalary))
    : 0;
  const otherDeductions = regimeCfg.allowChapterVIA ? otherDeductionsPaise : 0;
  const taxable = Math.max(0, gross - standardDeduction - otherDeductions);

  let tax = slabTax(taxable, regimeCfg.slabs);
  let rebate = 0;
  let marginalRelief = 0;

  const r = regimeCfg.rebate;
  if (r) {
    const limit = toPaise(r.incomeLimit);
    if (taxable <= limit) {
      rebate = Math.min(tax, toPaise(r.maxRebate));
    } else if (r.marginalRelief) {
      const excess = taxable - limit;
      if (tax > excess) marginalRelief = tax - excess;
    }
  }

  const taxAfterRebate = tax - rebate - marginalRelief;
  const cess = Math.round((taxAfterRebate * cessPercent) / 100);
  const totalTax = taxAfterRebate + cess;
  const balance = totalTax - creditsPaise.total; // >0 payable, <0 refund

  return {
    label: regimeCfg.label,
    grossIncomePaise: gross,
    standardDeductionPaise: standardDeduction,
    otherDeductionsPaise: otherDeductions,
    taxableIncomePaise: taxable,
    slabTaxPaise: tax,
    rebatePaise: rebate,
    marginalReliefPaise: marginalRelief,
    taxAfterRebatePaise: taxAfterRebate,
    cessPaise: cess,
    totalTaxPaise: totalTax,
    tdsCreditPaise: creditsPaise.tds,
    advanceTaxPaise: creditsPaise.advanceTax,
    balancePaise: balance,
    status: balance > 0 ? "PAYABLE" : balance < 0 ? "REFUND" : "NIL"
  };
}

// incomeEntries: [{id, incomeType, payerName, payerTAN, grossPaise, voided, ...}]
// payments:      [{id, taxType, relatedIncomeId, amountPaise, voided, ...}]
function buildSummary({ financialYear, incomeEntries, payments, otherDeductionsPaise = 0 }) {
  const fy = getFYConfig(financialYear);
  const warnings = [];

  const liveIncome = incomeEntries.filter((e) => !e.voided);
  const incomeById = new Map(incomeEntries.map((e) => [e.id, e]));

  const incomeByType = { Salary: 0, ProfessionalFees: 0, Other: 0 };
  for (const e of liveIncome) incomeByType[e.incomeType] += e.grossPaise;

  const credits = { tds: 0, advanceTax: 0, total: 0 };
  let gstPaid = 0;

  for (const p of payments.filter((x) => !x.voided)) {
    if (p.taxType === "GST") {
      gstPaid += p.amountPaise;
      continue;
    }
    if (p.taxType === "TDS") {
      const inc = incomeById.get(p.relatedIncomeId);
      if (!inc || inc.voided) {
        warnings.push(
          `TDS payment #${p.id} references income entry #${p.relatedIncomeId}, which is missing or voided - it was NOT credited. Void it or file a corrected one.`
        );
        continue;
      }
      credits.tds += p.amountPaise;
    } else if (p.taxType === "AdvanceTax") {
      credits.advanceTax += p.amountPaise;
    }
  }
  credits.total = credits.tds + credits.advanceTax;

  if (liveIncome.length === 0) warnings.push("No active income entries for this PAN and financial year.");
  if (gstPaid > 0 && !(incomeByType.ProfessionalFees || incomeByType.Other)) {
    warnings.push("GST is recorded but there is no professional-fee / other income entry for it.");
  }

  const regimes = {};
  for (const [key, rc] of Object.entries(fy.regimes)) {
    regimes[key] = computeRegime(rc, fy.cessPercent, incomeByType, otherDeductionsPaise, credits);
  }

  const keys = Object.keys(regimes);
  const best = keys.reduce((b, k) =>
    regimes[k].totalTaxPaise < regimes[b].totalTaxPaise ? k : b, keys[0]);
  // null when every regime gives the same tax (nothing to recommend)
  const recommended = keys.every((k) => regimes[k].totalTaxPaise === regimes[best].totalTaxPaise) ? null : best;

  return {
    financialYear,
    incomeByTypePaise: incomeByType,
    grossIncomePaise: INCOME_TYPES.reduce((a, t) => a + incomeByType[t], 0),
    creditsPaise: credits,
    gstPaidPaise: gstPaid,
    gstNote: "GST is an indirect tax on the service. It is shown separately and is not deducted from income or credited against income tax.",
    regimes,
    recommendedRegime: recommended,
    warnings
  };
}

module.exports = { buildSummary, computeRegime, slabTax, getFYConfig, toPaise, INCOME_TYPES, TAX_TYPES };

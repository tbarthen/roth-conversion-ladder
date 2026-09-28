/* ============================================================
   ROTH CONVERSION LADDER — TAX ENGINE
   Pure calculation code shared by the browser app (index.html),
   the Node sync script (scripts/sync-rates.js) and the unit tests
   (tests/*.test.js). No DOM, no globals besides the export.

   Every tax figure comes from a rates document (data/rates.json,
   schema v2). Call compileTaxData(rates) once and pass the result
   ("td") to the calculation functions.
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TaxEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const FILING_STATUSES = ['single', 'marriedFilingJointly', 'marriedFilingSeparately'];
const RATES_SCHEMA_VERSION = 2;
const REQUIRED_ITEMS = [
  'federalBrackets', 'standardDeduction', 'additionalStandardDeduction65',
  'seniorBonusDeduction', 'capitalGainsBrackets', 'niit',
  'socialSecurityTaxation', 'socialSecurityClaiming', 'medicareIrmaa',
  'rmd', 'penalties', 'stateIncomeTax'
];
const TARGET_BRACKETS = [0.10, 0.12, 0.22, 0.24, 0.32, 0.35];
/* State data has single and joint figures; other filers use the single ones. */
const STATE_FILING_STATUSES = ['single', 'marriedFilingJointly'];
/* Per-state amounts from the Tax Foundation table, with sanity limits. */
const STATE_ALLOWANCES = [['standardDeduction', 1e6], ['personalExemption', 1e6], ['personalCredit', 1e4]];
const STALE_AFTER_DAYS = 45;
const MIN_CONVERSION = 1000;
const IRMAA_CUSHION = 1000;

/* ============================================================
   SMALL HELPERS
   ============================================================ */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && isFinite(v);
const isInt = (v) => Number.isInteger(v);
const isDateStr = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z'));

/** Grow (or shrink) an amount by `rate` per year between two years. */
function indexAmount(amount, fromYear, toYear, rate) {
  if (amount === Infinity || amount === null) return Infinity;
  return amount * Math.pow(1 + (rate || 0), toYear - fromYear);
}

/* ============================================================
   RATES DOCUMENT: VALIDATION
   Returns an array of human-readable problems (empty = valid).
   ============================================================ */
const UNSAFE_STRING = /[<>`\u0000-\u001f]/;

function checkStrings(value, path, err) {
  if (typeof value === 'string') {
    if (UNSAFE_STRING.test(value)) err(`${path}: contains unsafe characters`);
    if (value.length > 300) err(`${path}: string too long`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => checkStrings(v, `${path}[${i}]`, err));
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (UNSAFE_STRING.test(k) || k === '__proto__' || k === 'constructor' || k === 'prototype') err(`${path}: unsafe key ${JSON.stringify(k)}`);
      checkStrings(v, `${path}.${k}`, err);
    }
  }
}

function validateBracketTable(value, err, { allowZeroRate = false } = {}) {
  if (!isObj(value)) return err('must be an object keyed by filing status');
  for (const fs of FILING_STATUSES) {
    const rows = value[fs];
    if (!Array.isArray(rows) || rows.length < 2) { err(`${fs}: needs at least 2 brackets`); continue; }
    let prevRate = -1, prevUpper = 0;
    rows.forEach((row, i) => {
      const last = i === rows.length - 1;
      if (!Array.isArray(row) || row.length !== 2) return err(`${fs}[${i}]: must be [rate, upperBound]`);
      const [rate, upper] = row;
      if (!isNum(rate) || rate < 0 || rate >= 1 || (!allowZeroRate && rate === 0)) err(`${fs}[${i}]: rate ${rate} out of range`);
      if (isNum(rate) && rate <= prevRate) err(`${fs}[${i}]: rates must be ascending`);
      if (last) {
        if (upper !== null) err(`${fs}: last bracket upper bound must be null (no limit)`);
      } else if (!isNum(upper) || upper <= prevUpper) {
        err(`${fs}[${i}]: upper bound ${upper} must be a number above ${prevUpper} (brackets ascending)`);
      }
      if (isNum(rate)) prevRate = rate;
      if (isNum(upper)) prevUpper = upper;
    });
  }
}

function validatePositive(obj, keys, err, max = 1e7) {
  if (!isObj(obj)) return err('must be an object');
  for (const k of keys) {
    if (!isNum(obj[k]) || obj[k] <= 0 || obj[k] > max) err(`${k}: ${obj[k]} must be a positive number`);
  }
}

const ITEM_VALIDATORS = {
  federalBrackets: (v, err) => validateBracketTable(v, err),
  capitalGainsBrackets: (v, err) => validateBracketTable(v, err, { allowZeroRate: true }),
  standardDeduction: (v, err) => validatePositive(v, FILING_STATUSES, err, 1e6),
  additionalStandardDeduction65: (v, err) => validatePositive(v, ['unmarried', 'married'], err, 1e5),
  seniorBonusDeduction: (v, err) => {
    if (!isObj(v)) return err('must be an object');
    validatePositive(v, ['amountPerPerson', 'phaseoutRate'], err, 1e6);
    if (isNum(v.phaseoutRate) && v.phaseoutRate >= 1) err('phaseoutRate must be < 1');
    validatePositive(v.phaseoutStart, ['single', 'marriedFilingJointly'], (m) => err(`phaseoutStart.${m}`), 1e7);
    if (!isInt(v.firstYear) || !isInt(v.lastYear) || v.firstYear > v.lastYear) err('firstYear/lastYear invalid');
  },
  niit: (v, err) => {
    if (!isObj(v)) return err('must be an object');
    if (!isNum(v.rate) || v.rate <= 0 || v.rate >= 0.2) err('rate out of range');
    validatePositive(v.thresholds, FILING_STATUSES, (m) => err(`thresholds.${m}`));
  },
  socialSecurityTaxation: (v, err) => {
    if (!isObj(v)) return err('must be an object');
    for (const fs of FILING_STATUSES) {
      const t = v[fs];
      if (!isObj(t) || !isNum(t.baseAmount) || !isNum(t.additionalAmount) || t.baseAmount < 0 || t.additionalAmount < t.baseAmount) {
        err(`${fs}: needs 0 <= baseAmount <= additionalAmount`);
      }
    }
    for (const k of ['tier1Rate', 'tier2Rate']) if (!isNum(v[k]) || v[k] <= 0 || v[k] > 1) err(`${k} out of range`);
  },
  socialSecurityClaiming: (v, err) => {
    if (!isObj(v)) return err('must be an object');
    const fra = v.fullRetirementAge;
    if (!Array.isArray(fra) || fra.length < 2) err('fullRetirementAge table missing');
    else {
      let prev = -Infinity;
      fra.forEach((row, i) => {
        const last = i === fra.length - 1;
        if (!isObj(row) || !isInt(row.years) || !isInt(row.months) || row.months < 0 || row.months > 11) err(`fullRetirementAge[${i}] invalid`);
        if (last ? row.bornThrough !== null : (!isInt(row.bornThrough) || row.bornThrough <= prev)) err(`fullRetirementAge[${i}].bornThrough must ascend and end with null`);
        if (isInt(row.bornThrough)) prev = row.bornThrough;
      });
    }
    for (const k of ['earlyReductionFirst36Months', 'earlyReductionPerYearBeyond36', 'delayedCreditPerYear']) {
      if (!isNum(v[k]) || v[k] <= 0 || v[k] >= 1) err(`${k} out of range`);
    }
    if (!isInt(v.earliestClaimAge) || !isInt(v.maxCreditAge) || v.earliestClaimAge >= v.maxCreditAge) err('claim ages invalid');
  },
  medicareIrmaa: (v, err) => {
    if (!isObj(v)) return err('must be an object');
    if (!isNum(v.partBStandardPremium) || v.partBStandardPremium <= 0 || v.partBStandardPremium > 2000) err('partBStandardPremium invalid');
    if (!isInt(v.lookbackYears) || v.lookbackYears < 1 || v.lookbackYears > 3) err('lookbackYears invalid');
    if (!isObj(v.tiers)) return err('tiers missing');
    for (const fs of FILING_STATUSES) {
      const tiers = v.tiers[fs];
      if (!Array.isArray(tiers) || tiers.length < 1) { err(`tiers.${fs} missing`); continue; }
      let prev = { magiOver: 0, partBTotal: v.partBStandardPremium, partD: -1 };
      tiers.forEach((t, i) => {
        if (!isObj(t) || !isNum(t.magiOver) || !isNum(t.partBTotal) || !isNum(t.partD)) return err(`tiers.${fs}[${i}] invalid`);
        if (t.magiOver <= prev.magiOver) err(`tiers.${fs}[${i}]: MAGI thresholds must be ascending`);
        if (t.partBTotal <= prev.partBTotal) err(`tiers.${fs}[${i}]: Part B premiums must be ascending and above the standard premium`);
        if (t.partD <= prev.partD) err(`tiers.${fs}[${i}]: Part D amounts must be ascending`);
        prev = t;
      });
    }
  },
  rmd: (v, err) => {
    if (!isObj(v)) return err('must be an object');
    const sa = v.startAgeByBirthYear;
    if (!Array.isArray(sa) || sa.length < 1) err('startAgeByBirthYear missing');
    else {
      let prev = -Infinity;
      sa.forEach((row, i) => {
        const last = i === sa.length - 1;
        if (!isObj(row) || !isInt(row.age) || row.age < 70 || row.age > 80) err(`startAgeByBirthYear[${i}].age invalid`);
        if (last ? row.bornThrough !== null : (!isInt(row.bornThrough) || row.bornThrough <= prev)) err(`startAgeByBirthYear[${i}].bornThrough must ascend and end with null`);
        if (isInt(row.bornThrough)) prev = row.bornThrough;
      });
    }
    const ult = v.uniformLifetimeTable;
    if (!isObj(ult)) err('uniformLifetimeTable missing');
    else {
      let prev = Infinity;
      for (let age = 72; age <= 120; age++) {
        const d = ult[String(age)];
        if (!isNum(d) || d <= 0) { err(`uniformLifetimeTable.${age} missing`); continue; }
        if (d > prev) err(`uniformLifetimeTable.${age}: divisors must not increase with age`);
        prev = d;
      }
    }
    const jlt = v.jointLifeTable;
    if (jlt !== null && jlt !== undefined) {
      if (!isObj(jlt) || !isInt(jlt.minBeneficiaryAge) || !isObj(jlt.rows)) err('jointLifeTable invalid');
      else {
        for (const [owner, row] of Object.entries(jlt.rows)) {
          if (!/^\d+$/.test(owner) || !Array.isArray(row) || row.length === 0) { err(`jointLifeTable.rows.${owner} invalid`); continue; }
          let prev = Infinity;
          row.forEach((d, i) => {
            if (!isNum(d) || d <= 0) err(`jointLifeTable.rows.${owner}[${i}] invalid`);
            else if (d > prev) err(`jointLifeTable.rows.${owner}: divisors must not increase with beneficiary age`);
            else prev = d;
          });
        }
      }
    }
  },
  penalties: (v, err) => {
    if (!isObj(v)) return err('must be an object');
    for (const k of ['earlyDistributionRate', 'hsaNonMedicalRate']) if (!isNum(v[k]) || v[k] <= 0 || v[k] >= 1) err(`${k} out of range`);
    for (const k of ['earlyDistributionAge', 'hsaPenaltyFreeAge']) if (!isNum(v[k]) || v[k] < 50 || v[k] > 75) err(`${k} out of range`);
    if (!isInt(v.rothConversionSeasoningYears) || v.rothConversionSeasoningYears < 1) err('rothConversionSeasoningYears invalid');
  },
  stateIncomeTax: (v, err) => {
    if (!isObj(v) || !Array.isArray(v.states)) return err('states array missing');
    if (v.states.length < 51) err(`expected 51 states (incl. DC), got ${v.states.length}`);
    const seen = new Set();
    v.states.forEach((s, i) => {
      if (!isObj(s) || typeof s.abbr !== 'string' || !/^[A-Z]{2}$/.test(s.abbr)) return err(`states[${i}].abbr invalid`);
      if (seen.has(s.abbr)) err(`duplicate state ${s.abbr}`);
      seen.add(s.abbr);
      if (typeof s.name !== 'string' || !/^[A-Za-z .'-]+$/.test(s.name)) err(`${s.abbr}: name invalid`);
      if (!isNum(s.rate) || s.rate < 0 || s.rate > 20) err(`${s.abbr}: rate ${s.rate} out of range`);
      if (typeof s.taxesSocialSecurity !== 'boolean') err(`${s.abbr}: taxesSocialSecurity must be true/false`);
      for (const [k, max] of STATE_ALLOWANCES) {
        const a = s[k];
        if (!isObj(a) || !STATE_FILING_STATUSES.every(fs => isNum(a[fs]) && a[fs] >= 0 && a[fs] <= max)) {
          err(`${s.abbr}: ${k} must give single and marriedFilingJointly amounts from 0 to ${max}`);
        }
      }
      if (s.socialSecurityExemption !== undefined) {
        const x = s.socialSecurityExemption;
        if (s.taxesSocialSecurity !== true || !isObj(x) || !isInt(x.fromAge) || x.fromAge < 55 || x.fromAge > 75
            || typeof x.sourceName !== 'string' || !x.sourceName
            || typeof x.source !== 'string' || !/^https:\/\/[^\s]+$/.test(x.source)) {
          err(`${s.abbr}: socialSecurityExemption needs fromAge (55-75), sourceName and an https source, on a state whose taxesSocialSecurity is true`);
        }
      }
      if (s.retirementExclusion !== undefined) {
        const x = s.retirementExclusion;
        if (!isObj(x) || !isNum(x.iraFromAge) || x.iraFromAge < 0 || x.iraFromAge > 75
            || typeof x.conversions !== 'boolean' || typeof x.pensions !== 'boolean'
            || typeof x.sourceName !== 'string' || !x.sourceName
            || typeof x.source !== 'string' || !/^https:\/\/[^\s]+$/.test(x.source)) {
          err(`${s.abbr}: retirementExclusion needs iraFromAge (0-75), conversions and pensions (true/false), sourceName and an https source`);
        }
      }
      if (!isObj(s.brackets)) return err(`${s.abbr}: brackets missing`);
      for (const fs of STATE_FILING_STATUSES) {
        const rows = s.brackets[fs];
        if (!Array.isArray(rows) || rows.length < 1) { err(`${s.abbr}.brackets.${fs} missing`); continue; }
        let prevRate = -1, prevUpper = 0;
        rows.forEach((row, i) => {
          const last = i === rows.length - 1;
          if (!Array.isArray(row) || row.length !== 2 || !isNum(row[0]) || row[0] < 0 || row[0] >= 0.25) return err(`${s.abbr}.brackets.${fs}[${i}] invalid`);
          if (row[0] <= prevRate) err(`${s.abbr}.brackets.${fs}[${i}]: rates must be ascending`);
          if (last ? row[1] !== null : (!isNum(row[1]) || row[1] <= prevUpper)) err(`${s.abbr}.brackets.${fs}[${i}]: upper bounds must ascend and end with null`);
          prevRate = row[0];
          if (isNum(row[1])) prevUpper = row[1];
        });
        const top = rows[rows.length - 1];
        if (Array.isArray(top) && isNum(top[0]) && isNum(s.rate) && Math.abs(top[0] * 100 - s.rate) > 0.0005) {
          err(`${s.abbr}.brackets.${fs}: top rate ${top[0] * 100}% does not match rate ${s.rate}%`);
        }
      }
    });
  }
};

function validateRates(rates) {
  const errs = [];
  const err = (m) => errs.push(m);
  if (!isObj(rates)) return ['rates document must be a JSON object'];
  if (rates.schemaVersion !== RATES_SCHEMA_VERSION) err(`schemaVersion must be ${RATES_SCHEMA_VERSION}`);
  if (!isInt(rates.taxYear) || rates.taxYear < 2024 || rates.taxYear > 2100) err('taxYear invalid');
  for (const k of ['lastChecked', 'lastUpdated']) if (!isDateStr(rates[k])) err(`${k} must be a YYYY-MM-DD date`);
  checkStrings(rates, 'rates', err);
  if (!isObj(rates.items)) { err('items missing'); return errs; }
  for (const key of REQUIRED_ITEMS) {
    const it = rates.items[key];
    const e = (m) => err(`items.${key}: ${m}`);
    if (!isObj(it)) { e('missing'); continue; }
    if (typeof it.label !== 'string' || !it.label) e('label missing');
    if (typeof it.sourceName !== 'string' || !it.sourceName) e('sourceName missing');
    if (typeof it.source !== 'string' || !/^https:\/\/[^\s]+$/.test(it.source)) e('source must be an https URL');
    if (!isInt(it.effectiveYear) || it.effectiveYear > rates.taxYear || it.effectiveYear < rates.taxYear - 1) {
      e(`effectiveYear ${it.effectiveYear} must be ${rates.taxYear} or ${rates.taxYear - 1}`);
    }
    if (typeof it.indexed !== 'boolean') e('indexed must be true/false');
    if (!('value' in it)) e('value missing');
    else ITEM_VALIDATORS[key](it.value, e);
  }
  return errs;
}

/* ============================================================
   RATES DOCUMENT: CANONICAL JSON FORMAT
   Same algorithm is implemented in fetcher/tax_fetcher/ratesfmt.py
   so both writers produce byte-identical files.
   ============================================================ */
const FORMAT_WIDTH = 100;

function formatScalar(v) {
  if (typeof v === 'number') {
    if (!isFinite(v)) throw new Error('non-finite number in rates');
    return String(v);
  }
  return JSON.stringify(v);
}

function formatRatesJson(value) {
  const isScalar = (v) => v === null || typeof v !== 'object';
  const fmt = (v, indent) => {
    if (isScalar(v)) return formatScalar(v);
    const inner = indent + '  ';
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      if (v.every(isScalar)) {
        const items = v.map(formatScalar);
        const inline = '[' + items.join(', ') + ']';
        if (indent.length + inline.length <= FORMAT_WIDTH) return inline;
        const lines = [];
        let cur = '';
        for (const item of items) {
          if (cur === '') cur = item;
          else if (inner.length + cur.length + 2 + item.length + 1 <= FORMAT_WIDTH) cur += ', ' + item;
          else { lines.push(cur); cur = item; }
        }
        lines.push(cur);
        return '[\n' + lines.map(l => inner + l).join(',\n') + '\n' + indent + ']';
      }
      return '[\n' + v.map(x => inner + fmt(x, inner)).join(',\n') + '\n' + indent + ']';
    }
    const keys = Object.keys(v);
    if (keys.length === 0) return '{}';
    if (keys.every(k => isScalar(v[k]))) {
      const inline = '{' + keys.map(k => JSON.stringify(k) + ': ' + formatScalar(v[k])).join(', ') + '}';
      if (indent.length + inline.length <= FORMAT_WIDTH) return inline;
    }
    return '{\n' + keys.map(k => inner + JSON.stringify(k) + ': ' + fmt(v[k], inner)).join(',\n') + '\n' + indent + '}';
  };
  return fmt(value, '') + '\n';
}

/* ============================================================
   RATES DOCUMENT: FRESHNESS
   ============================================================ */
function daysBetween(fromDateStr, today) {
  const from = Date.parse(fromDateStr + 'T00:00:00Z');
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.floor((t - from) / 86400000);
}

/** Is this rates document stale as of `today` (a Date)? */
function ratesFreshness(rates, today = new Date()) {
  const reasons = [];
  const daysSinceCheck = daysBetween(rates.lastChecked, today);
  const currentYear = today.getUTCFullYear();
  if (currentYear > rates.taxYear) reasons.push('newTaxYear');
  if (daysSinceCheck > STALE_AFTER_DAYS) reasons.push('notCheckedRecently');
  return { stale: reasons.length > 0, reasons, daysSinceCheck, currentYear };
}

/** True when `candidate` carries newer figures than `current`. */
function isNewerRates(candidate, current) {
  if (!candidate || !current) return false;
  if (candidate.taxYear !== current.taxYear) return candidate.taxYear > current.taxYear;
  return candidate.lastUpdated > current.lastUpdated;
}

/** Items whose figures are older than the document's tax year. */
function laggingItems(rates) {
  return REQUIRED_ITEMS.filter(k => rates.items[k].effectiveYear < rates.taxYear)
    .map(k => ({ key: k, label: rates.items[k].label, effectiveYear: rates.items[k].effectiveYear }));
}

/* ============================================================
   COMPILE: rates document -> calculation-ready tax data ("td")
   ============================================================ */
function compileTaxData(rates) {
  const problems = validateRates(rates);
  if (problems.length) throw new Error('Invalid rates data: ' + problems.slice(0, 5).join('; '));
  const it = rates.items;
  const toBrackets = (tbl) => {
    const out = {};
    for (const fs of FILING_STATUSES) out[fs] = tbl[fs].map(([r, u]) => [r, u === null ? Infinity : u]);
    return out;
  };
  const year = (k) => it[k].effectiveYear;
  const jlt = it.rmd.value.jointLifeTable || null;
  return {
    rates,
    taxYear: rates.taxYear,
    brackets: toBrackets(it.federalBrackets.value), bracketsYear: year('federalBrackets'),
    capitalGainsBrackets: toBrackets(it.capitalGainsBrackets.value), capitalGainsYear: year('capitalGainsBrackets'),
    standardDeduction: it.standardDeduction.value, standardDeductionYear: year('standardDeduction'),
    additional65: it.additionalStandardDeduction65.value, additional65Year: year('additionalStandardDeduction65'),
    seniorBonus: it.seniorBonusDeduction.value,
    niit: it.niit.value,
    ssTaxation: it.socialSecurityTaxation.value,
    ssClaiming: it.socialSecurityClaiming.value,
    irmaa: it.medicareIrmaa.value, irmaaYear: year('medicareIrmaa'),
    rmd: {
      startAgeByBirthYear: it.rmd.value.startAgeByBirthYear,
      uniform: it.rmd.value.uniformLifetimeTable,
      joint: jlt
    },
    penalties: it.penalties.value,
    states: it.stateIncomeTax.value.states,
    statesYear: year('stateIncomeTax')
  };
}

/* ============================================================
   FEDERAL INCOME TAX
   ============================================================ */
function adjustedBrackets(table, baseYear, filingStatus, year, rate) {
  const base = table[filingStatus] || table.single;
  return base.map(([r, upper]) => [r, indexAmount(upper, baseYear, year, rate)]);
}

const getBrackets = (td, filingStatus, year, rate) => adjustedBrackets(td.brackets, td.bracketsYear, filingStatus, year, rate);
const getCapitalGainsBrackets = (td, filingStatus, year, rate) => adjustedBrackets(td.capitalGainsBrackets, td.capitalGainsYear, filingStatus, year, rate);

/** Progressive tax on ordinary taxable income. */
function ordinaryIncomeTax(taxableIncome, brackets) {
  if (!(taxableIncome > 0)) return 0;
  let tax = 0, lower = 0;
  for (const [rate, upper] of brackets) {
    const inBracket = Math.min(taxableIncome, upper) - lower;
    if (inBracket > 0) tax += inBracket * rate;
    if (taxableIncome <= upper) break;
    lower = upper;
  }
  return tax;
}

/** Rate applied to the next dollar of ordinary taxable income. */
function marginalRate(taxableIncome, brackets) {
  for (const [rate, upper] of brackets) if (taxableIncome < upper) return rate;
  return brackets[brackets.length - 1][0];
}

/** How much of each bracket is filled (for charts / "show the math"). */
function bracketFill(taxableIncome, brackets) {
  const fills = [];
  let lower = 0;
  for (const [rate, upper] of brackets) {
    const filled = Math.max(0, Math.min(taxableIncome, upper) - lower);
    fills.push({ rate, lower, upper: upper === Infinity ? null : upper, filled, tax: filled * rate });
    if (taxableIncome <= upper) break;
    lower = upper;
  }
  return fills;
}

/** Top of the chosen bracket (e.g. 0.24 -> top of the 24% bracket). */
function bracketCeiling(brackets, targetRate) {
  let ceiling = 0;
  for (const [rate, upper] of brackets) if (rate <= targetRate + 1e-9) ceiling = upper;
  return ceiling;
}

/** Standard deduction incl. the extra amount for each person 65+. */
function standardDeduction(td, filingStatus, age, spouseAge, year, rate) {
  const base = indexAmount(td.standardDeduction[filingStatus] || td.standardDeduction.single, td.standardDeductionYear, year, rate);
  const married = filingStatus !== 'single';
  const extra = indexAmount(married ? td.additional65.married : td.additional65.unmarried, td.additional65Year, year, rate);
  let people = age >= 65 ? 1 : 0;
  if (filingStatus === 'marriedFilingJointly' && spouseAge != null && spouseAge >= 65) people++;
  return base + extra * people;
}

/**
 * OBBBA "senior deduction" (IRC §151(f)): $6,000 per person 65+, tax years
 * 2025-2028, reduced by 6% of MAGI above $75K ($150K joint), applied per
 * spouse on a joint return. MFS filers are not eligible. It is allowed
 * whether or not you itemize, but it does NOT reduce AGI.
 */
function seniorBonusDeduction(td, magi, filingStatus, age, spouseAge, year) {
  const sb = td.seniorBonus;
  if (year < sb.firstYear || year > sb.lastYear) return 0;
  if (filingStatus === 'marriedFilingSeparately') return 0;
  let people = age >= 65 ? 1 : 0;
  if (filingStatus === 'marriedFilingJointly' && spouseAge != null && spouseAge >= 65) people++;
  if (people === 0) return 0;
  const start = filingStatus === 'marriedFilingJointly' ? sb.phaseoutStart.marriedFilingJointly : sb.phaseoutStart.single;
  const perPerson = Math.max(0, sb.amountPerPerson - sb.phaseoutRate * Math.max(0, magi - start));
  return perPerson * people;
}

/**
 * Long-term capital gains / qualified dividends tax. Preferential income is
 * stacked on top of ordinary taxable income (IRS Qualified Dividends and
 * Capital Gain Tax Worksheet).
 */
function capitalGainsTax(ordinaryTaxableIncome, preferentialIncome, cgBrackets) {
  if (!(preferentialIncome > 0)) return 0;
  let floor = Math.max(0, ordinaryTaxableIncome);
  let remaining = preferentialIncome;
  let tax = 0;
  for (const [rate, upper] of cgBrackets) {
    if (remaining <= 0) break;
    const room = upper - floor;
    if (room <= 0) continue;
    const taxed = Math.min(remaining, room);
    tax += taxed * rate;
    remaining -= taxed;
    floor += taxed;
  }
  return tax;
}

/** Net Investment Income Tax: 3.8% of lesser of NII or MAGI over threshold (not indexed). */
function netInvestmentIncomeTax(td, magi, netInvestmentIncome, filingStatus) {
  if (!(netInvestmentIncome > 0)) return 0;
  const threshold = td.niit.thresholds[filingStatus] || td.niit.thresholds.single;
  const excess = magi - threshold;
  if (excess <= 0) return 0;
  return td.niit.rate * Math.min(netInvestmentIncome, excess);
}

/**
 * Taxable Social Security (IRS Pub 915 worksheet). Thresholds are fixed by
 * statute and NOT inflation-indexed. `otherIncome` is AGI before Social
 * Security (wages, pensions, IRA distributions, dividends, capital gains...).
 * MFS filers who lived with their spouse have $0 thresholds.
 */
function taxableSocialSecurity(td, ssBenefits, otherIncome, filingStatus) {
  if (!(ssBenefits > 0)) return 0;
  const t = td.ssTaxation[filingStatus] || td.ssTaxation.single;
  const r1 = td.ssTaxation.tier1Rate, r2 = td.ssTaxation.tier2Rate;
  const provisional = Math.max(0, otherIncome) + ssBenefits * 0.5;
  if (provisional <= t.baseAmount) return 0;
  if (provisional <= t.additionalAmount) {
    return Math.min(ssBenefits * r1, (provisional - t.baseAmount) * r1);
  }
  const tier1 = Math.min(ssBenefits * r1, (t.additionalAmount - t.baseAmount) * r1);
  return Math.min(ssBenefits * r2, tier1 + (provisional - t.additionalAmount) * r2);
}

/* ============================================================
   STATE INCOME TAX
   ============================================================ */
const stateFilingStatus = (filingStatus) => filingStatus === 'marriedFilingJointly' ? 'marriedFilingJointly' : 'single';

/**
 * A state's own standard deduction + personal exemptions (subtracted from
 * state income) and personal credits (subtracted from the tax), for one
 * filing status and year. Indexed like the state brackets. Married filing
 * separately uses the single amounts.
 */
function stateAllowances(td, state, filingStatus, year, rate) {
  const fs = stateFilingStatus(filingStatus);
  const idx = (v) => indexAmount(v, td.statesYear, year, rate);
  return {
    deduction: idx(state.standardDeduction[fs] + state.personalExemption[fs]),
    credit: idx(state.personalCredit[fs])
  };
}

/**
 * Retirement income a state leaves out of its income: Roth conversions and
 * pensions when it exempts them, and other IRA/401(k) withdrawals from
 * `iraFromAge` (birthday assumed mid-year, so 59 counts as 59 1/2).
 */
function stateExcludedRetirementIncome(exclusion, p) {
  if (!exclusion) return 0;
  const ira = Math.max(0, p.iraDistributions || 0);
  const conversion = Math.min(ira, Math.max(0, p.rothConversion || 0));
  let excluded = 0;
  if (exclusion.conversions) excluded += conversion;
  if ((p.age || 0) + 0.5 >= exclusion.iraFromAge) excluded += ira - conversion;
  if (exclusion.pensions) excluded += Math.max(0, p.pension || 0);
  return excluded;
}

/**
 * Full federal + state tax for one year.
 * p: { filingStatus, year, age, spouseAge, wages, pension, iraDistributions,
 *      rothConversion (the part of iraDistributions converted to Roth),
 *      hsaTaxable, ssBenefits, dividends, capitalGains, stateRate (percent,
 *      flat) or stateBrackets (progressive, already indexed),
 *      stateTaxesSocialSecurity, stateSsExemptShare (0-1: the part of the
 *      taxable Social Security a state that taxes it still leaves out, e.g.
 *      the benefits of each person past the state's age limit),
 *      stateDeduction and stateCredit (from stateAllowances),
 *      stateRetirementExclusion, bracketInflation (decimal) }
 * State tax: state income = federal AGI, less taxable Social Security in
 * states that exempt it and retirement income the state excludes, minus
 * the state's standard deduction and personal exemptions; personal credits
 * come off the tax. Without state figures (stateDeduction omitted: a flat
 * rate typed with no state picked) the base is federal taxable income less
 * exempt Social Security. Deduction phase-outs, age-based extra state
 * deductions and partial retirement exclusions are not modeled.
 */
function computeYearTax(td, p) {
  const fs = p.filingStatus;
  const infl = p.bracketInflation || 0;
  const ordinaryIncome = (p.wages || 0) + (p.pension || 0) + (p.iraDistributions || 0) + (p.hsaTaxable || 0);
  const preferentialGross = Math.max(0, p.dividends || 0) + Math.max(0, p.capitalGains || 0);
  const incomeBeforeSS = ordinaryIncome + preferentialGross;
  const taxableSS = taxableSocialSecurity(td, p.ssBenefits || 0, incomeBeforeSS, fs);
  const agi = incomeBeforeSS + taxableSS;
  const stdDeduction = standardDeduction(td, fs, p.age, p.spouseAge, p.year, infl);
  const seniorBonus = seniorBonusDeduction(td, agi, fs, p.age, p.spouseAge, p.year);
  const taxableIncome = Math.max(0, agi - stdDeduction - seniorBonus);
  const preferentialIncome = Math.min(preferentialGross, taxableIncome);
  const ordinaryTaxableIncome = taxableIncome - preferentialIncome;
  const brackets = getBrackets(td, fs, p.year, infl);
  const cgBrackets = getCapitalGainsBrackets(td, fs, p.year, infl);
  const federalTax = ordinaryIncomeTax(ordinaryTaxableIncome, brackets);
  const cgTax = capitalGainsTax(ordinaryTaxableIncome, preferentialIncome, cgBrackets);
  const niit = netInvestmentIncomeTax(td, agi, preferentialGross, fs);
  const exemptSS = p.stateTaxesSocialSecurity ? taxableSS * Math.min(1, Math.max(0, p.stateSsExemptShare || 0)) : taxableSS;
  const hasStateFigures = p.stateDeduction != null;
  const stateExcludedRetirement = hasStateFigures ? Math.min(agi - exemptSS, stateExcludedRetirementIncome(p.stateRetirementExclusion, p)) : 0;
  const stateIncome = hasStateFigures ? Math.max(0, agi - exemptSS - stateExcludedRetirement) : Math.max(0, taxableIncome - exemptSS);
  const stateDeduction = hasStateFigures ? Math.max(0, p.stateDeduction) : 0;
  const stateTaxableIncome = Math.max(0, stateIncome - stateDeduction);
  const stateCredit = hasStateFigures ? Math.max(0, p.stateCredit || 0) : 0;
  const stateTaxBeforeCredit = p.stateBrackets
    ? ordinaryIncomeTax(stateTaxableIncome, p.stateBrackets.map(([r, u]) => [r, u === null ? Infinity : u]))
    : stateTaxableIncome * ((p.stateRate || 0) / 100);
  const stateTax = Math.max(0, stateTaxBeforeCredit - stateCredit);
  return {
    ordinaryIncome, preferentialGross, incomeBeforeSS, taxableSS, agi, magi: agi,
    stdDeduction, seniorBonus, taxableIncome, preferentialIncome, ordinaryTaxableIncome,
    brackets, cgBrackets, federalTax, cgTax, niit,
    stateIncome, stateExcludedRetirement, stateDeduction, stateTaxableIncome, stateCredit, stateTax,
    marginalRate: marginalRate(ordinaryTaxableIncome, brackets),
    bracketFill: bracketFill(ordinaryTaxableIncome, brackets),
    incomeTax: federalTax + cgTax + niit + stateTax
  };
}

/* ============================================================
   MEDICARE IRMAA
   ============================================================ */
/**
 * Annual IRMAA surcharge for `premiumYear`, based on MAGI from
 * premiumYear - lookbackYears. Surcharge = (Part B total - standard Part B)
 * + Part D adjustment, per person on Medicare. Thresholds are indexed with
 * bracketInflation, premiums with premiumInflation.
 */
function irmaaSurcharge(td, magi, filingStatus, premiumYear, bracketInflation, premiumInflation, people) {
  const tiers = td.irmaa.tiers[filingStatus] || td.irmaa.tiers.single;
  if (!(people > 0)) return { annual: 0, tier: 0, tierLabel: 'None' };
  for (let i = tiers.length - 1; i >= 0; i--) {
    const threshold = indexAmount(tiers[i].magiOver, td.irmaaYear, premiumYear, bracketInflation);
    if (magi > threshold) {
      const monthly = (tiers[i].partBTotal - td.irmaa.partBStandardPremium) + tiers[i].partD;
      const annual = indexAmount(monthly * 12, td.irmaaYear, premiumYear, premiumInflation) * people;
      return { annual, tier: i + 1, tierLabel: `Tier ${i + 1}` };
    }
  }
  return { annual: 0, tier: 0, tierLabel: 'None' };
}

/** IRMAA MAGI thresholds for a premium year (ascending). */
function irmaaThresholds(td, filingStatus, premiumYear, bracketInflation) {
  const tiers = td.irmaa.tiers[filingStatus] || td.irmaa.tiers.single;
  return tiers.map(t => indexAmount(t.magiOver, td.irmaaYear, premiumYear, bracketInflation));
}

/* ============================================================
   REQUIRED MINIMUM DISTRIBUTIONS
   ============================================================ */
/** SECURE 2.0: 72 (born <=1950), 73 (1951-1959), 75 (1960+). */
function rmdStartAge(td, birthYear) {
  for (const row of td.rmd.startAgeByBirthYear) {
    if (row.bornThrough === null || birthYear <= row.bornThrough) return row.age;
  }
  return 75;
}

function rmdDivisor(td, age, spouseAge) {
  const a = Math.min(120, Math.max(72, age));
  const jlt = td.rmd.joint;
  if (jlt && spouseAge != null && age - spouseAge > 10) {
    const row = jlt.rows[String(age)];
    const idx = spouseAge - jlt.minBeneficiaryAge;
    if (row && idx >= 0 && idx < row.length) return row[idx];
    if (row && idx < 0) return row[0];
  }
  return td.rmd.uniform[String(a)] || td.rmd.uniform['120'];
}

/**
 * RMD for the year the owner reaches `age`, from the prior year-end balance.
 * spouseAge: pass only when the spouse is alive and sole beneficiary (the
 * Joint Life table applies when they are more than 10 years younger).
 */
function requiredMinimumDistribution(td, age, birthYear, priorYearEndBalance, spouseAge) {
  if (age < rmdStartAge(td, birthYear) || !(priorYearEndBalance > 0)) return 0;
  return priorYearEndBalance / rmdDivisor(td, age, spouseAge);
}

/* ============================================================
   SOCIAL SECURITY CLAIMING
   ============================================================ */
function fullRetirementAgeMonths(td, birthYear) {
  for (const row of td.ssClaiming.fullRetirementAge) {
    if (row.bornThrough === null || birthYear <= row.bornThrough) return row.years * 12 + row.months;
  }
  return 67 * 12;
}

/** Benefit multiplier for claiming at `claimAge` vs. full retirement age. */
function ssClaimingFactor(td, birthYear, claimAge) {
  const c = td.ssClaiming;
  const fra = fullRetirementAgeMonths(td, birthYear);
  const claim = Math.min(c.maxCreditAge, Math.max(c.earliestClaimAge, claimAge)) * 12;
  if (claim < fra) {
    const early = fra - claim;
    return 1 - Math.min(early, 36) * (c.earlyReductionFirst36Months / 36)
             - Math.max(0, early - 36) * (c.earlyReductionPerYearBeyond36 / 12);
  }
  const late = Math.min(claim, c.maxCreditAge * 12) - fra;
  return 1 + Math.max(0, late) * (c.delayedCreditPerYear / 12);
}

/* ============================================================
   INPUT NORMALIZATION & VALIDATION
   ============================================================ */
const toNum = (v) => {
  if (v === '' || v === null || v === undefined) return NaN;
  const n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? n : NaN;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const orDefault = (v, d) => (isNaN(v) ? d : v);

/**
 * Turn raw form inputs (strings/blank allowed) into clean numbers.
 * Never throws; out-of-range values are clamped. Use validateInputs() to
 * tell the user about problems before calculating.
 */
function normalizeInputs(raw, td) {
  const r = raw || {};
  const currentAge = clamp(Math.round(orDefault(toNum(r.currentAge), 60)), 18, 110);
  const filingStatus = FILING_STATUSES.includes(r.filingStatus) ? r.filingStatus : 'single';
  const isMFJ = filingStatus === 'marriedFilingJointly';
  const spouseAgeNum = toNum(r.spouseAge);
  const contrib = r.annualContributions || {};
  const money = (v, max = 1e8) => clamp(orDefault(toNum(v), 0), 0, max);
  const pct = (v, d, lo, hi) => clamp(orDefault(toNum(v), d), lo, hi);
  const taxableBalance = money(r.taxableBalance);
  const basisRaw = toNum(r.taxableCostBasis);
  const state = td && td.states ? td.states.find(s => s.abbr === r.stateAbbr) : null;
  /* An explicit override wins; older saved profiles only had stateTaxRate,
     which we honor as an override when no state was picked. */
  let override = toNum(r.stateTaxRateOverride);
  if (isNaN(override) && !state && r.stateTaxRateOverride === undefined) override = toNum(r.stateTaxRate);
  const stateMode = !isNaN(override) ? 'flat' : state ? 'brackets' : 'none';
  const spouseAge = isMFJ && !isNaN(spouseAgeNum) ? clamp(Math.round(spouseAgeNum), 18, 110) : null;
  /* A start age below the current age means the benefit is already being
     paid: the amount entered is what arrives now, already adjusted for the
     claiming age. Otherwise it is the full-retirement-age amount. */
  const ssStartAge = clamp(Math.round(orDefault(toNum(r.ssStartAge), 67)), 62, 70);
  const spouseSsStartAge = clamp(Math.round(orDefault(toNum(r.spouseSsStartAge), 67)), 62, 70);
  return {
    currentAge,
    retirementAge: clamp(Math.round(orDefault(toNum(r.retirementAge), currentAge)), 18, 110),
    lifeExpectancy: clamp(Math.round(orDefault(toNum(r.lifeExpectancy), 90)), currentAge + 1, 120),
    filingStatus,
    spouseAge,
    spouseLifeExpectancy: clamp(Math.round(orDefault(toNum(r.spouseLifeExpectancy), 90)), 19, 120),
    stateAbbr: state ? state.abbr : '--',
    stateMode,
    stateTaxRate: stateMode === 'flat' ? clamp(override, 0, 20) : stateMode === 'brackets' ? state.rate : 0,
    stateBrackets: stateMode === 'brackets' ? state.brackets : null,
    stateTaxesSocialSecurity: state ? state.taxesSocialSecurity : false,
    state: state || null,
    traditionalBalance: money(r.traditionalBalance),
    rothBalance: money(r.rothBalance),
    taxableBalance,
    taxableCostBasis: isNaN(basisRaw) ? taxableBalance : clamp(basisRaw, 0, taxableBalance),
    hsaBalance: money(r.hsaBalance),
    annualContributions: {
      traditional: money(contrib.traditional, 1e6),
      roth: money(contrib.roth, 1e6),
      taxable: money(contrib.taxable, 1e6),
      hsa: money(contrib.hsa, 1e6)
    },
    grossIncome: money(r.grossIncome, 1e8),
    ssAnnualBenefit: money(r.ssAnnualBenefit, 1e6),
    ssStartAge,
    ssAlreadyCollecting: ssStartAge < currentAge,
    spouseSsBenefit: isMFJ ? money(r.spouseSsBenefit, 1e6) : 0,
    spouseSsStartAge,
    spouseSsAlreadyCollecting: spouseAge !== null && spouseSsStartAge < spouseAge,
    pensionIncome: money(r.pensionIncome, 1e7),
    annualSpending: money(r.annualSpending, 1e7),
    preRetirementGrowth: pct(r.preRetirementGrowth, 6, -10, 30),
    rothGrowth: pct(r.rothGrowth, orDefault(toNum(r.preRetirementGrowth), 6), -10, 30),
    taxableGrowth: pct(r.taxableGrowth, orDefault(toNum(r.preRetirementGrowth), 6), -10, 30),
    dividendYield: pct(r.dividendYield, 0, 0, 10),
    inflationRate: pct(r.inflationRate, 2.5, 0, 15),
    bracketInflation: pct(r.bracketInflation, 2.5, 0, 15),
    heirTaxRate: pct(r.heirTaxRate, 24, 0, 60)
  };
}

/**
 * Check raw form inputs. Returns { errors, warnings }, each an array of
 * { field, message } in plain English. Errors block calculation.
 */
function validateInputs(raw) {
  const r = raw || {};
  const errors = [], warnings = [];
  const E = (field, message) => errors.push({ field, message });
  const W = (field, message) => warnings.push({ field, message });
  const blank = (v) => v === '' || v === null || v === undefined;
  const num = (field, label, { required = false, min = -Infinity, max = Infinity, integer = false } = {}) => {
    const v = r[field];
    if (blank(v)) { if (required) E(field, `Please enter your ${label}.`); return NaN; }
    const n = Number(v);
    if (!isFinite(n)) { E(field, `${label[0].toUpperCase() + label.slice(1)} must be a number.`); return NaN; }
    if (n < min || n > max) { E(field, `${label[0].toUpperCase() + label.slice(1)} must be between ${min.toLocaleString('en-US')} and ${max.toLocaleString('en-US')}.`); return NaN; }
    if (integer && !Number.isInteger(n)) W(field, `${label[0].toUpperCase() + label.slice(1)} will be rounded to a whole number.`);
    return n;
  };
  const age = num('currentAge', 'current age', { required: true, min: 18, max: 100, integer: true });
  const ret = num('retirementAge', 'retirement age', { min: 18, max: 100, integer: true });
  const le = num('lifeExpectancy', 'life expectancy', { min: 19, max: 120, integer: true });
  num('annualSpending', 'yearly spending in retirement', { required: true, min: 0, max: 1e7 });
  for (const [f, label] of [['traditionalBalance', 'traditional IRA/401(k) balance'], ['rothBalance', 'Roth balance'],
    ['taxableBalance', 'taxable account balance'], ['taxableCostBasis', 'taxable cost basis'], ['hsaBalance', 'HSA balance']]) {
    num(f, label, { min: 0, max: 1e8 });
  }
  for (const [f, label] of [['grossIncome', 'current income'], ['ssAnnualBenefit', 'Social Security benefit'],
    ['pensionIncome', 'pension income'], ['customConversion', 'custom conversion amount']]) {
    num(f, label, { min: 0, max: 1e8 });
  }
  const contrib = r.annualContributions || {};
  for (const k of ['traditional', 'roth', 'taxable', 'hsa']) {
    const v = contrib[k];
    if (!blank(v) && (!isFinite(Number(v)) || Number(v) < 0)) E(`annualContributions.${k}`, 'Contributions must be zero or more.');
  }
  num('ssStartAge', 'Social Security start age', { min: 62, max: 70, integer: true });
  num('stateTaxRateOverride', 'state tax rate', { min: 0, max: 20 });
  num('preRetirementGrowth', 'growth rate', { min: -10, max: 30 });
  num('rothGrowth', 'Roth growth rate', { min: -10, max: 30 });
  num('taxableGrowth', 'taxable growth rate', { min: -10, max: 30 });
  num('dividendYield', 'dividend yield', { min: 0, max: 10 });
  num('inflationRate', 'inflation rate', { min: 0, max: 15 });
  num('bracketInflation', 'bracket inflation rate', { min: 0, max: 15 });
  num('heirTaxRate', "heirs' tax rate", { min: 0, max: 60 });

  if (isFinite(age) && isFinite(le) && le <= age) E('lifeExpectancy', 'Life expectancy must be higher than your current age.');
  if (isFinite(age) && isFinite(ret) && ret < age) W('retirementAge', 'Retirement age is before your current age — we’ll treat you as already retired.');
  const basis = Number(r.taxableCostBasis), bal = Number(r.taxableBalance) || 0;
  if (!blank(r.taxableCostBasis) && isFinite(basis) && basis > bal) {
    W('taxableCostBasis', 'Cost basis is higher than the account balance; we’ll use the balance instead.');
  }
  if (r.filingStatus === 'marriedFilingJointly') {
    const sAge = num('spouseAge', "spouse's age", { required: true, min: 18, max: 110, integer: true });
    const sLe = num('spouseLifeExpectancy', "spouse's life expectancy", { min: 19, max: 120, integer: true });
    num('spouseSsBenefit', "spouse's Social Security benefit", { min: 0, max: 1e8 });
    num('spouseSsStartAge', "spouse's Social Security start age", { min: 62, max: 70, integer: true });
    if (isFinite(sAge) && isFinite(sLe) && sLe <= sAge) E('spouseLifeExpectancy', "Spouse's life expectancy must be higher than their current age.");
    if (isFinite(age) && isFinite(le) && isFinite(sAge) && isFinite(sLe) && (le - age) < (sLe - sAge)) {
      W('lifeExpectancy', 'This model assumes you outlive your spouse. Because your spouse is expected to live longer, the projection keeps you alive until your spouse’s life expectancy.');
    }
  }
  return { errors, warnings };
}

/* ============================================================
   PROJECTION ENGINE
   ============================================================ */
/**
 * Year-by-year simulation of one strategy.
 * @param rawInputs form inputs
 * @param scenario 'noConversion' | 'optimized' | 'custom'
 * @param opts { targetBracketRate, customConversion, taxPaymentSource
 *               ('taxable'|'conversion'), irmaaMode ('ignore'|'avoid'), startYear }
 * @param td compiled tax data
 */
function runProjection(rawInputs, scenario, opts, td) {
  const o = opts || {};
  const inp = normalizeInputs(rawInputs, td);
  const startYear = o.startYear || new Date().getFullYear();
  const targetBracketRate = o.targetBracketRate != null ? o.targetBracketRate : 0.24;
  const customConversion = Math.max(0, Number(o.customConversion) || 0);
  const payFromConversion = o.taxPaymentSource === 'conversion';
  const irmaaMode = o.irmaaMode === 'avoid' ? 'avoid' : 'ignore';

  const infl = inp.inflationRate / 100;
  const bInfl = inp.bracketInflation / 100;
  const pen = td.penalties;
  const startedMFJ = inp.filingStatus === 'marriedFilingJointly' && inp.spouseAge !== null;
  const birthYear = startYear - inp.currentAge;
  const spouseBirthYear = inp.spouseAge !== null ? startYear - inp.spouseAge : null;
  const ownSsFactor = inp.ssAlreadyCollecting ? 1 : ssClaimingFactor(td, birthYear, inp.ssStartAge);
  const spouseSsFactor = spouseBirthYear !== null && !inp.spouseSsAlreadyCollecting
    ? ssClaimingFactor(td, spouseBirthYear, inp.spouseSsStartAge) : 1;
  const lastAge = startedMFJ
    ? Math.max(inp.lifeExpectancy, inp.spouseLifeExpectancy + (inp.currentAge - inp.spouseAge))
    : inp.lifeExpectancy;
  const earlyPenaltyApplies = (age) => age + 0.5 < pen.earlyDistributionAge; /* birthday assumed mid-year */

  let filingStatus = inp.filingStatus;
  let tradBal = inp.traditionalBalance;
  let rothBal = inp.rothBalance;
  let taxBal = inp.taxableBalance;
  let taxBasis = inp.taxableCostBasis;
  let hsaBal = inp.hsaBalance;
  let cumulativeTax = 0;
  let cumulativeUnmet = 0;
  const magiHistory = [];
  const results = [];

  /* Roth layers (IRS ordering): contributions, then conversions FIFO, then earnings.
     Money already in the Roth at the start is treated as seasoned contributions. */
  let rothContributions = inp.rothBalance;
  let conversionLayers = [];

  function withdrawRoth(layers, amount, available, year, age) {
    let remaining = Math.min(Math.max(0, amount), Math.max(0, available));
    const withdrawn = remaining;
    let penalty = 0;
    const penaltyAge = earlyPenaltyApplies(age);
    const fromContrib = Math.min(remaining, layers.contributions);
    layers.contributions -= fromContrib;
    remaining -= fromContrib;
    for (const conv of layers.conversions) {
      if (remaining <= 0) break;
      const draw = Math.min(remaining, conv.remaining);
      conv.remaining -= draw;
      remaining -= draw;
      if (penaltyAge && (year - conv.year) < pen.rothConversionSeasoningYears) penalty += draw * pen.earlyDistributionRate;
    }
    if (remaining > 0 && penaltyAge) penalty += remaining * pen.earlyDistributionRate; /* earnings */
    return { withdrawn, penalty };
  }

  for (let k = 0; k <= lastAge - inp.currentAge; k++) {
    const year = startYear + k;
    const age = inp.currentAge + k;
    const sAge = inp.spouseAge !== null ? inp.spouseAge + k : null;
    const spouseAlive = startedMFJ && sAge <= inp.spouseLifeExpectancy;
    if (startedMFJ && !spouseAlive) filingStatus = 'single';
    const isMFJ = filingStatus === 'marriedFilingJointly';
    const spouseForTax = isMFJ ? sAge : null;
    const working = age < inp.retirementAge;

    /* 1. RMD from last year's ending balance */
    const rmd = requiredMinimumDistribution(td, age, birthYear, tradBal, spouseAlive ? sAge : null);

    /* 2. Growth. The growth rate is a total return for every account; in the
       taxable account the dividend part is paid out (taxed this year) and
       reinvested, so it also adds to cost basis. */
    const dividends = taxBal * Math.min(inp.dividendYield, Math.max(0, inp.taxableGrowth)) / 100;
    tradBal *= 1 + inp.preRetirementGrowth / 100;
    rothBal *= 1 + inp.rothGrowth / 100;
    taxBal *= 1 + inp.taxableGrowth / 100;
    taxBasis += dividends;
    hsaBal *= 1 + inp.preRetirementGrowth / 100;

    /* 3. Contributions while working (traditional + HSA are pre-tax) */
    let pretax = 0;
    if (working) {
      const c = inp.annualContributions;
      tradBal += c.traditional;
      rothBal += c.roth;
      rothContributions += c.roth;
      taxBal += c.taxable;
      taxBasis += c.taxable;
      hsaBal += c.hsa;
      pretax = c.traditional + c.hsa;
    }

    /* 5. Income */
    const salary = working ? inp.grossIncome : 0;
    const wages = Math.max(0, salary - pretax);
    const pension = working ? 0 : indexAmount(inp.pensionIncome, startYear, year, infl);
    const growth = Math.pow(1 + infl, k);
    let ownSs = age >= inp.ssStartAge ? inp.ssAnnualBenefit * ownSsFactor * growth : 0;
    let spouseSs = 0;
    if (startedMFJ) {
      const spouseBenefit = inp.spouseSsBenefit * spouseSsFactor * growth;
      if (spouseAlive) {
        if (sAge >= inp.spouseSsStartAge) spouseSs = spouseBenefit;
      } else if (age >= inp.ssStartAge && inp.spouseLifeExpectancy >= inp.spouseSsStartAge) {
        ownSs = Math.max(ownSs, spouseBenefit); /* survivor keeps the larger benefit */
      }
    }
    const ssIncome = ownSs + spouseSs;
    /* A state that taxes Social Security but leaves out each person's benefits
       from an age (Colorado, 65): the share of this year's benefits that is out. */
    const ssExemptAge = inp.state && inp.state.socialSecurityExemption ? inp.state.socialSecurityExemption.fromAge : null;
    const ssExemptShare = ssExemptAge === null || !(ssIncome > 0) ? 0
      : ((age >= ssExemptAge ? ownSs : 0) + (spouseAlive && sAge >= ssExemptAge ? spouseSs : 0)) / ssIncome;

    /* 6. IRMAA for this year (MAGI from two years ago) */
    const medicarePeople = (age >= 65 ? 1 : 0) + (isMFJ && sAge >= 65 ? 1 : 0);
    const lookback = td.irmaa.lookbackYears;
    const spendingTarget = working ? 0 : indexAmount(inp.annualSpending, startYear, year, infl);
    const tradAvailable = Math.max(0, tradBal - rmd);
    const stateBrackets = inp.stateBrackets
      ? adjustedBrackets(inp.stateBrackets, td.statesYear, stateFilingStatus(filingStatus), year, bInfl)
      : null;
    const stateAllow = inp.state ? stateAllowances(td, inp.state, filingStatus, year, bInfl) : null;

    const taxParams = (conv, w) => ({
      filingStatus, year, age, spouseAge: spouseForTax,
      wages, pension, iraDistributions: rmd + conv + w.fromTrad, rothConversion: conv, hsaTaxable: w.fromHSA,
      ssBenefits: ssIncome, dividends, capitalGains: w.gains,
      stateRate: inp.stateTaxRate, stateBrackets, stateTaxesSocialSecurity: inp.stateTaxesSocialSecurity, stateSsExemptShare: ssExemptShare,
      stateDeduction: stateAllow ? stateAllow.deduction : null, stateCredit: stateAllow ? stateAllow.credit : 0,
      stateRetirementExclusion: inp.state ? inp.state.retirementExclusion : null,
      bracketInflation: bInfl
    });

    /* IRMAA: two-year lookback. The thresholds are those of the filing
       status on the return SSA looks at (a surviving spouse is judged on the
       joint return for two years). Before history exists, this year's income
       without this year's conversion is the stand-in. */
    const irmaaFor = (w) => {
      if (medicarePeople <= 0) return { magi: null, surcharge: { annual: 0, tier: 0, tierLabel: 'None' } };
      const past = magiHistory.length >= lookback ? magiHistory[magiHistory.length - lookback] : null;
      const magi = past ? past.magi : computeYearTax(td, taxParams(0, w)).magi;
      const status = past ? past.filingStatus : filingStatus;
      return { magi, surcharge: irmaaSurcharge(td, magi, status, year, bInfl, infl, medicarePeople) };
    };

    /* No-conversion baseline: once withdrawals are penalty-free, spend the
       traditional account before the Roth (the usual order). Conversion plans
       fill the bracket with the conversion, so they spend the Roth first. */
    const tradBeforeRoth = scenario === 'noConversion' && !earlyPenaltyApplies(age);

    /* 7. Cash flow for a given conversion: spending + taxes, drawn from the
       accounts in order. Iterated to a fixed point because withdrawals create
       taxable income, which changes the tax. With the conversion held fixed
       the iteration is monotone (more tax -> more withdrawals -> more tax),
       so it converges in a few steps. */
    const settle = (conv) => {
      let w = { fromTaxable: 0, gains: 0, basisOut: 0, fromRoth: 0, fromTrad: 0, fromHSA: 0 };
      let tax, irmaa = { annual: 0, tier: 0, tierLabel: 'None' }, irmaaMagi = null;
      let rothPenalty = 0, tradPenalty = 0, hsaPenalty = 0, withholdPenalty = 0, taxFromConversion = 0;
      let unmet = 0, surplus = 0, layers = null;

      for (let iter = 0; iter < 60; iter++) {
        tax = computeYearTax(td, taxParams(conv, w));
        const ir = irmaaFor(w);
        irmaa = ir.surcharge; irmaaMagi = ir.magi;
        tradPenalty = earlyPenaltyApplies(age) ? w.fromTrad * pen.earlyDistributionRate : 0;
        hsaPenalty = age < pen.hsaPenaltyFreeAge ? w.fromHSA * pen.hsaNonMedicalRate : 0;
        const taxesDue = tax.incomeTax + irmaa.annual + tradPenalty + hsaPenalty + rothPenalty + withholdPenalty;

        if (working) break; /* taxes come out of the paycheck */

        /* Paying tax "from the conversion" = withholding: that slice never
           reaches the Roth and is an early distribution if under 59 1/2. */
        const prevTFC = taxFromConversion;
        taxFromConversion = payFromConversion && conv > 0 ? Math.min(taxesDue, conv) : 0;
        withholdPenalty = earlyPenaltyApplies(age) ? taxFromConversion * pen.earlyDistributionRate : 0;

        const cash = rmd + ssIncome + pension;
        let need = spendingTarget + taxesDue - taxFromConversion - cash;
        surplus = Math.max(0, -need);
        need = Math.max(0, need);

        const prev = w;
        w = { fromTaxable: 0, gains: 0, basisOut: 0, fromRoth: 0, fromTrad: 0, fromHSA: 0 };
        w.fromTaxable = Math.min(need, taxBal);
        if (w.fromTaxable > 0 && taxBal > 0) {
          w.basisOut = w.fromTaxable * Math.min(1, taxBasis / taxBal);
          w.gains = w.fromTaxable - w.basisOut;
        }
        need -= w.fromTaxable;

        const drawTrad = () => {
          w.fromTrad = Math.min(need, Math.max(0, tradAvailable - conv));
          need -= w.fromTrad;
        };
        if (tradBeforeRoth) drawTrad();

        layers = {
          contributions: rothContributions,
          conversions: conversionLayers.map(c => ({ ...c }))
        };
        const convIn = conv - taxFromConversion;
        if (convIn > 0) layers.conversions.push({ year, remaining: convIn });
        const roth = withdrawRoth(layers, need, rothBal + convIn, year, age);
        w.fromRoth = roth.withdrawn;
        rothPenalty = roth.penalty;
        need -= w.fromRoth;

        if (!tradBeforeRoth) drawTrad();
        w.fromHSA = Math.min(need, hsaBal);
        need -= w.fromHSA;
        unmet = need;

        const moved = Math.abs(w.fromTaxable - prev.fromTaxable) + Math.abs(w.fromRoth - prev.fromRoth)
          + Math.abs(w.fromTrad - prev.fromTrad) + Math.abs(w.fromHSA - prev.fromHSA)
          + Math.abs(taxFromConversion - prevTFC);
        if (iter > 0 && moved < 0.5) break;
      }

      /* Final tax with the settled withdrawals */
      tax = computeYearTax(td, taxParams(conv, w));
      tradPenalty = earlyPenaltyApplies(age) ? w.fromTrad * pen.earlyDistributionRate : 0;
      hsaPenalty = age < pen.hsaPenaltyFreeAge ? w.fromHSA * pen.hsaNonMedicalRate : 0;
      return { w, tax, irmaa, irmaaMagi, rothPenalty, tradPenalty, hsaPenalty, withholdPenalty, taxFromConversion, unmet, surplus, layers };
    };

    /* Largest conversion x in [0, max] with f(x) <= limit (f nondecreasing). */
    const solveMax = (f, limit, max) => {
      if (f(0) > limit) return 0;
      if (f(max) <= limit) return max;
      let lo = 0, hi = max;
      for (let i = 0; i < 40 && hi - lo > 0.5; i++) {
        const mid = (lo + hi) / 2;
        if (f(mid) <= limit) lo = mid; else hi = mid;
      }
      return lo;
    };

    /* Fill ordinary taxable income to the top of the target bracket. Each
       trial conversion is settled with its own withdrawals, so the income
       from any IRA spending withdrawals it displaces is accounted for. */
    const optimizedConversion = () => {
      if (tradAvailable <= 0) return 0;
      const ceiling = bracketCeiling(getBrackets(td, filingStatus, year, bInfl), targetBracketRate);
      let conv = solveMax((x) => settle(x).tax.ordinaryTaxableIncome, ceiling, tradAvailable);
      /* Optionally stay under the next Medicare IRMAA threshold (hit 2 years later) */
      const futureMedicare = (age + lookback >= 65) || (isMFJ && sAge + lookback >= 65);
      if (irmaaMode === 'avoid' && conv > 0 && futureMedicare) {
        const magiAt = (x) => settle(x).tax.magi;
        const base = magiAt(0);
        const next = irmaaThresholds(td, filingStatus, year + lookback, bInfl).find(t => t >= base);
        if (next !== undefined && magiAt(conv) > next - IRMAA_CUSHION) {
          conv = Math.min(conv, solveMax(magiAt, next - IRMAA_CUSHION, conv));
        }
      }
      return conv < MIN_CONVERSION ? 0 : conv;
    };

    let conv = 0;
    if (!working && scenario === 'custom') conv = Math.min(indexAmount(customConversion, startYear, year, infl), tradAvailable);
    if (!working && scenario === 'optimized') conv = optimizedConversion();

    const settled = settle(conv);
    const { w, tax, irmaa, irmaaMagi, rothPenalty, tradPenalty, hsaPenalty, withholdPenalty, taxFromConversion, unmet, surplus, layers } = settled;
    const earlyWithdrawalPenalty = tradPenalty + withholdPenalty;
    const totalTax = tax.incomeTax + irmaa.annual + earlyWithdrawalPenalty + hsaPenalty + rothPenalty;
    cumulativeTax += totalTax;
    cumulativeUnmet += unmet;
    magiHistory.push({ magi: tax.magi, filingStatus });

    /* 8. Apply the year's flows */
    tradBal = Math.max(0, tradBal - rmd - conv - w.fromTrad);
    const convIn = conv - taxFromConversion;
    rothBal = Math.max(0, rothBal + convIn - w.fromRoth);
    if (layers) {
      rothContributions = layers.contributions;
      conversionLayers = layers.conversions.filter(c => c.remaining > 0.005);
    } else if (convIn > 0) {
      conversionLayers.push({ year, remaining: convIn });
    }
    taxBal = Math.max(0, taxBal - w.fromTaxable + surplus);
    taxBasis = Math.max(0, Math.min(taxBal, taxBasis - w.basisOut + surplus));
    hsaBal = Math.max(0, hsaBal - w.fromHSA);

    const heir = inp.heirTaxRate / 100;
    const afterTaxEstate = rothBal + taxBal + (tradBal + hsaBal) * (1 - heir);
    results.push({
      year, age, spouseAge: sAge, spouseAlive, filingStatus, working,
      tradBal, rothBal, taxBal, taxBasis, hsaBal,
      salary, wages, pension, ssIncome, taxableSS: tax.taxableSS, rmd,
      conversionAmount: conv, taxFromConversion,
      taxableWithdrawal: w.fromTaxable, rothWithdrawal: w.fromRoth,
      tradWithdrawal: w.fromTrad, hsaWithdrawal: w.fromHSA,
      dividendIncome: dividends, realizedCapGains: w.gains,
      agi: tax.agi, stdDeduction: tax.stdDeduction, seniorBonus: tax.seniorBonus,
      taxableIncome: tax.taxableIncome, ordinaryTaxableIncome: tax.ordinaryTaxableIncome,
      federalTax: tax.federalTax, capGainsTax: tax.cgTax, niit: tax.niit, stateTax: tax.stateTax,
      earlyWithdrawalPenalty, hsaPenalty, rothPenalty,
      irmaaSurcharge: irmaa.annual, irmaaTier: irmaa.tierLabel, irmaaMagi, medicarePeople,
      totalTax, cumulativeTax, marginalRate: tax.marginalRate,
      spendingTarget, unmetSpending: unmet, surplusReinvested: surplus,
      bracketFill: tax.bracketFill, taxDetail: tax,
      totalEstate: tradBal + rothBal + taxBal + hsaBal,
      afterTaxEstate, cumulativeUnmet, netPosition: afterTaxEstate - cumulativeUnmet,
      isConversionYear: conv > 0,
      isRMDYear: rmd > 0
    });
  }
  return results;
}

/* ============================================================
   OPTIMIZER & SUMMARY METRICS
   ============================================================ */
const lastRow = (s) => s[s.length - 1];

/**
 * How good a strategy is: what's left for heirs after tax at the end,
 * minus any spending the plan could not pay for along the way.
 */
function strategyScore(scenario) {
  return lastRow(scenario).netPosition;
}

/**
 * Run the no-conversion baseline and the best conversion strategy.
 * targetBracket: 'auto' (try every bracket) or a rate like 0.24.
 * Each bracket is tried both ignoring and avoiding Medicare IRMAA
 * thresholds; the winner has the highest after-tax estate at the end.
 */
function optimizeStrategy(rawInputs, td, opts) {
  const o = opts || {};
  const base = { taxPaymentSource: o.taxPaymentSource, startYear: o.startYear };
  const scenarioA = runProjection(rawInputs, 'noConversion', base, td);
  const rates = o.targetBracket === 'auto' || o.targetBracket === undefined
    ? TARGET_BRACKETS
    : [Number(o.targetBracket)];
  const candidates = [];
  for (const rate of rates) {
    for (const irmaaMode of ['avoid', 'ignore']) {
      const scen = runProjection(rawInputs, 'optimized', { ...base, targetBracketRate: rate, irmaaMode }, td);
      candidates.push({ rate, irmaaMode, scenario: scen, afterTaxEstate: lastRow(scen).afterTaxEstate, score: strategyScore(scen) });
    }
  }
  let best = candidates[0];
  for (const c of candidates) if (c.score > best.score + 1) best = c;
  const scenarioC = o.customConversion > 0
    ? runProjection(rawInputs, 'custom', { ...base, customConversion: o.customConversion }, td)
    : null;
  return {
    scenarioA,
    scenarioB: best.scenario,
    scenarioC,
    chosen: { rate: best.rate, irmaaMode: best.irmaaMode, auto: rates.length > 1 },
    candidates: candidates.map(({ rate, irmaaMode, afterTaxEstate, score }) => ({ rate, irmaaMode, afterTaxEstate, score })),
    breakevenAge: findBreakevenAge(scenarioA, best.scenario)
  };
}

/**
 * Age from which strategy B's lifetime taxes (cumulative) stay at or below
 * strategy A's for every remaining year, after a stretch where B had paid
 * more (the up-front conversion taxes). null when B never paid more, or
 * still has paid more at the end of the projection.
 */
function findBreakevenAge(scenarioA, scenarioB) {
  const n = Math.min(scenarioA.length, scenarioB.length);
  let lastBehind = -1;
  for (let i = 0; i < n; i++) if (scenarioB[i].cumulativeTax > scenarioA[i].cumulativeTax + 1) lastBehind = i;
  if (lastBehind < 0 || lastBehind === n - 1) return null;
  return scenarioA[lastBehind + 1].age;
}

/** Effective tax rate (% of AGI); 0 when AGI is negligible. */
function effectiveRate(row) {
  if (!row) return null;
  if (row.agi < 1000) return 0;
  return (row.totalTax / row.agi) * 100;
}

/** Plain-English facts about a result, for the default view. */
function summarizePlan(result, inflationRate) {
  const { scenarioA, scenarioB } = result;
  const deflate = (v, i) => v / Math.pow(1 + (inflationRate || 0) / 100, i);
  const convRows = scenarioB.map((r, i) => ({ r, i })).filter(x => x.r.conversionAmount > 0);
  const lastA = lastRow(scenarioA), lastB = lastRow(scenarioB), n = scenarioB.length - 1;
  const gain = deflate(strategyScore(scenarioB) - strategyScore(scenarioA), n);
  const first = convRows[0];
  const extraTaxFirstYear = first ? deflate(first.r.totalTax - scenarioA[first.i].totalTax, first.i) : 0;
  const totalConvertedToday = convRows.reduce((s, x) => s + deflate(x.r.conversionAmount, x.i), 0);
  const runsOut = (s) => { const r = s.find(row => row.unmetSpending > 1); return r ? r.age : null; };
  const rmdStart = (s) => { const r = s.find(row => row.rmd > 0); return r ? { age: r.age, amount: r.rmd, idx: s.indexOf(r) } : null; };
  return {
    worthIt: convRows.length > 0 && gain > 500,
    gainToday: gain,
    conversionYears: convRows.length,
    firstConversion: first ? { year: first.r.year, age: first.r.age, amountToday: deflate(first.r.conversionAmount, first.i), extraTaxToday: extraTaxFirstYear } : null,
    lastConversion: convRows.length ? { year: lastRow(convRows).r.year, age: lastRow(convRows).r.age } : null,
    averageConversionToday: convRows.length ? totalConvertedToday / convRows.length : 0,
    totalConvertedToday,
    lifetimeTaxA: scenarioA.reduce((s, r, i) => s + deflate(r.totalTax, i), 0),
    lifetimeTaxB: scenarioB.reduce((s, r, i) => s + deflate(r.totalTax, i), 0),
    irmaaYearsA: scenarioA.filter(r => r.irmaaSurcharge > 0).length,
    irmaaYearsB: scenarioB.filter(r => r.irmaaSurcharge > 0).length,
    penaltyTotalB: scenarioB.reduce((s, r, i) => s + deflate(r.rothPenalty + r.earlyWithdrawalPenalty + r.hsaPenalty, i), 0),
    runsOutAgeA: runsOut(scenarioA),
    runsOutAgeB: runsOut(scenarioB),
    rmdStartA: rmdStart(scenarioA),
    rmdStartB: rmdStart(scenarioB),
    finalAge: lastB.age,
    breakevenAge: result.breakevenAge
  };
}

return {
  FILING_STATUSES, REQUIRED_ITEMS, TARGET_BRACKETS, RATES_SCHEMA_VERSION, STALE_AFTER_DAYS,
  indexAmount, validateRates, formatRatesJson, ratesFreshness, isNewerRates, laggingItems, compileTaxData,
  getBrackets, getCapitalGainsBrackets, ordinaryIncomeTax, marginalRate, bracketFill, bracketCeiling,
  standardDeduction, seniorBonusDeduction, capitalGainsTax, netInvestmentIncomeTax,
  taxableSocialSecurity, stateAllowances, computeYearTax, irmaaSurcharge, irmaaThresholds,
  rmdStartAge, rmdDivisor, requiredMinimumDistribution, fullRetirementAgeMonths, ssClaimingFactor,
  normalizeInputs, validateInputs, runProjection, optimizeStrategy, strategyScore, findBreakevenAge, effectiveRate,
  summarizePlan
};
});

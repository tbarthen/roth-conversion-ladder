/* Shared test fixtures. */
const fs = require('fs');
const path = require('path');
const E = require('../js/tax-engine.js');

const ROOT = path.join(__dirname, '..');
const RATES_PATH = path.join(ROOT, 'data', 'rates.json');

const loadRates = () => JSON.parse(fs.readFileSync(RATES_PATH, 'utf8'));
const td = E.compileTaxData(loadRates());

/** Deep copy so tests can mutate freely. */
const clone = (o) => JSON.parse(JSON.stringify(o));

/** A plain early retiree used by several projection tests. */
const baseInputs = (over = {}) => ({
  currentAge: 60, retirementAge: 60, lifeExpectancy: 90,
  filingStatus: 'single', stateAbbr: '--',
  traditionalBalance: 800000, rothBalance: 50000, taxableBalance: 200000,
  taxableCostBasis: 150000, hsaBalance: 0,
  annualContributions: { traditional: 0, roth: 0, taxable: 0, hsa: 0 },
  grossIncome: 0, ssAnnualBenefit: 30000, ssStartAge: 67,
  pensionIncome: 0, annualSpending: 60000,
  preRetirementGrowth: 5, rothGrowth: 5, taxableGrowth: 5, dividendYield: 0,
  inflationRate: 2, bracketInflation: 2, heirTaxRate: 24,
  ...over
});

const near = (assert, actual, expected, tol = 0.01, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || ''} expected ${expected}, got ${actual}`);

module.exports = { E, td, loadRates, clone, baseInputs, near, ROOT, RATES_PATH };

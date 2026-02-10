#!/usr/bin/env node
/**
 * update-state-tax-rates.js
 *
 * Updates state tax rate data for the Roth Conversion Ladder Optimizer.
 *
 * Usage:
 *   node scripts/update-state-tax-rates.js
 *
 * How it works:
 *   1. Reads rates from scripts/rates.json (you edit this with new data)
 *   2. Validates the data
 *   3. Copies to data/rates.json (served by GitHub Pages, fetched by the app)
 *   4. Updates the embedded fallback in index.html (for offline/local use)
 *
 * Workflow (once a year, typically January/February):
 *   1. Check Tax Foundation for new rates:
 *      https://taxfoundation.org/data/all/state/state-income-tax-rates/
 *   2. Update scripts/rates.json with any changed values
 *   3. Run: node scripts/update-state-tax-rates.js
 *   4. Commit and push — the app auto-fetches from data/rates.json
 *
 * Or just ask Claude Code:
 *   "Update the state tax rates for 2026"
 */

const fs = require('fs');
const path = require('path');

const SRC_FILE = path.join(__dirname, 'rates.json');
const DEPLOY_FILE = path.join(__dirname, '..', 'data', 'rates.json');
const INDEX_FILE = path.join(__dirname, '..', 'index.html');

// Load and validate
if (!fs.existsSync(SRC_FILE)) {
  console.error(`Error: ${SRC_FILE} not found.`);
  process.exit(1);
}

const rates = JSON.parse(fs.readFileSync(SRC_FILE, 'utf8'));

if (!rates.year || !rates.updated || !Array.isArray(rates.states) || rates.states.length < 50) {
  console.error('Error: rates.json must have { year, updated, states[] } with >= 50 entries.');
  process.exit(1);
}

for (const s of rates.states) {
  if (!s.abbr || !s.name || s.rate === undefined) {
    console.error(`Error: invalid entry: ${JSON.stringify(s)}`);
    process.exit(1);
  }
}

// 1. Copy to data/rates.json (runtime source for the app)
fs.mkdirSync(path.dirname(DEPLOY_FILE), { recursive: true });
fs.copyFileSync(SRC_FILE, DEPLOY_FILE);
console.log(`Copied to ${DEPLOY_FILE}`);

// 2. Update embedded fallback in index.html
let html = fs.readFileSync(INDEX_FILE, 'utf8');

const lines = rates.states.map(s => {
  const rateStr = Number.isInteger(s.rate) ? s.rate + '.0' : String(s.rate);
  return `  { abbr: "${s.abbr}", name: "${s.name}", rate: ${rateStr} }`;
});

const newBlock = `let STATE_TAX_RATES = [
  { abbr: "--", name: "-- Select State --", rate: 0 },
${lines.join(',\n')}
];`;

html = html.replace(/let STATE_TAX_RATES = \[[\s\S]*?\];/, newBlock);
html = html.replace(/let RATES_LAST_UPDATED = ".*?";/, `let RATES_LAST_UPDATED = "${rates.updated}";`);
html = html.replace(/let RATES_TAX_YEAR = \d+;/, `let RATES_TAX_YEAR = ${rates.year};`);

fs.writeFileSync(INDEX_FILE, html);

console.log(`Updated index.html fallback with ${rates.states.length} states.`);
console.log(`  Tax year: ${rates.year}`);
console.log(`  Last updated: ${rates.updated}`);
console.log(`\nCommit and push to deploy.`);

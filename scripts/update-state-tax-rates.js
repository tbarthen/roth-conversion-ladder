#!/usr/bin/env node
/**
 * update-state-tax-rates.js
 *
 * Utility to refresh the STATE_TAX_RATES array in index.html.
 *
 * Usage:
 *   node scripts/update-state-tax-rates.js
 *
 * How it works:
 *   1. Reads rates from rates.json (you update that file with new data)
 *   2. Patches the STATE_TAX_RATES block and RATES_LAST_UPDATED in index.html
 *
 * Workflow (once a year, typically January/February):
 *   1. Check Tax Foundation for new rates:
 *      https://taxfoundation.org/data/all/state/state-income-tax-rates/
 *   2. Update scripts/rates.json with any changed values
 *   3. Run: node scripts/update-state-tax-rates.js
 *   4. Commit and push
 *
 * You can also ask Claude Code to do this:
 *   "Update the state tax rates for 2026 — research the latest rates
 *    from Tax Foundation and run the update script."
 */

const fs = require('fs');
const path = require('path');

const RATES_FILE = path.join(__dirname, 'rates.json');
const INDEX_FILE = path.join(__dirname, '..', 'index.html');

// Load rates
if (!fs.existsSync(RATES_FILE)) {
  console.error(`Error: ${RATES_FILE} not found.`);
  console.error('Create it first — see rates.json.example for the format.');
  process.exit(1);
}

const rates = JSON.parse(fs.readFileSync(RATES_FILE, 'utf8'));

// Validate
if (!rates.year || !rates.updated || !Array.isArray(rates.states) || rates.states.length < 50) {
  console.error('Error: rates.json must have { year, updated, states[] } with at least 50 entries.');
  process.exit(1);
}

for (const s of rates.states) {
  if (!s.abbr || !s.name || s.rate === undefined) {
    console.error(`Error: invalid entry — each state needs { abbr, name, rate }: ${JSON.stringify(s)}`);
    process.exit(1);
  }
}

// Build the replacement JS array
const lines = rates.states.map(s => {
  const rateStr = Number.isInteger(s.rate) ? s.rate + '.0' : String(s.rate);
  return `  { abbr: "${s.abbr}", name: "${s.name}", rate: ${rateStr} }`;
});

const newBlock = `const STATE_TAX_RATES = [
  { abbr: "--", name: "-- Select State --", rate: 0 },
${lines.join(',\n')}
];`;

const newDateLine = `const RATES_LAST_UPDATED = "${rates.updated}";`;
const newYearLine = `const RATES_TAX_YEAR = ${rates.year};`;

// Read index.html
let html = fs.readFileSync(INDEX_FILE, 'utf8');

// Replace STATE_TAX_RATES block
const ratesRegex = /const STATE_TAX_RATES = \[[\s\S]*?\];/;
if (!ratesRegex.test(html)) {
  console.error('Error: could not find STATE_TAX_RATES block in index.html');
  process.exit(1);
}
html = html.replace(ratesRegex, newBlock);

// Replace or insert RATES_LAST_UPDATED
if (/const RATES_LAST_UPDATED = /.test(html)) {
  html = html.replace(/const RATES_LAST_UPDATED = ".*?";/, newDateLine);
} else {
  html = html.replace(newBlock, newBlock + '\n' + newDateLine);
}

// Replace or insert RATES_TAX_YEAR
if (/const RATES_TAX_YEAR = /.test(html)) {
  html = html.replace(/const RATES_TAX_YEAR = \d+;/, newYearLine);
} else {
  html = html.replace(newDateLine, newDateLine + '\n' + newYearLine);
}

fs.writeFileSync(INDEX_FILE, html);

console.log(`Updated index.html with ${rates.states.length} state tax rates.`);
console.log(`  Tax year: ${rates.year}`);
console.log(`  Last updated: ${rates.updated}`);
console.log(`\nDon't forget to commit and push!`);

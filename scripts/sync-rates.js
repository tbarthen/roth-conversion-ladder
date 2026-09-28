#!/usr/bin/env node
/**
 * sync-rates.js
 *
 * data/rates.json is the single source of truth for every tax figure the
 * app uses (federal brackets, deductions, IRMAA, RMD tables, Social
 * Security rules, penalties, state rates). This script:
 *   1. validates data/rates.json (same checks the app and fetcher use)
 *   2. rewrites it in canonical format (so diffs stay small)
 *   3. copies it into the embedded fallback block in index.html, used when
 *      the page is opened from disk or data/rates.json can't be fetched
 *
 * Usage:
 *   node scripts/sync-rates.js           # validate + write
 *   node scripts/sync-rates.js --check   # validate + fail if anything is out of sync
 *
 * The monthly Cloud Run fetcher (fetcher/) does the same two writes in a
 * single commit, so you normally never need to run this by hand — only
 * after editing data/rates.json manually.
 */

const fs = require('fs');
const path = require('path');
const { validateRates, formatRatesJson } = require('../js/tax-engine.js');

const RATES_FILE = path.join(__dirname, '..', 'data', 'rates.json');
const INDEX_FILE = path.join(__dirname, '..', 'index.html');
const EMBED_RE = /(<script type="application\/json" id="embedded-rates">)([\s\S]*?)(<\/script>)/;

function embed(html, formatted) {
  if (!EMBED_RE.test(html)) throw new Error('embedded-rates block not found in index.html');
  return html.replace(EMBED_RE, (_, open, _old, close) => `${open}\n${formatted}${close}`);
}

function main() {
  const check = process.argv.includes('--check');
  const raw = fs.readFileSync(RATES_FILE, 'utf8');
  const rates = JSON.parse(raw);
  const problems = validateRates(rates);
  if (problems.length) {
    console.error('data/rates.json is invalid:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  const formatted = formatRatesJson(rates);
  const html = fs.readFileSync(INDEX_FILE, 'utf8');
  const newHtml = embed(html, formatted);

  if (check) {
    const stale = [];
    if (raw !== formatted) stale.push('data/rates.json is not in canonical format');
    if (html !== newHtml) stale.push('index.html embedded fallback differs from data/rates.json');
    if (stale.length) {
      console.error(stale.join('\n') + '\nRun: node scripts/sync-rates.js');
      process.exit(1);
    }
    console.log(`OK: rates for tax year ${rates.taxYear} valid and in sync.`);
    return;
  }
  fs.writeFileSync(RATES_FILE, formatted);
  fs.writeFileSync(INDEX_FILE, newHtml);
  console.log(`Synced tax year ${rates.taxYear} (last checked ${rates.lastChecked}) into index.html.`);
}

if (require.main === module) main();
module.exports = { embed, EMBED_RE };

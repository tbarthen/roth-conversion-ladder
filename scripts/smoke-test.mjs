#!/usr/bin/env node
/**
 * Browser smoke test: loads index.html in headless Chromium, runs a
 * calculation, opens every details tab, and exercises the tax-data banner
 * and "Check now" flows. Fails on any page error or console error.
 *
 * Usage (needs the `playwright` package and a Chromium build):
 *   node scripts/smoke-test.mjs [--cdn-dir <dir>] [--screenshots <dir>]
 *
 * --cdn-dir serves the unpkg.com scripts from local unpacked npm tarballs
 * (<dir>/<name>-<version>/package/...) for machines without CDN access;
 * the page's SRI hashes are still enforced by the browser.
 */
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  const globalRoot = require('child_process').execSync('npm root -g').toString().trim();
  ({ chromium } = require(path.join(globalRoot, 'playwright')));
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const cdnDir = arg('--cdn-dir');
const shotDir = arg('--screenshots');
if (shotDir && !existsSync(shotDir)) mkdirSync(shotDir, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const CDN_MAP = {
  'react@18.2.0/umd/react.production.min.js': 'react-18.2.0/package/umd/react.production.min.js',
  'react-dom@18.2.0/umd/react-dom.production.min.js': 'react-dom-18.2.0/package/umd/react-dom.production.min.js',
  'prop-types@15.8.1/prop-types.min.js': 'prop-types-15.8.1/package/prop-types.min.js',
  '@babel/standalone@7.23.9/babel.min.js': 'babel-standalone-7.23.9/package/babel.min.js',
  'recharts@2.10.4/umd/Recharts.js': 'recharts-2.10.4/package/umd/Recharts.js'
};

const ratesText = await readFile(path.join(ROOT, 'data', 'rates.json'), 'utf8');
const rates = JSON.parse(ratesText);
let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.error('FAIL:', msg); } else console.log('ok -', msg); };

const browser = await chromium.launch();

async function newPage({ ratesOverride, embeddedOverride, viewport } = {}) {
  const context = await browser.newContext({ viewport: viewport || { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  if (cdnDir) {
    await page.route('https://unpkg.com/**', async route => {
      const key = route.request().url().replace('https://unpkg.com/', '');
      const local = CDN_MAP[key];
      if (!local) return route.abort();
      route.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: await readFile(path.join(cdnDir, local)) });
    });
  }
  const state = { rates: ratesOverride || rates };
  await page.route('**/data/rates.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.rates) }));
  if (embeddedOverride) {
    await page.route(BASE, async route => {
      const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
      /* function replacement: a '$' in the data (e.g. "$153") must not be read as $1/$2 */
      const patched = html.replace(/(<script type="application\/json" id="embedded-rates">)[\s\S]*?(<\/script>)/, (_, open, close) => `${open}\n${JSON.stringify(embeddedOverride)}\n${close}`);
      route.fulfill({ status: 200, contentType: 'text/html', body: patched });
    });
  }
  await page.goto(BASE);
  await page.waitForSelector('text=Roth Conversion Ladder Optimizer', { timeout: 30000 });
  return { page, errors, state, context };
}

try {
  /* 1. Load, tax data line, validation */
  {
    const { page, errors, context } = await newPage();
    const line = await page.locator('.tax-data-line').first().innerText();
    check(line.includes(`Tax data: ${rates.taxYear} figures`) && line.includes('last checked'), `tax data line shown: "${line.split('\n')[0]}"`);
    check(await page.locator('.data-banner').count() === 0 || require('../js/tax-engine.js').ratesFreshness(rates).stale, 'no banner when data is fresh');

    await page.getByRole('button', { name: 'Calculate Optimal Strategy' }).first().click();
    await page.waitForSelector('.validation-box');
    check((await page.locator('.validation-box').innerText()).includes('current age'), 'validation explains missing age');

    /* 2. Sample profile + state, calculate */
    const select = page.locator('select').first();
    await select.selectOption('couple-mid50s');
    await page.locator('select').filter({ hasText: 'California' }).selectOption('CA');
    await page.getByRole('button', { name: 'Calculate Optimal Strategy' }).first().click();
    await page.waitForSelector('.plain-headline', { timeout: 30000 });
    const headline = await page.locator('.plain-headline h2').innerText();
    check(headline.length > 20, `plain headline: "${headline}"`);
    check((await page.locator('.plain-tile').count()) >= 1, 'summary tiles rendered');
    check((await page.locator('.results-overlay .tax-data-line').innerText()).includes('last checked'), 'tax data line in results');
    await page.waitForTimeout(600);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'plain.png'), fullPage: true });

    /* 3. Details tabs */
    await page.locator('.details-toggle button').click();
    const tabs = await page.locator('.details-view .tab').allInnerTexts();
    check(tabs.length >= 6, `details tabs: ${tabs.join(' | ')}`);
    for (const t of tabs) {
      await page.locator('.details-view .tab', { hasText: t }).click();
      await page.waitForTimeout(250);
      if (shotDir) await page.screenshot({ path: path.join(shotDir, `tab-${t.replace(/[^a-z]+/gi, '-')}.png`), fullPage: true });
    }
    await page.locator('.details-view .tab', { hasText: 'Show the math' }).click();
    const math = await page.locator('.math-table').innerText();
    check(math.includes('Adjusted gross income') && math.includes('Total tax this year'), 'show-the-math table');
    await page.locator('.toggle-switch').click();
    await page.locator('.details-view .tab', { hasText: 'Summary' }).click();
    await page.waitForTimeout(300);

    /* 4. Back to inputs */
    await page.locator('.results-close').click();
    check(await page.locator('.results-overlay').count() === 0, 'edit inputs closes results');
    check(errors.length === 0, `no page errors (${errors.join('; ')})`);
    await context.close();
  }

  /* 4b. Widowed profile: survivor fields, Social Security note, claiming suggestion */
  {
    const { page, errors, context } = await newPage();
    await page.locator('select').first().selectOption('widow-61');
    check((await page.locator('label', { hasText: 'Survivor benefit start age' }).count()) === 1, 'survivor fields appear for a widowed profile');
    check((await page.locator('label', { hasText: 'Had your late spouse started Social Security?' }).count()) === 1, 'late-spouse question shown');
    await page.getByRole('button', { name: 'Calculate Optimal Strategy' }).first().click();
    await page.waitForSelector('.plain-headline', { timeout: 30000 });
    const notes = await page.locator('.plain-notes').innerText();
    check(/survivor benefit/i.test(notes), 'summary explains the survivor benefit');
    check(/Social Security claiming:/.test(notes), 'claiming suggestion shown for the default ages');
    const apply = page.locator('.plain-notes .note-action');
    check((await apply.count()) === 1, '"Use these ages" button present');
    await apply.click();
    await page.waitForSelector('.plain-headline', { timeout: 30000 });
    await page.waitForFunction(() => !/Social Security claiming:/.test(document.querySelector('.plain-notes')?.innerText || ''), null, { timeout: 30000 });
    const after = await page.locator('.plain-notes').innerText();
    check(/survivor benefit of \$[\d,]+ a year from age 61/.test(after), `after applying: survivor benefit from 61 ("${(after.match(/Social Security: [^.]*\./) || [''])[0].slice(0, 120)}")`);
    check(/your own benefit of \$[\d,]+ a year from age 70/.test(after), 'after applying: own benefit from 70');
    await page.locator('.details-toggle button').click();
    await page.locator('.details-view .tab', { hasText: 'Plan: year by year' }).click();
    const header = await page.locator('.data-table thead', { hasText: 'Sp.Age' }).innerText();
    check(header.includes('Soc. Sec.'), 'year table has a Social Security column');
    await page.locator('.details-view .tab', { hasText: 'Summary' }).click();
    await page.waitForTimeout(300);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'widowed.png'), fullPage: true });
    await page.locator('.results-close').click();
    check((await page.locator('label', { hasText: 'Survivor benefit start age' }).locator('..').locator('input').inputValue()) === '61', 'survivor start age input updated to 61');
    check(errors.length === 0, `no page errors (${errors.join('; ')})`);
    await context.close();
  }

  /* 4c. Goal: an older saved profile (no goal) loads with the lifetime-tax goal;
     the heirs' tax rate appears only for the heirs goal; results say what was optimized */
  {
    const { page, errors, context } = await newPage();
    const oldProfile = { currentAge: 68, retirementAge: 62, lifeExpectancy: 92, filingStatus: 'marriedFilingJointly', spouseAge: 65, spouseLifeExpectancy: 94,
      stateAbbr: 'CA', stateTaxRateOverride: '', traditionalBalance: 2500000, rothBalance: 300000, taxableBalance: 500000, taxableCostBasis: 300000, hsaBalance: 40000,
      annualContributions: { traditional: 0, roth: 0, taxable: 0, hsa: 0 }, grossIncome: 0, ssAnnualBenefit: 38000, ssStartAge: 67, spouseSsBenefit: 32000, spouseSsStartAge: 67,
      pensionIncome: 24000, annualSpending: 120000, preRetirementGrowth: 6, rothGrowth: 6, taxableGrowth: 6, dividendYield: 1.3, inflationRate: 2.5, bracketInflation: 2.5,
      heirTaxRate: 24, targetBracket: 'auto', customConversion: 0, taxPaymentSource: 'taxable' };
    await page.evaluate((p) => localStorage.setItem('roth-optimizer-profile', JSON.stringify(p)), oldProfile);
    await page.reload();
    await page.waitForSelector('text=Roth Conversion Ladder Optimizer', { timeout: 30000 });
    check(await page.locator('input[name="goal"][value="lifetimeTax"]').isChecked(), 'older saved profile (no goal) loads with the lifetime-tax goal');
    check((await page.locator('label', { hasText: "Heirs' Tax Rate" }).count()) === 0, "heirs' tax rate hidden under the lifetime-tax goal");
    await page.getByRole('button', { name: 'Calculate Optimal Strategy' }).first().click();
    await page.waitForSelector('.plain-headline', { timeout: 30000 });
    const ltHeadline = await page.locator('.plain-headline').innerText();
    check(/pays the least tax over your lifetime/.test(ltHeadline), 'headline says the plan pays the least lifetime tax');
    check((await page.locator('.plain-tile .label', { hasText: 'Tax over your lifetime' }).count()) === 1, 'lifetime-tax tile shown');
    check(/lowest total tax over your lifetime/.test(await page.locator('.plain-notes').innerText()), 'notes explain what was optimized');
    check((await page.locator('.card h3', { hasText: 'Taxes paid so far' }).count()) === 1, 'plain chart shows taxes paid so far');
    await page.locator('.details-toggle button').click();
    check(/lowest lifetime tax/.test(await page.locator('.details-note').innerText()), 'details note names the goal');
    await page.locator('.details-view .tab', { hasText: 'Show the math' }).click();
    check(/pays the least tax over your lifetime/.test(await page.locator('.details-view .chart-caption').first().innerText()), 'show-the-math names the goal');
    await page.locator('.results-close').click();
    await page.locator('label.goal-option', { hasText: 'Leave the most to my heirs' }).click();
    check(await page.locator('input[name="goal"][value="heirs"]').isChecked(), 'heirs goal selected');
    check((await page.locator('label', { hasText: "Heirs' Tax Rate" }).count()) === 1, "heirs' tax rate shown under the heirs goal");
    await page.getByRole('button', { name: 'Calculate Optimal Strategy' }).first().click();
    await page.waitForSelector('.plain-headline', { timeout: 30000 });
    check(/leaves the most to your heirs/.test(await page.locator('.plain-headline').innerText()), 'headline says the plan leaves the most to heirs');
    check((await page.locator('.plain-tile .label', { hasText: 'Left to your heirs' }).count()) === 1, 'heirs tile shown');
    check((await page.locator('.card h3', { hasText: 'What you’d leave after taxes' }).count()) === 1, 'plain chart shows after-tax wealth');
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'heirs-goal.png'), fullPage: true });
    await page.locator('.results-close').click();
    check(JSON.parse(await page.evaluate(() => localStorage.getItem('roth-optimizer-profile'))).goal === 'heirs', 'goal saved with the profile');
    check(errors.length === 0, `no page errors (${errors.join('; ')})`);
    await context.close();
  }

  /* 5. Stale data: banner + Check now finds newer published data */
  {
    const old = { ...rates, lastChecked: '2025-01-01', lastUpdated: '2025-01-01' };
    const { page, errors, state, context } = await newPage({ ratesOverride: old, embeddedOverride: old });
    await page.waitForSelector('.data-banner');
    check((await page.locator('.data-banner').innerText()).includes('out of date'), 'stale banner shown for old check date');
    state.rates = { ...rates, lastChecked: '2026-12-01', lastUpdated: '2026-12-01' };
    await page.locator('.data-banner button.primary').click();
    await page.waitForSelector('text=Newer tax figures are available');
    check(true, 'Check now offers newer figures');
    await page.locator('.data-banner button.primary', { hasText: 'Update' }).click();
    await page.waitForTimeout(200);
    check(await page.locator('.data-banner').count() === 0, 'Update applies figures and clears the banner');
    check((await page.locator('.tax-data-line').first().innerText()).includes('Dec 1, 2026'), 'tax data line shows the new check date');
    check(errors.length === 0, `no page errors (${errors.join('; ')})`);
    await context.close();
  }

  /* 6. Owner's fetcher: Check now POSTs with the secret and uses its response */
  {
    const { page, errors, context } = await newPage();
    let sawSecret = null;
    await page.route('https://tax-data-fetcher-test.a.run.app/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST' } });
      sawSecret = route.request().headers()['x-check-secret'];
      route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ status: 'updated', message: 'Committed new figures.', rates: { ...rates, lastChecked: '2026-12-02', lastUpdated: '2026-12-02' } }) });
    });
    await page.evaluate(() => localStorage.setItem('roth-optimizer-fetcher', JSON.stringify({ url: 'https://tax-data-fetcher-test.a.run.app/', key: 's3cret' })));
    await page.locator('.tax-data-line .link-button').first().click();
    await page.waitForSelector('text=Newer tax figures are available');
    check(sawSecret === 's3cret', 'fetcher called with shared secret header');
    check(errors.length === 0, `no page errors (${errors.join('; ')})`);
    await context.close();
  }

  /* 7. Offline fallback + phone width */
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    if (cdnDir) await page.route('https://unpkg.com/**', async route => {
      const local = CDN_MAP[route.request().url().replace('https://unpkg.com/', '')];
      route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(path.join(cdnDir, local)) });
    });
    await page.route('**/data/rates.json', route => route.fulfill({ status: 404, body: 'nope' }));
    await page.goto(BASE);
    await page.waitForSelector('text=Roth Conversion Ladder Optimizer', { timeout: 30000 });
    check((await page.locator('.tax-data-line').first().innerText()).includes('built into this page'), 'falls back to embedded data');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 1, `no horizontal scroll at phone width (overflow ${overflow}px)`);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'phone.png'), fullPage: false });
    check(errors.length === 0, `no page errors (${errors.join('; ')})`);
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

if (failures) { console.error(`\n${failures} smoke check(s) failed`); process.exit(1); }
console.log('\nAll smoke checks passed.');

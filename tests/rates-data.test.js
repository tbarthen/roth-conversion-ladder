/* Tests for the rates document: schema validation, canonical format,
   embedded-fallback sync, and freshness rules. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { E, loadRates, loadFixture, clone, ROOT, RATES_PATH } = require('./helpers');

test('data/rates.json is valid and covers every item with a source and year', () => {
  const rates = loadRates();
  assert.deepEqual(E.validateRates(rates), []);
  assert.ok(rates.taxYear >= 2026, 'tax year moves forward only');
  for (const key of E.REQUIRED_ITEMS) {
    const it = rates.items[key];
    assert.match(it.source, /^https:\/\//, key);
    assert.ok(it.effectiveYear === rates.taxYear || it.effectiveYear === rates.taxYear - 1, key);
  }
  assert.equal(rates.items.stateIncomeTax.value.states.length, 51);
});

test('the frozen test fixture is a valid 2026 rates document', () => {
  const fx = loadFixture();
  assert.deepEqual(E.validateRates(fx), []);
  assert.equal(fx.taxYear, 2026);
  assert.equal(E.formatRatesJson(fx), fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'rates-2026.json'), 'utf8'));
});

test('data/rates.json is stored in canonical format', () => {
  const text = fs.readFileSync(RATES_PATH, 'utf8');
  assert.equal(E.formatRatesJson(JSON.parse(text)), text, 'run: node scripts/sync-rates.js');
});

test('index.html embedded fallback matches data/rates.json exactly', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/<script type="application\/json" id="embedded-rates">\n([\s\S]*?)<\/script>/);
  assert.ok(m, 'embedded-rates block missing');
  assert.equal(m[1], fs.readFileSync(RATES_PATH, 'utf8'), 'run: node scripts/sync-rates.js');
});

test('sync script --check passes', () => {
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-rates.js'), '--check'], { encoding: 'utf8' });
  assert.match(out, /valid and in sync/);
});

test('validation rejects broken documents', () => {
  const bad = (mutate, pattern) => {
    const r = clone(loadRates());
    mutate(r);
    const errs = E.validateRates(r);
    assert.ok(errs.some(e => pattern.test(e)), `expected ${pattern}, got ${JSON.stringify(errs.slice(0, 3))}`);
  };
  bad(r => { delete r.items.medicareIrmaa; }, /medicareIrmaa: missing/);
  bad(r => { r.items.federalBrackets.value.single[2][1] = 1000; }, /ascending/);
  bad(r => { r.items.federalBrackets.value.single[6][1] = 999999; }, /must be null/);
  bad(r => { r.items.federalBrackets.value.single[3][0] = 0.2; }, /rates must be ascending/);
  bad(r => { r.items.standardDeduction.value.single = -1; }, /single/);
  bad(r => { r.items.niit.effectiveYear = r.taxYear - 2; }, /effectiveYear/);
  bad(r => { r.items.niit.source = 'http://example.com'; }, /https/);
  bad(r => { r.items.niit.label = '<script>alert(1)</script>'; }, /unsafe/);
  bad(r => { r.items.medicareIrmaa.value.tiers.single[1].magiOver = 100; }, /ascending/);
  bad(r => { r.items.rmd.value.uniformLifetimeTable['90'] = 99; }, /must not increase/);
  bad(r => { r.items.rmd.value.jointLifeTable.rows['80'][5] = 99; }, /must not increase/);
  bad(r => { r.items.stateIncomeTax.value.states[1].abbr = 'AL'; }, /duplicate/);
  bad(r => { r.items.stateIncomeTax.value.states[4].rate = 12; }, /does not match/);
  bad(r => { r.items.stateIncomeTax.value.states.pop(); }, /expected 51/);
  bad(r => { delete r.items.stateIncomeTax.value.states[0].standardDeduction; }, /AL: standardDeduction/);
  bad(r => { r.items.stateIncomeTax.value.states[0].personalExemption.single = -1; }, /AL: personalExemption/);
  bad(r => { r.items.stateIncomeTax.value.states[0].personalCredit = 5; }, /AL: personalCredit/);
  bad(r => { r.items.stateIncomeTax.value.states.find(s => s.abbr === 'PA').retirementExclusion.source = 'http://x'; }, /PA: retirementExclusion/);
  bad(r => { r.items.stateIncomeTax.value.states.find(s => s.abbr === 'IL').retirementExclusion.iraFromAge = 90; }, /IL: retirementExclusion/);
  bad(r => { r.items.stateIncomeTax.value.states.find(s => s.abbr === 'MS').retirementExclusion.conversions = 'yes'; }, /MS: retirementExclusion/);
  bad(r => { r.items.stateIncomeTax.value.states.find(s => s.abbr === 'CO').socialSecurityExemption.fromAge = 30; }, /CO: socialSecurityExemption/);
  bad(r => { r.items.stateIncomeTax.value.states.find(s => s.abbr === 'CA').seniorCredit.perPerson = -1; }, /CA: seniorCredit/);
  bad(r => { r.items.stateIncomeTax.value.states.find(s => s.abbr === 'CA').seniorCredit.source = 'http://x'; }, /CA: seniorCredit/);
  bad(r => { r.items.stateIncomeTax.value.states.find(s => s.abbr === 'CO').socialSecurityExemption.source = 'http://x'; }, /CO: socialSecurityExemption/);
  bad(r => { const co = r.items.stateIncomeTax.value.states.find(s => s.abbr === 'CO'); co.taxesSocialSecurity = false; }, /CO: socialSecurityExemption/);
  bad(r => { r.lastChecked = '2026-13-45'; }, /lastChecked/);
  bad(r => { r.schemaVersion = 1; }, /schemaVersion/);
  assert.deepEqual(E.validateRates(null), ['rates document must be a JSON object']);
  assert.throws(() => E.compileTaxData({}), /Invalid rates data/);
});

test('an item may lag one year behind the tax year (e.g. state data pending)', () => {
  const r = clone(loadFixture());
  assert.deepEqual(E.laggingItems(r), []);
  r.items.stateIncomeTax.effectiveYear = r.taxYear - 1;
  assert.deepEqual(E.validateRates(r), []);
  assert.deepEqual(E.laggingItems(r).map(i => i.key), ['stateIncomeTax']);
});

test('canonical formatter: inline when short, wrapped at 100 columns when long', () => {
  const out = E.formatRatesJson({ a: [1, 2, 3], b: { c: 1, d: 'x' }, e: Array.from({ length: 60 }, (_, i) => i + 0.5), f: [], g: {} });
  assert.match(out, /"a": \[1, 2, 3\]/);
  assert.match(out, /"b": \{"c": 1, "d": "x"\}/);
  assert.match(out, /"f": \[\]/);
  for (const line of out.split('\n')) assert.ok(line.length <= 100, line);
  assert.deepEqual(JSON.parse(out), { a: [1, 2, 3], b: { c: 1, d: 'x' }, e: Array.from({ length: 60 }, (_, i) => i + 0.5), f: [], g: {} });
  assert.ok(out.endsWith('}\n'));
  assert.throws(() => E.formatRatesJson({ x: Infinity }));
});

test('freshness: stale on a new tax year or when last check is over 45 days old', () => {
  const r = { taxYear: 2026, lastChecked: '2026-09-28' };
  assert.equal(E.ratesFreshness(r, new Date('2026-10-01T12:00:00Z')).stale, false);
  assert.equal(E.ratesFreshness(r, new Date('2026-11-12T12:00:00Z')).stale, false); /* 45 days */
  const late = E.ratesFreshness(r, new Date('2026-11-13T12:00:00Z'));
  assert.deepEqual(late.reasons, ['notCheckedRecently']);
  assert.equal(late.daysSinceCheck, 46);
  const newYear = E.ratesFreshness({ taxYear: 2026, lastChecked: '2026-12-31' }, new Date('2027-01-02T00:00:00Z'));
  assert.deepEqual(newYear.reasons, ['newTaxYear']);
});

test('isNewerRates compares tax year, then last update date', () => {
  const cur = { taxYear: 2026, lastUpdated: '2026-09-28', lastChecked: '2026-09-28' };
  assert.equal(E.isNewerRates({ ...cur, taxYear: 2027, lastUpdated: '2027-01-03' }, cur), true);
  assert.equal(E.isNewerRates({ ...cur, lastUpdated: '2026-10-05' }, cur), true);
  assert.equal(E.isNewerRates({ ...cur, lastChecked: '2026-10-28' }, cur), false); /* re-check only */
  assert.equal(E.isNewerRates({ ...cur, taxYear: 2025, lastUpdated: '2027-01-01' }, cur), false);
  assert.equal(E.isNewerRates(null, cur), false);
});

test('validation checks the survivor-benefit item', () => {
  const bad = (mutate, pattern) => {
    const r = clone(loadRates());
    mutate(r);
    const errs = E.validateRates(r);
    assert.ok(errs.some(e => pattern.test(e)), `expected ${pattern}, got ${JSON.stringify(errs.slice(0, 3))}`);
  };
  assert.ok(E.REQUIRED_ITEMS.includes('socialSecuritySurvivor'));
  bad(r => { delete r.items.socialSecuritySurvivor; }, /socialSecuritySurvivor: missing/);
  bad(r => { r.items.socialSecuritySurvivor.value.maxReduction = 1.5; }, /maxReduction/);
  bad(r => { r.items.socialSecuritySurvivor.value.earlyClaimerFloor = 0; }, /earlyClaimerFloor/);
  bad(r => { r.items.socialSecuritySurvivor.value.earliestClaimAge = 40; }, /earliestClaimAge/);
  bad(r => { r.items.socialSecuritySurvivor.value.fullRetirementAge[0].bornThrough = 1999; }, /bornThrough/);
  const v = loadRates().items.socialSecuritySurvivor.value;
  assert.equal(v.earliestClaimAge, 60);
  assert.equal(v.maxReduction, 0.285);
  assert.equal(v.earlyClaimerFloor, 0.825);
});

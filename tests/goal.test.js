/* Tests for the optimization goal: "pay the least tax over my lifetime"
   (the default) vs "leave the most to my heirs". See docs/optimization-goal.md. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, td, baseInputs, near } = require('./helpers');

const START = 2026;
const opt = (inputs, opts = {}) => E.optimizeStrategy(inputs, td, { startYear: START, ...opts });
const chosenOf = (r) => r.candidates.find(c => c.chosen);

/** A wealthy married couple in California, already retired, RMDs a few years off. */
const caCouple = (over = {}) => ({
  currentAge: 68, retirementAge: 62, lifeExpectancy: 92,
  filingStatus: 'marriedFilingJointly', spouseAge: 65, spouseLifeExpectancy: 94, stateAbbr: 'CA',
  traditionalBalance: 2500000, rothBalance: 300000, taxableBalance: 500000, taxableCostBasis: 300000, hsaBalance: 40000,
  annualContributions: { traditional: 0, roth: 0, taxable: 0, hsa: 0 }, grossIncome: 0,
  ssAnnualBenefit: 38000, ssStartAge: 67, spouseSsBenefit: 32000, spouseSsStartAge: 67,
  pensionIncome: 24000, annualSpending: 120000,
  preRetirementGrowth: 6, rothGrowth: 6, taxableGrowth: 6, dividendYield: 1.3,
  inflationRate: 2.5, bracketInflation: 2.5, heirTaxRate: 24,
  ...over
});

/** A single early retiree for whom the cheapest plan runs the money out. */
const tightRetiree = () => baseInputs({
  currentAge: 56, retirementAge: 56, traditionalBalance: 600000, rothBalance: 20000,
  taxableBalance: 180000, taxableCostBasis: 108000, annualSpending: 55000, ssAnnualBenefit: 35000
});

test('wealthy California couple: the lifetime-tax goal fills a real bracket, the heirs goal converts less', () => {
  const inp = caCouple();
  const lifetime = opt(inp, { goal: 'lifetimeTax' });
  const heirs = opt(inp, { goal: 'heirs' });
  assert.equal(lifetime.goal, 'lifetimeTax');
  assert.equal(heirs.goal, 'heirs');
  assert.ok(lifetime.chosen.rate >= 0.22, `lifetime-tax goal picked the ${lifetime.chosen.rate * 100}% bracket`);
  assert.ok(heirs.chosen.rate < lifetime.chosen.rate, `heirs goal picked ${heirs.chosen.rate * 100}% vs ${lifetime.chosen.rate * 100}%`);
  /* Each goal wins on its own measure */
  const lc = chosenOf(lifetime), hc = chosenOf(heirs);
  assert.ok(lc.lifetimeTax < hc.lifetimeTax - 1000, 'lifetime-tax plan pays less lifetime tax');
  assert.ok(hc.netPosition > lc.netPosition + 1000, 'heirs plan leaves more after the heirs\' tax');
  assert.equal(lc.unmetSpending, 0);
  /* Neither runs short, and the lifetime-tax plan beats not converting by six figures */
  assert.equal(lifetime.baseline.unmetSpending, 0);
  const s = E.summarizePlan(lifetime, 2.5);
  assert.equal(s.goal, 'lifetimeTax');
  assert.ok(s.worthIt);
  assert.ok(s.taxSavedToday > 100000, `saves ${s.taxSavedToday}`);
  near(assert, s.gainToday, s.taxSavedToday, 1e-6);
  near(assert, s.taxSavedToday, lifetime.baseline.lifetimeTax - lc.lifetimeTax, 1e-6);
  /* The summary also reports what the goal does not optimize: what is left at the end */
  assert.ok(s.totalEstateA > 0 && s.totalEstateB > 0);
  const hs = E.summarizePlan(heirs, 2.5);
  assert.equal(hs.goal, 'heirs');
  near(assert, hs.gainToday, hs.estateGainToday, 1e-6);
  assert.ok(hs.estateGainToday > s.estateGainToday, 'heirs goal leaves more to heirs than the lifetime-tax plan');
});

test('lifetime tax counts every tax and penalty, in today\'s dollars', () => {
  const rows = E.runProjection(baseInputs({ hsaBalance: 30000, dividendYield: 2 }), 'optimized', { startYear: START, targetBracketRate: 0.24 }, td);
  const expected = rows.reduce((sum, r, i) => sum + (r.federalTax + r.stateTax + r.capGainsTax + r.niit + r.irmaaSurcharge
    + r.earlyWithdrawalPenalty + r.hsaPenalty + r.rothPenalty) / 1.02 ** i, 0);
  near(assert, E.lifetimeTax(rows, 2), expected, 0.01);
  assert.ok(E.lifetimeTax(rows, 0) > E.lifetimeTax(rows, 2), 'deflating lowers the total');
  const m = E.planMetrics(rows, 2);
  near(assert, m.lifetimeTax, expected, 0.01);
  assert.equal(m.netPosition, rows.at(-1).netPosition);
  assert.equal(m.runsOutAge, null);
});

test('guard: a plan that runs out of money is never chosen over one that does not, whatever its tax', () => {
  const r = opt(tightRetiree());
  const chosen = chosenOf(r);
  const cheapest = r.candidates.reduce((b, c) => c.lifetimeTax < b.lifetimeTax - 1 ? c : b, r.candidates[0]);
  assert.notEqual(cheapest, chosen, 'the cheapest plan is not the one chosen');
  assert.ok(cheapest.unmetSpending > 1000 && cheapest.runsOutAge, `cheapest plan (${cheapest.rate}) runs out at ${cheapest.runsOutAge}`);
  assert.equal(chosen.unmetSpending, 0, 'chosen plan pays for every year');
  assert.equal(chosen.runsOutAge, null);
  assert.equal(r.baseline.unmetSpending, 0);
  /* Among the plans that never run short, the chosen one pays the least tax */
  const safe = r.candidates.filter(c => c.unmetSpending <= 1);
  assert.ok(safe.every(c => c.lifetimeTax >= chosen.lifetimeTax - 1));
  /* The plans set aside are reported so the summary can say why */
  assert.ok(r.chosen.passedOver.length >= 1);
  assert.ok(r.chosen.passedOver.some(p => p.rate === cheapest.rate && p.irmaaMode === cheapest.irmaaMode));
  assert.ok(r.chosen.passedOver.every(p => p.lifetimeTax < chosen.lifetimeTax && p.unmetSpending > chosen.unmetSpending));
  const s = E.summarizePlan(r, 2);
  assert.equal(s.passedOver.length, r.chosen.passedOver.length);
  assert.equal(s.shortOfMoney, false);
  /* Forced onto the cheaper bracket, the plan runs short where not converting does not: never "worth it" */
  const forced = opt(tightRetiree(), { targetBracket: String(cheapest.rate) });
  const fs = E.summarizePlan(forced, 2);
  assert.ok(fs.unmetB > fs.unmetA + 1);
  assert.equal(fs.shortOfMoney, true);
  assert.equal(fs.worthIt, false);
  assert.ok(fs.taxSavedToday > 0, 'even though it "saves" tax');
});

test('choosePlan: lifetime-tax guard and tie-breaking on synthetic candidates', () => {
  const c = (rate, irmaaMode, lifetimeTax, unmetSpending, netPosition = 0) => ({ rate, irmaaMode, lifetimeTax, unmetSpending, netPosition, runsOutAge: unmetSpending > 0 ? 88 : null });
  /* Least aggressive first, as optimizeStrategy orders them */
  const plans = [c(0.10, 'avoid', 500, 0), c(0.10, 'ignore', 500, 0), c(0.12, 'avoid', 400, 0), c(0.12, 'ignore', 400, 0), c(0.22, 'avoid', 300, 2000), c(0.22, 'ignore', 250, 5000)];
  const pick = E.choosePlan(plans, 'lifetimeTax');
  assert.equal(pick.index, 2, 'lowest tax among the plans with nothing unpaid; the 12%/avoid tie beats 12%/ignore');
  assert.deepEqual(pick.passedOver.map(p => [p.rate, p.irmaaMode]), [[0.22, 'avoid'], [0.22, 'ignore']]);
  /* All plans fall short: the one falling short by least wins, then tax */
  assert.equal(E.choosePlan([c(0.10, 'avoid', 500, 3000), c(0.12, 'avoid', 100, 3000.5), c(0.22, 'avoid', 50, 4000)], 'lifetimeTax').index, 1);
  /* A less aggressive plan that runs out loses to a more aggressive one that does not */
  assert.equal(E.choosePlan([c(0.10, 'avoid', 100, 500), c(0.12, 'avoid', 200, 0)], 'lifetimeTax').index, 1);
  /* Ties within a dollar go to the less aggressive plan */
  assert.equal(E.choosePlan([c(0.22, 'avoid', 300, 0), c(0.24, 'avoid', 299.5, 0), c(0.32, 'avoid', 299.2, 0)], 'lifetimeTax').index, 0);
  assert.equal(E.choosePlan([c(0.22, 'avoid', 300, 0), c(0.24, 'avoid', 298, 0)], 'lifetimeTax').index, 1);
  /* Heirs goal: highest net position, ties to the less aggressive plan, no guard beyond the unpaid spending already in the net position */
  assert.equal(E.choosePlan([c(0.10, 'avoid', 500, 0, 1000), c(0.12, 'avoid', 400, 0, 1000.5), c(0.22, 'avoid', 300, 0, 900)], 'heirs').index, 0);
  assert.equal(E.choosePlan([c(0.10, 'avoid', 500, 0, 1000), c(0.12, 'avoid', 400, 0, 1002)], 'heirs').index, 1);
  assert.deepEqual(E.choosePlan([], 'lifetimeTax'), { index: -1, passedOver: [] });
});

test('tie-breaking in the optimizer: identical plans go to the less aggressive one', () => {
  /* At a fixed 35% bracket the whole balance is converted at once, so staying under the
     IRMAA threshold and ignoring it produce the same plan: the "avoid" variant wins. */
  const r = opt(baseInputs({ traditionalBalance: 1500000 }), { targetBracket: '0.35' });
  assert.equal(r.candidates.length, 2);
  near(assert, r.candidates[0].lifetimeTax, r.candidates[1].lifetimeTax, 0.01);
  assert.equal(r.chosen.irmaaMode, 'avoid');
  assert.equal(r.candidates[0].chosen, true);
  /* The same under the heirs goal */
  assert.equal(opt(baseInputs({ traditionalBalance: 1500000 }), { targetBracket: '0.35', goal: 'heirs' }).chosen.irmaaMode, 'avoid');
});

test('profile migration: a saved profile without a goal optimizes lifetime tax; the goal can be set or overridden', () => {
  /* Older profiles have every other field but no goal */
  const old = caCouple();
  assert.equal('goal' in old, false);
  assert.equal(E.normalizeInputs(old, td).goal, 'lifetimeTax');
  assert.equal(E.normalizeInputs({}, td).goal, 'lifetimeTax');
  assert.equal(E.normalizeInputs({ goal: 'heirs' }, td).goal, 'heirs');
  assert.equal(E.normalizeInputs({ goal: 'estate' }, td).goal, 'lifetimeTax', 'unknown values fall back');
  assert.deepEqual(E.GOALS, ['lifetimeTax', 'heirs']);
  const r = opt(old);
  assert.equal(r.goal, 'lifetimeTax');
  assert.equal(r.chosen.goal, 'lifetimeTax');
  /* The goal saved in the profile is used; an explicit option wins over it */
  assert.equal(opt({ ...old, goal: 'heirs' }).goal, 'heirs');
  assert.equal(opt({ ...old, goal: 'heirs' }, { goal: 'lifetimeTax' }).goal, 'lifetimeTax');
  assert.equal(opt(old, { goal: 'bogus' }).goal, 'lifetimeTax');
  /* The heirs' tax rate changes nothing under the lifetime-tax goal */
  const a = opt({ ...old, heirTaxRate: 0 }), b = opt({ ...old, heirTaxRate: 50 });
  assert.equal(a.chosen.rate, b.chosen.rate);
  assert.equal(a.chosen.irmaaMode, b.chosen.irmaaMode);
  near(assert, chosenOf(a).lifetimeTax, chosenOf(b).lifetimeTax, 0.01);
  /* validateInputs does not object to either goal */
  assert.equal(E.validateInputs({ ...old, goal: 'heirs' }, td).errors.length, 0);
});

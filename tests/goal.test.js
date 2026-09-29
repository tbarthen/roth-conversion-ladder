/* Tests for the optimization goal: "keep the most for myself" (spendable
   wealth, the default) vs "leave the most to my heirs". See docs/optimization-goal.md. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, td, baseInputs, near } = require('./helpers');

const START = 2026;
const opt = (inputs, opts = {}) => E.optimizeStrategy(inputs, td, { startYear: START, ...opts });
const chosenOf = (r) => r.candidates.find(c => c.chosen);

/** A wealthy married couple in California: $3M traditional, $2.7M taxable, $0.8M Roth, spending $115K. */
const caCouple = (over = {}) => ({
  currentAge: 62, retirementAge: 62, lifeExpectancy: 92,
  filingStatus: 'marriedFilingJointly', spouseAge: 60, spouseLifeExpectancy: 94, stateAbbr: 'CA',
  traditionalBalance: 3000000, rothBalance: 800000, taxableBalance: 2700000, taxableCostBasis: 1600000, hsaBalance: 0,
  annualContributions: { traditional: 0, roth: 0, taxable: 0, hsa: 0 }, grossIncome: 0,
  ssAnnualBenefit: 42000, ssStartAge: 70, spouseSsBenefit: 30000, spouseSsStartAge: 67,
  pensionIncome: 0, annualSpending: 115000,
  preRetirementGrowth: 6, rothGrowth: 6, taxableGrowth: 6, dividendYield: 1.5,
  inflationRate: 2.5, bracketInflation: 2.5, heirTaxRate: 24,
  ...over
});

test('wealthy California couple: "keep the most for myself" lands at the 22% or 24% bracket, not 32%', () => {
  const r = opt(caCouple());
  assert.equal(r.goal, 'spendable');
  assert.ok(r.chosen.rate === 0.22 || r.chosen.rate === 0.24, `picked the ${r.chosen.rate * 100}% bracket`);
  const c = chosenOf(r);
  assert.equal(c.unmetSpending, 0);
  assert.equal(r.baseline.unmetSpending, 0);
  /* Wins on its own measure against every other candidate that pays every year */
  for (const o of r.candidates) if (o.unmetSpending <= 1) assert.ok(c.spendableWealth >= o.spendableWealth - 1, `${o.rate}/${o.irmaaMode}`);
  /* ...and by a wide margin against not converting */
  const s = E.summarizePlan(r, 2.5);
  assert.equal(s.goal, 'spendable');
  assert.ok(s.worthIt);
  assert.ok(s.spendableGainToday > 500000, `gain ${s.spendableGainToday}`);
  near(assert, s.gainToday, s.spendableGainToday, 1e-6);
  near(assert, s.spendableGainToday, c.spendableWealth - r.baseline.spendableWealth, 0.01);
  assert.ok(s.drawdownTaxA > s.drawdownTaxB, 'converting shrinks the tax still owed on the traditional balance');
  assert.ok(s.taxSavedToday > 0);
  /* Roughly 32%-bracket-sized conversions ($450K a year) are not what it suggests */
  assert.ok(s.averageConversionToday < 420000, `average conversion ${s.averageConversionToday}`);
  /* The heirs goal is unchanged: highest net position */
  const h = opt(caCouple(), { goal: 'heirs' });
  const best = Math.max(...h.candidates.map(x => x.netPosition));
  near(assert, chosenOf(h).netPosition, best, 1.01);
});

test('a modest retiree still gets a sensible plan', () => {
  const r = opt(baseInputs());
  const s = E.summarizePlan(r, 2);
  assert.ok(s.worthIt, 'converting is worth it');
  assert.ok(r.chosen.rate <= 0.12, `gentle bracket, got ${r.chosen.rate}`);
  assert.equal(s.runsOutAgeB, null);
  assert.ok(s.conversionYears > 0);
  assert.ok(s.averageConversionToday > 5000 && s.averageConversionToday < 60000, `average ${s.averageConversionToday}`);
  assert.ok(s.spendableGainToday > 500 && s.spendableGainToday < 100000, `gain ${s.spendableGainToday}`);
});

test('spendable wealth: the traditional balance is valued with real brackets (hand-worked)', () => {
  /* Single, 60, dies at 61; no growth, no income, no spending, no state, so
     the balances are untouched: $500K traditional, $100K Roth, $200K taxable
     with $100K of gains. Drawn down over 10 years: $50K IRA + $10K gains a year.
       AGI 60,000; standard deduction (single, under 65, 2026 figures) 16,100
       taxable income 43,900 = 33,900 ordinary + 10,000 preferential
       ordinary tax: 10% x 12,400 + 12% x (33,900 - 12,400) = 1,240 + 2,580 = 3,820
       capital gains: 43,900 is inside the 0% band (to 49,450) -> 0; NIIT 0; IRMAA none (under 65)
     Drawdown tax 10 x 3,820 = 38,200; spendable 800,000 - 38,200 = 761,800. */
  const inp = baseInputs({ currentAge: 60, retirementAge: 60, lifeExpectancy: 61, traditionalBalance: 500000, rothBalance: 100000,
    taxableBalance: 200000, taxableCostBasis: 100000, annualSpending: 0, ssAnnualBenefit: 0,
    preRetirementGrowth: 0, rothGrowth: 0, taxableGrowth: 0, dividendYield: 0, inflationRate: 0, bracketInflation: 0 });
  const rows = E.runProjection(inp, 'noConversion', { startYear: START }, td);
  const last = rows.at(-1);
  assert.equal(last.age, 61);
  near(assert, last.tradBal, 500000, 0.01);
  near(assert, last.totalTax, 0, 0.01);
  near(assert, last.drawdownTax, 38200, 0.01);
  near(assert, last.spendableWealth, 761800, 0.01);
  assert.equal(E.DRAWDOWN_YEARS, 10);
  /* Not a flat rate: a larger balance is taxed at higher brackets */
  const bigger = E.runProjection({ ...inp, traditionalBalance: 1500000 }, 'noConversion', { startYear: START }, td).at(-1);
  assert.ok(bigger.drawdownTax / 1500000 > last.drawdownTax / 500000, 'higher average rate on a larger balance');
  /* The heirs' rate plays no part */
  const other = E.runProjection({ ...inp, heirTaxRate: 50 }, 'noConversion', { startYear: START }, td).at(-1);
  near(assert, other.spendableWealth, last.spendableWealth, 1e-6);
  assert.ok(other.afterTaxEstate < last.afterTaxEstate);
  /* Roth and HSA count in full; unrealized gains cost capital-gains tax */
  const roth = E.runProjection({ ...inp, traditionalBalance: 0, taxableBalance: 0, taxableCostBasis: 0, rothBalance: 300000, hsaBalance: 50000 }, 'noConversion', { startYear: START }, td).at(-1);
  near(assert, roth.spendableWealth, 350000, 0.01);
  near(assert, roth.drawdownTax, 0, 0.01);
  const gains = E.runProjection({ ...inp, traditionalBalance: 0, rothBalance: 0, taxableBalance: 1200000, taxableCostBasis: 200000 }, 'noConversion', { startYear: START }, td).at(-1);
  /* $100K of gains a year: 83,900 taxable after the 16,100 deduction, 49,450 of it in the
     0% band and 34,450 at 15% = 5,167.50 a year; NIIT none (AGI 100K) */
  near(assert, gains.drawdownTax, 51675, 0.01);
});

test('spendable wealth is valued at the survivor\'s filing status, with the year\'s income and thresholds', () => {
  const inp = baseInputs({ filingStatus: 'marriedFilingJointly', spouseAge: 60, spouseLifeExpectancy: 80, spouseSsBenefit: 20000, traditionalBalance: 1500000, pensionIncome: 30000 });
  const rows = E.runProjection(inp, 'noConversion', { startYear: START }, td);
  const last = rows.at(-1);
  assert.equal(last.filingStatus, 'single', 'the spouse has died by the end');
  /* Recompute with the public tax functions: 10 years of trad/10 + gains/10 on top of the year's income */
  const gains = Math.max(0, last.taxBal - last.taxBasis);
  const params = (ira, cg) => ({ filingStatus: last.filingStatus, year: last.year, age: last.age, spouseAge: null, wages: 0, pension: last.pension,
    iraDistributions: ira, rothConversion: 0, hsaTaxable: 0, ssBenefits: last.ssIncome, dividends: last.dividendIncome, capitalGains: cg,
    stateRate: 0, stateBrackets: null, stateTaxesSocialSecurity: false, stateSsExemptShare: 0, stateDeduction: null, stateCredit: 0,
    stateRetirementExclusion: null, bracketInflation: 0.02 });
  const without = E.computeYearTax(td, params(0, 0));
  const withDraw = E.computeYearTax(td, params(last.tradBal / 10, gains / 10));
  const irmaa = (t) => E.irmaaSurcharge(td, t.magi, 'single', last.year, 0.02, 0.02, last.medicarePeople).annual;
  const expected = 10 * ((withDraw.incomeTax - without.incomeTax) + (irmaa(withDraw) - irmaa(without)));
  near(assert, last.drawdownTax, expected, 0.01);
  near(assert, last.spendableWealth, last.tradBal + last.rothBal + last.taxBal + last.hsaBal - expected, 0.01);
  assert.ok(expected > 0);
  /* planMetrics reports it in today's dollars */
  const m = E.planMetrics(rows, 2);
  near(assert, m.spendableWealth, last.spendableWealth / 1.02 ** (rows.length - 1), 0.01);
  near(assert, m.drawdownTax, expected / 1.02 ** (rows.length - 1), 0.01);
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

test('guard: a plan that leaves spending unpaid never wins, whatever it ends with', () => {
  const c = (rate, irmaaMode, spendableWealth, unmetSpending, netPosition = 0) => ({ rate, irmaaMode, spendableWealth, lifetimeTax: 0, unmetSpending, netPosition, runsOutAge: unmetSpending > 0 ? 88 : null });
  /* Least aggressive first, as optimizeStrategy orders them */
  const plans = [c(0.10, 'avoid', 500, 0), c(0.10, 'ignore', 500, 0), c(0.12, 'avoid', 600, 0), c(0.12, 'ignore', 600, 0), c(0.22, 'avoid', 700, 2000), c(0.22, 'ignore', 800, 5000)];
  const pick = E.choosePlan(plans, 'spendable');
  assert.equal(pick.index, 2, 'most spendable among the plans with nothing unpaid; the 12%/avoid tie beats 12%/ignore');
  assert.deepEqual(pick.passedOver.map(p => [p.rate, p.irmaaMode, p.spendableWealth]), [[0.22, 'avoid', 700], [0.22, 'ignore', 800]]);
  /* All plans fall short: the one falling short by least wins, then spendable wealth */
  assert.equal(E.choosePlan([c(0.10, 'avoid', 500, 3000), c(0.12, 'avoid', 900, 3000.5), c(0.22, 'avoid', 950, 4000)], 'spendable').index, 1);
  /* A less aggressive plan that runs out loses to a more aggressive one that does not */
  assert.equal(E.choosePlan([c(0.10, 'avoid', 900, 500), c(0.12, 'avoid', 800, 0)], 'spendable').index, 1);
  assert.deepEqual(E.choosePlan([], 'spendable'), { index: -1, passedOver: [] });

  /* Through the optimizer: forced onto a bracket that runs the money out while not
     converting does not, the plan is never "worth it", whatever it shows at the end */
  const tight = baseInputs({ currentAge: 56, retirementAge: 56, traditionalBalance: 600000, rothBalance: 20000, taxableBalance: 180000, taxableCostBasis: 108000, annualSpending: 55000, ssAnnualBenefit: 35000 });
  const auto = opt(tight);
  assert.equal(auto.baseline.unmetSpending, 0);
  assert.equal(chosenOf(auto).unmetSpending, 0, 'the chosen plan pays for every year');
  const short = auto.candidates.filter(x => x.unmetSpending > 1000);
  assert.ok(short.length > 0, 'some brackets run the money out');
  for (const x of short) {
    const forced = opt(tight, { targetBracket: String(x.rate) });
    const s = E.summarizePlan(forced, 2);
    if (s.unmetB > s.unmetA + 1) { assert.equal(s.shortOfMoney, true); assert.equal(s.worthIt, false); }
  }
});

test('tie-breaking: identical plans go to the less aggressive one', () => {
  const c = (rate, irmaaMode, spendableWealth, netPosition = 0) => ({ rate, irmaaMode, spendableWealth, lifetimeTax: 0, unmetSpending: 0, netPosition, runsOutAge: null });
  /* Within a dollar is a tie */
  assert.equal(E.choosePlan([c(0.22, 'avoid', 300), c(0.24, 'avoid', 300.5), c(0.32, 'avoid', 300.8)], 'spendable').index, 0);
  assert.equal(E.choosePlan([c(0.22, 'avoid', 300), c(0.24, 'avoid', 302)], 'spendable').index, 1);
  /* Heirs goal: highest net position, ties to the less aggressive plan */
  assert.equal(E.choosePlan([c(0.10, 'avoid', 0, 1000), c(0.12, 'avoid', 0, 1000.5), c(0.22, 'avoid', 0, 900)], 'heirs').index, 0);
  assert.equal(E.choosePlan([c(0.10, 'avoid', 0, 1000), c(0.12, 'avoid', 0, 1002)], 'heirs').index, 1);
  /* In the optimizer: at a fixed 35% bracket the whole balance is converted at once, so
     staying under the IRMAA threshold and ignoring it are the same plan: "avoid" wins. */
  const r = opt(baseInputs({ traditionalBalance: 1500000 }), { targetBracket: '0.35' });
  assert.equal(r.candidates.length, 2);
  near(assert, r.candidates[0].spendableWealth, r.candidates[1].spendableWealth, 0.01);
  assert.equal(r.chosen.irmaaMode, 'avoid');
  assert.equal(r.candidates[0].chosen, true);
  assert.equal(opt(baseInputs({ traditionalBalance: 1500000 }), { targetBracket: '0.35', goal: 'heirs' }).chosen.irmaaMode, 'avoid');
});

test('profile migration: no goal, or the old "lifetimeTax" goal, means "keep the most for myself"', () => {
  const old = caCouple();
  assert.equal('goal' in old, false);
  assert.equal(E.normalizeInputs(old, td).goal, 'spendable');
  assert.equal(E.normalizeInputs({}, td).goal, 'spendable');
  assert.equal(E.normalizeInputs({ goal: 'lifetimeTax' }, td).goal, 'spendable', 'the first version of the question');
  assert.equal(E.normalizeInputs({ goal: 'heirs' }, td).goal, 'heirs');
  assert.equal(E.normalizeInputs({ goal: 'estate' }, td).goal, 'spendable', 'unknown values fall back');
  assert.deepEqual(E.GOALS, ['spendable', 'heirs']);
  const r = opt(baseInputs());
  assert.equal(r.goal, 'spendable');
  assert.equal(r.chosen.goal, 'spendable');
  assert.equal(opt({ ...baseInputs(), goal: 'lifetimeTax' }).goal, 'spendable');
  /* The goal saved in the profile is used; an explicit option wins over it */
  assert.equal(opt({ ...baseInputs(), goal: 'heirs' }).goal, 'heirs');
  assert.equal(opt({ ...baseInputs(), goal: 'heirs' }, { goal: 'spendable' }).goal, 'spendable');
  assert.equal(opt(baseInputs(), { goal: 'bogus' }).goal, 'spendable');
  /* The heirs' tax rate changes nothing under the default goal */
  const a = opt({ ...baseInputs(), heirTaxRate: 0 }), b = opt({ ...baseInputs(), heirTaxRate: 50 });
  assert.equal(a.chosen.rate, b.chosen.rate);
  assert.equal(a.chosen.irmaaMode, b.chosen.irmaaMode);
  near(assert, chosenOf(a).spendableWealth, chosenOf(b).spendableWealth, 0.01);
  assert.equal(E.validateInputs({ ...old, goal: 'heirs' }, td).errors.length, 0);
});

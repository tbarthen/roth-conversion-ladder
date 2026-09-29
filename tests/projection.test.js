/* Tests for the multi-year projection, optimizer, input handling and
   summary metrics. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, td, baseInputs, near } = require('./helpers');

const START = 2026;
const run = (inputs, scenario = 'noConversion', opts = {}) =>
  E.runProjection(inputs, scenario, { startYear: START, ...opts }, td);

/** Money in = money out, every retired year:
 *  change in assets = growth (dividends included) + SS + pension - spending - taxes + unpaid spending */
function assertConservation(inputs, rows) {
  const n = E.normalizeInputs(inputs, td);
  let prev = { tradBal: n.traditionalBalance, rothBal: n.rothBalance, taxBal: n.taxableBalance, hsaBal: n.hsaBalance };
  for (const r of rows) {
    if (!r.working) {
      const growth = prev.tradBal * n.preRetirementGrowth / 100 + prev.rothBal * n.rothGrowth / 100
        + prev.taxBal * n.taxableGrowth / 100 + prev.hsaBal * n.preRetirementGrowth / 100;
      const before = prev.tradBal + prev.rothBal + prev.taxBal + prev.hsaBal;
      const after = r.tradBal + r.rothBal + r.taxBal + r.hsaBal;
      const expected = growth + r.ssIncome + r.pension + r.otherIncomeTaxFree - r.spendingTarget - r.totalTax + r.unmetSpending;
      assert.ok(Math.abs((after - before) - expected) < 5 + 1e-6 * before,
        `age ${r.age}: assets moved ${after - before}, expected ${expected}`);
    }
    prev = r;
  }
}

function assertSane(rows) {
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `age ${r.age}: ${k} = ${v}`);
    }
    for (const k of ['tradBal', 'rothBal', 'taxBal', 'hsaBal', 'totalTax', 'conversionAmount', 'unmetSpending']) {
      assert.ok(r[k] >= 0, `age ${r.age}: ${k} negative`);
    }
    assert.ok(r.taxBasis <= r.taxBal + 1e-6);
  }
}

test('dividends are part of the taxable account total return, not extra', () => {
  const rows = run(baseInputs({ dividendYield: 2, taxableGrowth: 5, annualSpending: 0, ssAnnualBenefit: 0, traditionalBalance: 0, taxableBalance: 100000, taxableCostBasis: 100000 }));
  near(assert, rows[0].dividendIncome, 2000, 1e-6);
  near(assert, rows[0].taxBal, 105000 - rows[0].totalTax, 1e-6);
  near(assert, rows[0].taxBasis, 102000 - rows[0].totalTax, 1e-6);
});

test('projection spans current age through life expectancy', () => {
  const rows = run(baseInputs());
  assert.equal(rows[0].age, 60);
  assert.equal(rows[0].year, START);
  assert.equal(rows.at(-1).age, 90);
  assertSane(rows);
});

test('money is conserved every retired year (all strategies and tax sources)', () => {
  const variants = [
    baseInputs(),
    baseInputs({ dividendYield: 2, hsaBalance: 30000 }),
    baseInputs({ filingStatus: 'marriedFilingJointly', spouseAge: 58, spouseLifeExpectancy: 85, spouseSsBenefit: 20000, pensionIncome: 12000 }),
    baseInputs({ currentAge: 52, retirementAge: 52, taxableBalance: 20000, rothBalance: 0 })
  ];
  for (const inp of variants) {
    assertConservation(inp, run(inp));
    assertConservation(inp, run(inp, 'optimized', { targetBracketRate: 0.22 }));
    assertConservation(inp, run(inp, 'optimized', { targetBracketRate: 0.24, taxPaymentSource: 'conversion' }));
    assertConservation(inp, run(inp, 'custom', { customConversion: 40000, irmaaMode: 'avoid' }));
  }
});

test('traditional IRA pays for spending when other accounts run dry (with 10% penalty before 59½)', () => {
  const inp = baseInputs({ currentAge: 55, retirementAge: 55, traditionalBalance: 1000000, rothBalance: 0, taxableBalance: 0, taxableCostBasis: '', annualSpending: 40000, ssAnnualBenefit: 0 });
  const rows = run(inp);
  const y0 = rows[0];
  assert.equal(y0.unmetSpending, 0);
  assert.ok(y0.tradWithdrawal > 40000, 'gross-up for tax');
  near(assert, y0.earlyWithdrawalPenalty, 0.1 * y0.tradWithdrawal, 0.01);
  near(assert, y0.tradWithdrawal, 40000 + y0.totalTax, 1);
  const age60 = rows.find(r => r.age === 60);
  assert.equal(age60.earlyWithdrawalPenalty, 0);
  assertConservation(inp, rows);
});

test('extra RMD cash is reinvested in the taxable account, not lost', () => {
  const inp = baseInputs({ currentAge: 76, retirementAge: 60, traditionalBalance: 2000000, taxableBalance: 0, taxableCostBasis: '', rothBalance: 0, annualSpending: 10000, ssAnnualBenefit: 40000, ssStartAge: 67 });
  const rows = run(inp);
  assert.ok(rows[0].rmd > 80000);
  assert.ok(rows[0].surplusReinvested > 50000);
  near(assert, rows[0].taxBal, rows[0].surplusReinvested, 1);
  near(assert, rows[0].taxBasis, rows[0].taxBal, 1);
  assertConservation(inp, rows);
});

test('optimized strategy fills ordinary income up to the target bracket', () => {
  const inp = baseInputs({ traditionalBalance: 2000000 });
  const rows = run(inp, 'optimized', { targetBracketRate: 0.12 });
  near(assert, rows[0].ordinaryTaxableIncome, 50400, 1);
  const inflated = rows[3];
  near(assert, inflated.ordinaryTaxableIncome, 50400 * Math.pow(1.02, 3), 1);
  /* with Social Security phasing in, the solver still lands on the ceiling */
  const withSS = run(baseInputs({ currentAge: 68, traditionalBalance: 2000000, ssStartAge: 67 }), 'optimized', { targetBracketRate: 0.22 });
  near(assert, withSS[0].ordinaryTaxableIncome, 105700, 1);
  assert.ok(withSS[0].taxableSS > 0);
});

test('working-year conversions can be turned off, and pre-tax contributions reduce taxable wages', () => {
  const inp = baseInputs({ currentAge: 50, retirementAge: 55, grossIncome: 150000, annualContributions: { traditional: 20000, roth: 0, taxable: 5000, hsa: 4000 }, convertWhileWorking: 'no' });
  const rows = run(inp, 'optimized', { targetBracketRate: 0.24 });
  assert.equal(rows[0].working, true);
  assert.equal(rows[0].conversionAmount, 0);
  assert.equal(rows[0].paycheckTax, rows[0].totalTax, 'the paycheck covers the whole tax');
  assert.equal(rows[0].agi, 126000);
  near(assert, rows[0].taxableIncome, 126000 - 16100);
  assert.equal(rows[5].working, false);
});

test('conversions are capped at the traditional balance', () => {
  const rows = run(baseInputs({ traditionalBalance: 30000 }), 'custom', { customConversion: 100000 });
  assert.ok(rows[0].conversionAmount <= 30000 * 1.05 + 1e-6);
  assert.ok(rows[1].conversionAmount < 1);
});

test('IRMAA uses MAGI from exactly two years earlier', () => {
  const inp = baseInputs({ currentAge: 70, traditionalBalance: 3000000, filingStatus: 'marriedFilingJointly', spouseAge: 70, spouseLifeExpectancy: 95, spouseSsBenefit: 20000 });
  const rows = run(inp, 'custom', { customConversion: 150000 });
  for (let k = 2; k < 8; k++) assert.equal(rows[k].irmaaMagi, rows[k - 2].agi);
  assert.equal(rows[3].medicarePeople, 2);
  assert.ok(rows.some(r => r.irmaaSurcharge > 0));
  /* before any history, the first years use this year's income without the conversion */
  assert.ok(rows[0].irmaaMagi < rows[0].agi);
});

test('IRMAA "avoid" mode keeps conversion-year MAGI under the next threshold', () => {
  const inp = baseInputs({ currentAge: 63, traditionalBalance: 2000000, taxableBalance: 500000, taxableCostBasis: 500000 });
  const ignore = run(inp, 'optimized', { targetBracketRate: 0.24, irmaaMode: 'ignore' });
  const avoid = run(inp, 'optimized', { targetBracketRate: 0.24, irmaaMode: 'avoid' });
  assert.ok(ignore[0].agi > 109000 * 1.02 ** 2);
  assert.ok(avoid[0].conversionAmount > 0);
  assert.ok(avoid[0].agi <= 109000 * 1.02 ** 2 - 1000 + 1);
  assert.ok(avoid[0].conversionAmount < ignore[0].conversionAmount);
});

test('Roth ladder: unseasoned conversions withdrawn before 59½ pay 10%; contributions never do', () => {
  const inp = baseInputs({ currentAge: 55, retirementAge: 55, traditionalBalance: 1000000, rothBalance: 0, taxableBalance: 0, taxableCostBasis: '', annualSpending: 30000, ssAnnualBenefit: 0 });
  const rows = run(inp, 'custom', { customConversion: 100000 });
  assert.ok(rows[0].rothWithdrawal > 0);
  near(assert, rows[0].rothPenalty, 0.1 * rows[0].rothWithdrawal, 0.01);
  assert.equal(rows.find(r => r.age === 60).rothPenalty, 0);
  const seasoned = run(baseInputs({ currentAge: 55, retirementAge: 55, rothBalance: 500000, taxableBalance: 0, taxableCostBasis: '', ssAnnualBenefit: 0 }), 'custom', { customConversion: 20000 });
  assert.ok(seasoned[0].rothWithdrawal > 0);
  assert.equal(seasoned[0].rothPenalty, 0);
});

test('paying tax from the conversion: withheld tax never reaches the Roth', () => {
  const inp = baseInputs({ currentAge: 62, taxableBalance: 400000, taxableCostBasis: 400000 });
  const rows = run(inp, 'custom', { customConversion: 60000, taxPaymentSource: 'conversion' });
  const r = rows[0];
  assert.ok(r.taxFromConversion > 0);
  near(assert, r.taxFromConversion, Math.min(r.totalTax, r.conversionAmount), 1);
  near(assert, r.rothBal, 50000 * 1.05 + r.conversionAmount - r.taxFromConversion - r.rothWithdrawal, 1);
  const young = run(baseInputs({ currentAge: 50, retirementAge: 50 }), 'custom', { customConversion: 60000, taxPaymentSource: 'conversion' });
  near(assert, young[0].earlyWithdrawalPenalty, 0.1 * young[0].taxFromConversion, 0.5);
});

test('survivor: filing switches to single after spouse dies; larger SS benefit continues', () => {
  /* both 70 and collecting since 67: the amounts entered are what they receive now */
  const inp = baseInputs({ currentAge: 70, lifeExpectancy: 80, filingStatus: 'marriedFilingJointly', spouseAge: 70, spouseLifeExpectancy: 72,
    ssAnnualBenefit: 20000, spouseSsBenefit: 30000, ssStartAge: 67, spouseSsStartAge: 67, inflationRate: 0 });
  const rows = run(inp);
  assert.equal(rows[2].filingStatus, 'marriedFilingJointly');
  near(assert, rows[2].ssIncome, 50000, 0.01);
  assert.equal(rows[3].filingStatus, 'single');
  near(assert, rows[3].ssIncome, 30000, 0.01);
  assert.equal(rows[3].medicarePeople, 1);
});

test('RMDs start at 75 for people born in 1960 or later', () => {
  const rows = run(baseInputs({ currentAge: 66 }));
  assert.equal(rows.find(r => r.age === 74).rmd, 0);
  assert.ok(rows.find(r => r.age === 75).rmd > 0);
});

test('Social Security is adjusted for the claiming age', () => {
  const rows = run(baseInputs({ currentAge: 62, ssStartAge: 62, inflationRate: 0 }));
  near(assert, rows[0].ssIncome, 30000 * 0.7, 0.01);
  const late = run(baseInputs({ currentAge: 70, ssStartAge: 70, inflationRate: 0 }));
  near(assert, late[0].ssIncome, 30000 * E.ssClaimingFactor(td, START - 70, 70), 0.01);
});

test('state: brackets by default, a typed rate overrides, no state means no tax', () => {
  const ca = run(baseInputs({ stateAbbr: 'CA', traditionalBalance: 1e6 }), 'custom', { customConversion: 80000 });
  const flat = run(baseInputs({ stateAbbr: 'CA', stateTaxRateOverride: 5, traditionalBalance: 1e6 }), 'custom', { customConversion: 80000 });
  const none = run(baseInputs({ traditionalBalance: 1e6 }), 'custom', { customConversion: 80000 });
  assert.equal(none[0].stateTax, 0);
  assert.ok(ca[0].stateTax > 0 && ca[0].stateTax < 0.133 * ca[0].taxableIncome, 'progressive, below top rate');
  /* the override rate applies to California's own base: state income less the
     CA deduction, less the CA credit */
  const t = flat[0].taxDetail;
  near(assert, t.stateTaxableIncome, t.stateIncome - 5540, 0.01);
  near(assert, flat[0].stateTax, 0.05 * t.stateTaxableIncome - 153, 0.01);
  /* legacy profiles: a bare stateTaxRate with no state acts as an override */
  assert.equal(E.normalizeInputs({ stateAbbr: '--', stateTaxRate: 4 }, td).stateMode, 'flat');
});

test('state: Pennsylvania, Illinois and Mississippi do not tax a retiree\'s Roth conversion', () => {
  /* 65, retired, no taxable account (so no dividends or gains), SS not started:
     the year's only income is the 60,000 conversion. */
  const inputs = (stateAbbr) => baseInputs({ currentAge: 65, retirementAge: 60, stateAbbr, taxableBalance: 0, taxableCostBasis: 0,
    rothBalance: 200000, ssStartAge: 70 });
  for (const abbr of ['PA', 'IL', 'MS']) {
    const rows = run(inputs(abbr), 'custom', { customConversion: 60000 });
    assert.equal(rows[0].conversionAmount, 60000, abbr);
    assert.equal(rows[0].stateTax, 0, abbr);
    near(assert, rows[0].taxDetail.stateExcludedRetirement, 60000, 0.01, abbr);
  }
  /* Ohio has no exclusion: 60,000 - 2,400 exemption = 57,600 is taxed:
     1.27448% x 26,050 (Ohio's $332 base tax) + 2.75% x 31,550 = 332.00 + 867.63 = 1,199.63 */
  const oh = run(inputs('OH'), 'custom', { customConversion: 60000 });
  near(assert, oh[0].stateTax, 1199.62704, 0.01);
});

test('state: Colorado leaves each person\'s Social Security out of its base from age 65', () => {
  /* 66 and 63, both collecting (30,000 + 15,000), pension 40,000, no other income
     (taxable account at cost, no growth). Taxable SS: provisional 40,000 + 22,500
     = 62,500 -> 6,000 + 85% x 18,500 = 21,725; AGI 61,725. Only the 66-year-old's
     2/3 share is exempt: 61,725 - 14,483.33 - 32,200 = 15,041.67 x 4.4% = 661.83.
     (Taxing all of it would give 1,299.10.) From the year the spouse turns 65
     the whole taxable SS is out of the Colorado base. */
  const inp = baseInputs({ currentAge: 66, retirementAge: 65, filingStatus: 'marriedFilingJointly', spouseAge: 63, spouseLifeExpectancy: 90,
    stateAbbr: 'CO', ssAnnualBenefit: 30000, ssStartAge: 65, spouseSsBenefit: 15000, spouseSsStartAge: 62, pensionIncome: 40000,
    taxableBalance: 400000, taxableCostBasis: 400000, taxableGrowth: 0, dividendYield: 0, annualSpending: 60000,
    inflationRate: 0, bracketInflation: 0 });
  const rows = run(inp);
  near(assert, rows[0].ssIncome, 45000, 0.01);
  near(assert, rows[0].taxableSS, 21725, 0.01);
  near(assert, rows[0].taxDetail.stateIncome, 61725 - 21725 * 2 / 3, 0.01);
  near(assert, rows[0].stateTax, 661.83, 0.01);
  near(assert, rows[1].stateTax, 661.83, 0.01); /* spouse 64 */
  near(assert, rows[2].taxDetail.stateIncome, rows[2].agi - rows[2].taxableSS, 0.01); /* spouse 65 */
  /* single, 70: nothing of the SS is taxed by Colorado; at 64 all of it is */
  const single70 = run(baseInputs({ currentAge: 70, retirementAge: 65, stateAbbr: 'CO', ssStartAge: 67, pensionIncome: 40000 }))[0];
  near(assert, single70.taxDetail.stateIncome, single70.agi - single70.taxableSS, 0.01);
  const single64 = run(baseInputs({ currentAge: 64, retirementAge: 60, stateAbbr: 'CO', ssStartAge: 62, pensionIncome: 40000 }))[0];
  assert.ok(single64.taxableSS > 0);
  near(assert, single64.taxDetail.stateIncome, single64.agi, 0.01);
  /* Minnesota (no age rule) still taxes it */
  const mn = run(baseInputs({ currentAge: 70, retirementAge: 65, stateAbbr: 'MN', ssStartAge: 67, pensionIncome: 40000 }))[0];
  near(assert, mn.taxDetail.stateIncome, mn.agi, 0.01);
});

test('Social Security: a benefit already being collected is not adjusted for the claiming age again', () => {
  /* 72, started at 70: the 30,000 entered is what arrives now, not the
     full-retirement-age amount (x 1.24 would count the delay credit twice). */
  const collecting = run(baseInputs({ currentAge: 72, ssStartAge: 70, inflationRate: 0 }));
  near(assert, collecting[0].ssIncome, 30000, 0.01);
  /* 66, started at 62: no second early-claiming cut either */
  near(assert, run(baseInputs({ currentAge: 66, ssStartAge: 62, inflationRate: 0 }))[0].ssIncome, 30000, 0.01);
  /* spouse 68, started at 63: 20,000 as entered */
  const mfj = run(baseInputs({ currentAge: 72, ssStartAge: 70, inflationRate: 0, filingStatus: 'marriedFilingJointly',
    spouseAge: 68, spouseLifeExpectancy: 90, spouseSsBenefit: 20000, spouseSsStartAge: 63 }));
  near(assert, mfj[0].ssIncome, 50000, 0.01);
  /* not collecting yet (start age at or above current age): still the FRA amount, adjusted */
  const later = run(baseInputs({ currentAge: 68, ssStartAge: 70, inflationRate: 0 }));
  near(assert, later[2].ssIncome, 30000 * E.ssClaimingFactor(td, START - 68, 70), 0.01);
  assert.equal(E.normalizeInputs(baseInputs({ currentAge: 72, ssStartAge: 70 }), td).ssAlreadyCollecting, true);
  assert.equal(E.normalizeInputs(baseInputs({ currentAge: 70, ssStartAge: 70 }), td).ssAlreadyCollecting, false);
});

test('fuzz: random profiles never produce NaN, negatives or lost money', () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const statuses = ['single', 'marriedFilingJointly', 'marriedFilingSeparately'];
  for (let i = 0; i < 200; i++) {
    const age = 45 + Math.floor(rnd() * 35);
    const inp = baseInputs({
      currentAge: age, retirementAge: age + Math.floor(rnd() * 8), lifeExpectancy: Math.min(110, age + 5 + Math.floor(rnd() * 30)),
      filingStatus: pick(statuses), spouseAge: age - 15 + Math.floor(rnd() * 20), spouseLifeExpectancy: 70 + Math.floor(rnd() * 30),
      traditionalBalance: Math.round(rnd() * 3e6), rothBalance: Math.round(rnd() * 5e5), taxableBalance: Math.round(rnd() * 1e6),
      taxableCostBasis: rnd() < 0.3 ? '' : Math.round(rnd() * 1e6), hsaBalance: Math.round(rnd() * 1e5),
      grossIncome: Math.round(rnd() * 3e5), ssAnnualBenefit: Math.round(rnd() * 5e4), ssStartAge: 62 + Math.floor(rnd() * 9),
      spouseSsBenefit: Math.round(rnd() * 4e4), pensionIncome: rnd() < 0.3 ? Math.round(rnd() * 5e4) : 0,
      annualSpending: Math.round(2e4 + rnd() * 2e5), preRetirementGrowth: -2 + rnd() * 12, dividendYield: rnd() * 3,
      stateAbbr: pick(['--', 'CA', 'NY', 'TX', 'PA', 'OR']), annualContributions: { traditional: 10000, roth: 5000, taxable: 5000, hsa: 3000 }
    });
    inp.rothGrowth = inp.taxableGrowth = inp.preRetirementGrowth;
    for (const [scen, opts] of [['noConversion', {}], ['optimized', { targetBracketRate: pick(E.TARGET_BRACKETS), irmaaMode: pick(['avoid', 'ignore']), taxPaymentSource: pick(['taxable', 'conversion']) }]]) {
      const rows = run(inp, scen, opts);
      assertSane(rows);
      assertConservation(inp, rows);
    }
  }
});

test('optimizer tries every bracket in auto mode and returns the best', () => {
  const inp = baseInputs({ traditionalBalance: 1500000 });
  /* heirs goal: the highest net position (after-tax estate less unpaid spending) */
  const r = E.optimizeStrategy(inp, td, { targetBracket: 'auto', startYear: START, goal: 'heirs' });
  assert.equal(r.candidates.length, E.TARGET_BRACKETS.length * 2);
  const best = Math.max(...r.candidates.map(c => c.netPosition));
  near(assert, E.strategyScore(r.scenarioB), best, 1.01);
  assert.equal(r.chosen.auto, true);
  assert.equal(r.scenarioC, null);
  /* default goal: the most spendable wealth among the plans that leave the least spending unpaid */
  const sp = E.optimizeStrategy(inp, td, { targetBracket: 'auto', startYear: START });
  assert.equal(sp.goal, 'spendable');
  const leastUnmet = Math.min(...sp.candidates.map(c => c.unmetSpending));
  const richest = Math.max(...sp.candidates.filter(c => c.unmetSpending <= leastUnmet + 1).map(c => c.spendableWealth));
  near(assert, E.planMetrics(sp.scenarioB, 2).spendableWealth, richest, 1.01);
  assert.equal(sp.candidates.filter(c => c.chosen).length, 1);
  const fixed = E.optimizeStrategy(inp, td, { targetBracket: '0.22', customConversion: 30000, startYear: START });
  assert.equal(fixed.chosen.rate, 0.22);
  assert.equal(fixed.candidates.length, 2);
  assert.ok(Array.isArray(fixed.scenarioC));
});

test('optimizer runs quickly on the sample profiles', () => {
  const t0 = Date.now();
  for (const age of [50, 55, 60, 68]) E.optimizeStrategy(baseInputs({ currentAge: age, traditionalBalance: 2e6 }), td, { startYear: START });
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
});

test('break-even age: when lifetime taxes of the conversion plan stop exceeding the baseline', () => {
  const rows = (cum) => cum.map((c, i) => ({ age: 60 + i, cumulativeTax: c }));
  assert.equal(E.findBreakevenAge(rows([0, 10, 20, 30]), rows([5, 15, 18, 25])), 62);
  assert.equal(E.findBreakevenAge(rows([0, 10, 20, 30]), rows([5, 15, 25, 35])), null); /* never */
  assert.equal(E.findBreakevenAge(rows([5, 10, 20]), rows([5, 10, 20])), null); /* identical */
  assert.equal(E.findBreakevenAge(rows([5, 10, 20]), rows([4, 9, 19])), null); /* ahead from the start */
  assert.equal(E.findBreakevenAge(rows([0, 10, 20, 30]), rows([5, 8, 25, 29])), 63); /* dips, then behind again */
});

test('effective rate and plain-English summary', () => {
  assert.equal(E.effectiveRate({ agi: 500, totalTax: 100 }), 0);
  near(assert, E.effectiveRate({ agi: 100000, totalTax: 15000 }), 15);
  assert.equal(E.effectiveRate(null), null);
  const r = E.optimizeStrategy(baseInputs({ traditionalBalance: 1500000 }), td, { startYear: START });
  const s = E.summarizePlan(r, 2);
  assert.equal(typeof s.worthIt, 'boolean');
  assert.equal(s.finalAge, 90);
  if (s.conversionYears > 0) {
    assert.ok(s.firstConversion.amountToday > 0);
    assert.ok(s.averageConversionToday > 0);
  }
  /* default goal: the headline gain is the spendable-wealth gain; tax saved and the estate gain are still reported */
  assert.equal(s.goal, 'spendable');
  near(assert, s.gainToday, s.spendableB - s.spendableA, 1e-6);
  near(assert, s.taxSavedToday, s.lifetimeTaxA - s.lifetimeTaxB, 1e-6);
  near(assert, s.estateGainToday, (E.strategyScore(r.scenarioB) - E.strategyScore(r.scenarioA)) / 1.02 ** 30, 1);
  const h = E.summarizePlan(E.optimizeStrategy(baseInputs({ traditionalBalance: 1500000 }), td, { startYear: START, goal: 'heirs' }), 2);
  assert.equal(h.goal, 'heirs');
  near(assert, h.gainToday, h.estateGainToday, 1e-6);
});

test('normalizeInputs fills defaults and clamps bad values', () => {
  const n = E.normalizeInputs({ currentAge: '61', annualSpending: '50000', taxableBalance: 1000, taxableCostBasis: 5000, lifeExpectancy: 40, preRetirementGrowth: 99, filingStatus: 'bogus' }, td);
  assert.equal(n.currentAge, 61);
  assert.equal(n.retirementAge, 61);
  assert.equal(n.lifeExpectancy, 62);
  assert.equal(n.taxableCostBasis, 1000);
  assert.equal(n.preRetirementGrowth, 30);
  assert.equal(n.filingStatus, 'single');
  assert.equal(n.spouseAge, null);
  assert.equal(n.heirTaxRate, 24);
  assert.equal(E.normalizeInputs({ taxableBalance: 1000, taxableCostBasis: '' }, td).taxableCostBasis, 1000);
});

test('validateInputs explains problems in plain English', () => {
  const v = E.validateInputs({});
  assert.deepEqual(v.errors.map(e => e.field).sort(), ['annualSpending', 'currentAge']);
  const mfj = E.validateInputs({ currentAge: 60, annualSpending: 50000, filingStatus: 'marriedFilingJointly' });
  assert.ok(mfj.errors.some(e => e.field === 'spouseAge'));
  const le = E.validateInputs({ currentAge: 60, annualSpending: 1, lifeExpectancy: 55 });
  assert.ok(le.errors.some(e => e.field === 'lifeExpectancy'));
  const neg = E.validateInputs({ currentAge: 60, annualSpending: 1, traditionalBalance: -5 });
  assert.ok(neg.errors.some(e => e.field === 'traditionalBalance'));
  const warn = E.validateInputs({ currentAge: 60, annualSpending: 1, retirementAge: 55, taxableBalance: 100, taxableCostBasis: 500 });
  assert.equal(warn.errors.length, 0);
  assert.deepEqual(warn.warnings.map(w => w.field).sort(), ['retirementAge', 'taxableCostBasis']);
  const text = E.validateInputs({ currentAge: 'abc', annualSpending: 1 });
  assert.match(text.errors[0].message, /must be a number/);
  const outlive = E.validateInputs({ currentAge: 60, annualSpending: 1, lifeExpectancy: 80, filingStatus: 'marriedFilingJointly', spouseAge: 55, spouseLifeExpectancy: 95 });
  assert.ok(outlive.warnings.some(w => /outlive/.test(w.message)));
});

test('cash flow settles to a consistent fixed point when the IRMAA cap and IRA spending withdrawals interact', () => {
  /* Both profiles made the old loop cycle between four states, ending on an
     inconsistent one that dropped tens of thousands of dollars a year. */
  const a = baseInputs({ currentAge: 72, retirementAge: 74, lifeExpectancy: 105, filingStatus: 'single', stateAbbr: 'PA',
    traditionalBalance: 2955035, rothBalance: 244243, taxableBalance: 865713, taxableCostBasis: '', hsaBalance: 34811,
    annualContributions: { traditional: 10000, roth: 5000, taxable: 5000, hsa: 3000 }, grossIncome: 262152,
    ssAnnualBenefit: 42666, ssStartAge: 65, annualSpending: 211527, preRetirementGrowth: 2.15257, rothGrowth: 2.15257,
    taxableGrowth: 2.15257, dividendYield: 1.55386 });
  const b = baseInputs({ currentAge: 77, retirementAge: 80, lifeExpectancy: 109, filingStatus: 'marriedFilingSeparately', stateAbbr: 'CA',
    traditionalBalance: 1783978, rothBalance: 43556, taxableBalance: 111319, taxableCostBasis: 983950, hsaBalance: 60589,
    annualContributions: { traditional: 10000, roth: 5000, taxable: 5000, hsa: 3000 }, grossIncome: 210516,
    ssAnnualBenefit: 27745, ssStartAge: 64, annualSpending: 181785, preRetirementGrowth: 0.91921, rothGrowth: 0.91921,
    taxableGrowth: 0.91921, dividendYield: 0.95729 });
  for (const inp of [a, b]) {
    for (const irmaaMode of ['avoid', 'ignore']) {
      const rows = run(inp, 'optimized', { targetBracketRate: 0.35, irmaaMode, taxPaymentSource: 'taxable' });
      assertSane(rows);
      assertConservation(inp, rows);
    }
  }
});

test('IRMAA after a spouse dies: the lookback years are judged on the joint return that was filed', () => {
  const inp = baseInputs({ currentAge: 70, retirementAge: 60, lifeExpectancy: 80, filingStatus: 'marriedFilingJointly', spouseAge: 70, spouseLifeExpectancy: 72,
    traditionalBalance: 3000000, rothBalance: 0, taxableBalance: 500000, taxableCostBasis: 500000, ssAnnualBenefit: 40000, spouseSsBenefit: 30000,
    pensionIncome: 100000, annualSpending: 120000 });
  const rows = run(inp);
  assert.equal(rows[3].filingStatus, 'single');
  assert.ok(rows[3].irmaaMagi < 218000 * 1.02 ** 3, 'joint-return MAGI is under the joint threshold');
  assert.equal(rows[3].irmaaSurcharge, 0); /* 2027 joint return, judged on joint thresholds */
  assert.equal(rows[4].irmaaSurcharge, 0); /* 2028 joint return */
  assert.ok(rows[5].irmaaSurcharge > 0);   /* first single return */
});

test('no-conversion baseline: once penalty-free, spending comes from the traditional account before the Roth', () => {
  const older = baseInputs({ currentAge: 65, retirementAge: 65, taxableBalance: 0, taxableCostBasis: '', rothBalance: 150000, traditionalBalance: 500000, ssAnnualBenefit: 0 });
  const rows = run(older);
  assert.ok(rows[0].tradWithdrawal > 0, 'IRA pays for spending');
  assert.equal(rows[0].rothWithdrawal, 0);
  assert.ok(rows[0].taxableIncome > 0, 'the standard deduction is not wasted');
  assertConservation(older, rows);
  /* before 59½ the Roth (contributions, seasoned conversions) still comes first */
  const younger = run(baseInputs({ currentAge: 55, retirementAge: 55, taxableBalance: 0, taxableCostBasis: '', rothBalance: 150000, traditionalBalance: 500000, ssAnnualBenefit: 0 }));
  assert.ok(younger[0].rothWithdrawal > 0);
  assert.equal(younger[0].tradWithdrawal, 0);
  /* conversion plans fill the bracket with the conversion and spend from the Roth */
  const conv = run(older, 'custom', { customConversion: 20000 });
  assert.ok(conv[0].rothWithdrawal > 0);
  assert.equal(conv[0].tradWithdrawal, 0);
});

test('state: California adds its senior credit for each person from age 65', () => {
  const opts = { retirementAge: 60, stateAbbr: 'CA', pensionIncome: 40000, inflationRate: 0, bracketInflation: 0 };
  const couple = run(baseInputs({ ...opts, currentAge: 66, filingStatus: 'marriedFilingJointly', spouseAge: 63, spouseLifeExpectancy: 90 }));
  near(assert, couple[0].taxDetail.stateCredit, 306 + 153, 0.01); /* personal 2 x 153, senior for the 66-year-old */
  near(assert, couple[1].taxDetail.stateCredit, 459, 0.01);       /* spouse 64 */
  near(assert, couple[2].taxDetail.stateCredit, 612, 0.01);       /* spouse 65 */
  near(assert, run(baseInputs({ ...opts, currentAge: 64 }))[0].taxDetail.stateCredit, 153, 0.01);
  near(assert, run(baseInputs({ ...opts, currentAge: 65 }))[0].taxDetail.stateCredit, 306, 0.01);
  /* Nevada-style no-tax state and a state without a senior credit are unaffected */
  near(assert, run(baseInputs({ ...opts, stateAbbr: 'NY', currentAge: 70 }))[0].taxDetail.stateCredit, 0, 0.01);
});

/* ---- Social Security survivor benefits ---- */

test('widowed: survivor benefit first (reduced), own benefit with delayed credits from 70', () => {
  /* born 1965: retirement FRA 67, survivor FRA 67. Survivor at 61 = 72 of 84 months early. */
  const inp = baseInputs({ currentAge: 61, retirementAge: 61, filingStatus: 'widowed', inflationRate: 0,
    ssAnnualBenefit: 30000, ssStartAge: 70, survivorBenefit: 30000, survivorBenefitType: 'fra', survivorStartAge: 61 });
  const n = E.normalizeInputs(inp, td);
  assert.equal(n.filingStatus, 'single');
  assert.equal(n.widowed, true);
  assert.equal(n.survivorAlreadyCollecting, false);
  const rows = run(inp);
  const survivor = 30000 * (1 - 0.285 * 72 / 84);
  near(assert, rows[0].ssIncome, survivor, 0.01);
  assert.equal(rows[0].ssSource, 'survivor');
  assert.equal(rows[0].filingStatus, 'single');
  const at = (age) => rows.find(r => r.age === age);
  near(assert, at(69).ssIncome, survivor, 0.01);
  near(assert, at(70).ssIncome, 37200, 0.01);       /* own: 124% of 30,000 beats the survivor benefit */
  assert.equal(at(70).ssSource, 'own');
  near(assert, at(70).ssSurvivor, survivor, 0.01);  /* still entitled, just smaller */
  near(assert, at(70).ssOwn, 37200, 0.01);
  assertConservation(inp, rows);
});

test('widowed: own benefit first (reduced), unreduced survivor benefit from survivor FRA', () => {
  const inp = baseInputs({ currentAge: 62, retirementAge: 62, filingStatus: 'widowed', inflationRate: 0,
    ssAnnualBenefit: 20000, ssStartAge: 62, survivorBenefit: 30000, survivorBenefitType: 'fra', survivorStartAge: 67 });
  const rows = run(inp);
  const at = (age) => rows.find(r => r.age === age);
  near(assert, at(62).ssIncome, 14000, 0.01);       /* 70% of 20,000; the early own claim never touches the survivor benefit */
  assert.equal(at(62).ssSource, 'own');
  near(assert, at(66).ssIncome, 14000, 0.01);
  near(assert, at(67).ssIncome, 30000, 0.01);
  assert.equal(at(67).ssSource, 'survivor');
  near(assert, at(80).ssIncome, 30000, 0.01);
});

test('widowed: a survivor benefit already being collected is paid as entered; late spouse who claimed early is capped', () => {
  /* 63, collecting the survivor benefit since 60: 21,450 is what arrives now */
  const collecting = run(baseInputs({ currentAge: 63, filingStatus: 'widowed', inflationRate: 0,
    ssAnnualBenefit: 30000, ssStartAge: 70, survivorBenefit: 21450, survivorStartAge: 60 }));
  assert.equal(E.normalizeInputs(collecting.length && baseInputs({ currentAge: 63, filingStatus: 'widowed', survivorStartAge: 60 }), td).survivorAlreadyCollecting, true);
  near(assert, collecting[0].ssIncome, 21450, 0.01);
  near(assert, collecting.find(r => r.age === 70).ssIncome, 37200, 0.01);
  /* late spouse (born 1964, FRA 67) started at 62 and was getting 21,000: full amount 30,000; survivor at 67 gets 82.5% = 24,750 */
  const capped = run(baseInputs({ currentAge: 61, filingStatus: 'widowed', inflationRate: 0, ssAnnualBenefit: 0,
    survivorBenefit: 21000, survivorBenefitType: 'collecting', lateSpouseStartAge: 62, lateSpouseBirthYear: 1964, survivorStartAge: 67 }));
  assert.equal(capped[0].ssIncome, 0);
  near(assert, capped.find(r => r.age === 67).ssIncome, 24750, 0.01);
  /* same, survivor at 60: own reduction (71.5% of 30,000) is below the cap */
  const early = run(baseInputs({ currentAge: 60, filingStatus: 'widowed', inflationRate: 0, ssAnnualBenefit: 0,
    survivorBenefit: 21000, survivorBenefitType: 'collecting', lateSpouseStartAge: 62, lateSpouseBirthYear: 1964, survivorStartAge: 60 }));
  near(assert, early[0].ssIncome, 21450, 0.01);
  /* late spouse's birth year defaults to the survivor's own */
  const dflt = run(baseInputs({ currentAge: 61, filingStatus: 'widowed', inflationRate: 0, ssAnnualBenefit: 0,
    survivorBenefit: 21000, survivorBenefitType: 'collecting', lateSpouseStartAge: 62, survivorStartAge: 67 }));
  near(assert, dflt.find(r => r.age === 67).ssIncome, 24750, 0.01);
});

test('married: after the projected death the survivor benefit starts, reduced if before survivor FRA, and own can follow at 70', () => {
  /* user 60 (born 1966), spouse 64 (born 1962) starts at 65 (86.67% of 24,000 = 20,800) and dies after 66;
     the first year without the spouse the user is 63 */
  const base = { currentAge: 60, retirementAge: 60, lifeExpectancy: 90, filingStatus: 'marriedFilingJointly', inflationRate: 0,
    spouseAge: 64, spouseLifeExpectancy: 66, ssAnnualBenefit: 30000, ssStartAge: 70, spouseSsBenefit: 24000, spouseSsStartAge: 65 };
  const asap = run(baseInputs({ ...base, survivorStartAge: 60 }));
  const at = (rows, age) => rows.find(r => r.age === age);
  assert.equal(asap[0].ssIncome, 0);
  near(assert, asap[1].ssIncome, 20800, 0.01);                 /* spouse's own benefit */
  assert.equal(asap[1].ssSource, 'none');
  assert.equal(at(asap, 63).spouseAlive, false);
  const sf63 = 1 - 0.285 * 48 / 84;                            /* 48 of 84 months early */
  near(assert, at(asap, 63).ssIncome, Math.min(24000 * sf63, Math.max(20800, 24000 * 0.825)), 0.01);
  near(assert, at(asap, 63).ssIncome, 24000 * sf63, 0.01);     /* 20,091: below the RIB-LIM cap of 20,800 */
  assert.equal(at(asap, 63).ssSource, 'survivor');
  near(assert, at(asap, 69).ssIncome, 24000 * sf63, 0.01);
  near(assert, at(asap, 70).ssIncome, 37200, 0.01);
  assert.equal(at(asap, 70).ssSource, 'own');
  assertConservation(baseInputs({ ...base, survivorStartAge: 60 }), asap);
  /* survivor start age 67 (the default): nothing from 63 to 66, then the capped amount */
  const wait = run(baseInputs(base));
  assert.equal(at(wait, 63).ssIncome, 0);
  assert.equal(at(wait, 66).ssIncome, 0);
  near(assert, at(wait, 67).ssIncome, 20800, 0.01);            /* min(24,000, max(20,800, 19,800)) */
  near(assert, at(wait, 70).ssIncome, 37200, 0.01);
});

test('married: a spouse who dies after FRA without claiming leaves delayed credits to the survivor', () => {
  /* spouse 68 (born 1958, FRA 66y8m) planned to start at 70 but dies after this year: 16 months of credits = 110.67% */
  const inp = baseInputs({ currentAge: 66, retirementAge: 60, lifeExpectancy: 90, filingStatus: 'marriedFilingJointly', inflationRate: 0,
    spouseAge: 68, spouseLifeExpectancy: 68, ssAnnualBenefit: 20000, ssStartAge: 67, spouseSsBenefit: 30000, spouseSsStartAge: 70 });
  const rows = run(inp);
  assert.equal(rows[0].ssIncome, 0);
  const credits = 1 + 16 * 0.08 / 12;
  near(assert, rows[1].ssIncome, 30000 * credits, 0.01);      /* user 67 > survivor FRA (66y8m for 1960): 100% */
  assert.equal(rows[1].ssSource, 'survivor');
  assert.equal(rows[1].filingStatus, 'single');
});

test('claiming suggestion: survivor first and own at 70 when own is the larger benefit; own first when it is the smaller', () => {
  const widow = baseInputs({ currentAge: 61, retirementAge: 61, filingStatus: 'widowed', preRetirementGrowth: 5, inflationRate: 2.5,
    ssAnnualBenefit: 30000, ssStartAge: 67, survivorBenefit: 30000, survivorBenefitType: 'fra', survivorStartAge: 67 });
  const s = E.suggestSocialSecurityClaiming(widow, td, { startYear: START });
  assert.equal(s.entered.ssStartAge, 67);
  assert.equal(s.entered.survivorStartAge, 67);
  assert.equal(s.best.survivorStartAge, 61);
  assert.equal(s.best.ssStartAge, 70);
  assert.ok(s.gain > 50000, `gain ${s.gain}`);
  /* the value is consistent with the projection (today's dollars, discounted at the growth rate) */
  const rows = run({ ...widow, ssStartAge: 70, survivorStartAge: 61 });
  const pv = rows.reduce((sum, r, i) => sum + r.ssIncome / Math.pow(1.05, i), 0);
  near(assert, s.best.value, pv, 1);
  /* small own benefit: take it at 62, then the survivor benefit later */
  const smallOwn = E.suggestSocialSecurityClaiming({ ...widow, ssAnnualBenefit: 10000 }, td, { startYear: START });
  assert.equal(smallOwn.best.ssStartAge, 62);
  assert.ok(smallOwn.best.survivorStartAge > 62);
  /* already collecting the survivor benefit: only the own start age is open */
  const fixed = E.suggestSocialSecurityClaiming({ ...widow, currentAge: 63, survivorStartAge: 60, survivorBenefit: 21450 }, td, { startYear: START });
  assert.equal(fixed.best.survivorStartAge, 60);
  assert.equal(fixed.best.ssStartAge, 70);
  /* nothing to decide: not widowed, or married with the death projected after 70 */
  assert.equal(E.suggestSocialSecurityClaiming(baseInputs(), td, { startYear: START }), null);
  assert.equal(E.suggestSocialSecurityClaiming(baseInputs({ filingStatus: 'marriedFilingJointly', spouseAge: 58, spouseLifeExpectancy: 90, spouseSsBenefit: 20000 }), td, { startYear: START }), null);
  /* married with an early projected death: the survivor benefit is available before 70 */
  const early = E.suggestSocialSecurityClaiming(baseInputs({ filingStatus: 'marriedFilingJointly', spouseAge: 64, spouseLifeExpectancy: 66, spouseSsBenefit: 24000, spouseSsStartAge: 65, ssStartAge: 67 }), td, { startYear: START });
  assert.ok(early && early.best.value >= early.entered.value);
  assert.ok(early.best.survivorStartAge >= 63);
});

test('optimizer result carries the Social Security plan and the summary describes it', () => {
  const inp = baseInputs({ currentAge: 61, retirementAge: 61, filingStatus: 'widowed', inflationRate: 0,
    ssAnnualBenefit: 30000, ssStartAge: 70, survivorBenefit: 30000, survivorBenefitType: 'fra', survivorStartAge: 61 });
  const result = E.optimizeStrategy(inp, td, { startYear: START, targetBracket: 0.22 });
  const ss = result.socialSecurity;
  assert.equal(ss.widowed, true);
  near(assert, ss.survivor.factor, 1 - 0.285 * 72 / 84, 1e-9);
  near(assert, ss.survivor.amount, 30000 * (1 - 0.285 * 72 / 84), 0.01);
  assert.equal(ss.survivor.fromAge, 61);
  near(assert, ss.own.factor, 1.24, 1e-9);
  assert.equal(ss.own.fromAge, 70);
  const s = E.summarizePlan(result, 0);
  assert.deepEqual(s.ssSegments.map(x => [x.source, x.fromAge]), [['survivor', 61], ['own', 70]]);
  near(assert, s.ssSegments[0].amountToday, 30000 * (1 - 0.285 * 72 / 84), 0.01);
  assert.ok(result.claiming && result.claiming.best);
});

test('validateInputs: survivor fields, and a warning about the earnings test when a benefit starts while still working', () => {
  const w = E.validateInputs({ currentAge: 58, annualSpending: 1, filingStatus: 'widowed', survivorStartAge: 58, survivorBenefit: -1, lateSpouseStartAge: 61, lateSpouseBirthYear: 1850 });
  assert.deepEqual(w.errors.map(e => e.field).sort(), ['lateSpouseBirthYear', 'lateSpouseStartAge', 'survivorBenefit', 'survivorStartAge']);
  const working = E.validateInputs({ currentAge: 58, annualSpending: 1, retirementAge: 66, grossIncome: 80000, ssStartAge: 62, filingStatus: 'widowed', survivorStartAge: 60, survivorBenefit: 20000 }, td);
  assert.deepEqual(working.warnings.map(x => x.field).sort(), ['ssStartAge', 'survivorStartAge']);
  assert.match(working.warnings[0].message, /earn/);
  /* retired before the benefit starts, or starting at FRA: no warning */
  assert.equal(E.validateInputs({ currentAge: 58, annualSpending: 1, retirementAge: 62, grossIncome: 80000, ssStartAge: 62 }, td).warnings.length, 0);
  assert.equal(E.validateInputs({ currentAge: 58, annualSpending: 1, retirementAge: 70, grossIncome: 80000, ssStartAge: 67 }, td).warnings.length, 0);
  /* without tax data the warning is skipped, not crashed */
  assert.equal(E.validateInputs({ currentAge: 58, annualSpending: 1, retirementAge: 66, grossIncome: 80000, ssStartAge: 62 }).warnings.length, 0);
  /* married filers ignore the widowed flag; the survivor start age is still validated */
  const m = E.normalizeInputs({ currentAge: 60, filingStatus: 'marriedFilingJointly', spouseAge: 58, widowed: true, survivorBenefit: 5000 }, td);
  assert.equal(m.widowed, false);
  assert.equal(m.survivorBenefit, 0);
  assert.ok(E.validateInputs({ currentAge: 60, annualSpending: 1, filingStatus: 'marriedFilingJointly', spouseAge: 58, survivorStartAge: 59 }).errors.some(e => e.field === 'survivorStartAge'));
});

test('Medicare start age: IRMAA applies from an earlier Medicare age (SSDI)', () => {
  /* single, 60, pension 250,000: MAGI far above the first IRMAA threshold.
     At 60 with the default Medicare age (65) there is no surcharge; with
     Medicare from 58 (SSDI) the surcharge applies from the first year. */
  const opts = { currentAge: 60, retirementAge: 60, pensionIncome: 250000, inflationRate: 0, bracketInflation: 0 };
  const def = run(baseInputs(opts));
  assert.equal(def[0].medicarePeople, 0);
  assert.equal(def[0].irmaaSurcharge, 0);
  const early = run(baseInputs({ ...opts, medicareAge: 58 }));
  assert.equal(early[0].medicarePeople, 1);
  assert.ok(early[0].irmaaSurcharge > 0);
  assert.deepEqual(E.irmaaSurcharge(td, early[0].irmaaMagi, 'single', START, 0, 0, 1).annual, early[0].irmaaSurcharge);
  /* spouse on SSDI Medicare at 52; the user (54) not yet */
  const mfj = run(baseInputs({ ...opts, currentAge: 54, retirementAge: 54, filingStatus: 'marriedFilingJointly', spouseAge: 52, spouseLifeExpectancy: 90, spouseMedicareAge: 52, pensionIncome: 500000 }));
  assert.equal(mfj[0].medicarePeople, 1);
  assert.ok(mfj[0].irmaaSurcharge > 0);
  /* the standard deduction's 65+ extra is tax law, not Medicare: unchanged */
  near(assert, early[0].stdDeduction, def[0].stdDeduction, 0.01);
});

test('Medicare start age: out-of-range values are clamped, missing ones default to 65', () => {
  const n = E.normalizeInputs(baseInputs({ medicareAge: 70, spouseMedicareAge: '' }), td);
  assert.equal(n.medicareAge, 65);
  assert.equal(n.spouseMedicareAge, 65);
  assert.equal(E.normalizeInputs(baseInputs({ medicareAge: 52 }), td).medicareAge, 52);
});

test('tax-exempt interest flows into the projection: IRMAA MAGI rises, AGI does not', () => {
  /* pension low enough that Social Security is not already 85% taxable */
  const opts = { currentAge: 70, retirementAge: 65, ssStartAge: 70, pensionIncome: 15000, inflationRate: 0, bracketInflation: 0 };
  const a = run(baseInputs(opts)), b = run(baseInputs({ ...opts, taxExemptInterest: 40000 }));
  assert.ok(b[0].taxableSS > a[0].taxableSS);           /* more of the SS is taxed */
  /* first year: IRMAA MAGI is this year's MAGI = AGI + the tax-exempt interest */
  near(assert, b[0].irmaaMagi - b[0].agi, 40000, 0.01);
  near(assert, a[0].irmaaMagi, a[0].agi, 0.01);
  assert.equal(E.normalizeInputs(baseInputs({}), td).taxExemptInterest, 0);
});

test('tax-exempt interest follows the taxable balance: the amount entered in year one, none once the account is spent, only in proportion after a small refill', () => {
  /* Single retiree living on the traditional account; the 60,000 taxable account
     is gone in two years, then RMD surpluses refill it a few thousand at a time. */
  const inp = baseInputs({ currentAge: 70, retirementAge: 65, ssStartAge: 70, taxableBalance: 60000, taxableCostBasis: 60000, annualSpending: 90000,
    taxExemptInterest: 20000, inflationRate: 0, bracketInflation: 0, preRetirementGrowth: 4, taxableGrowth: 4, rothGrowth: 4, rothBalance: 0, traditionalBalance: 1500000 });
  const rows = run(inp);
  near(assert, rows[0].taxExemptInterest, 20000, 0.01, 'first year: the amount entered');
  near(assert, rows[0].taxDetail.taxExemptInterest, 20000, 0.01);
  const empty = rows.find(r => r.age === 72);
  assert.equal(empty.taxBal, 0);
  assert.equal(empty.taxExemptInterest, 0, 'nothing once the account is spent');
  const before = rows.find(r => r.age === 76), refill = rows.find(r => r.age === 77);
  assert.ok(before.taxBal > 0 && before.taxBal < 20000, `a small refilled balance (${before.taxBal})`);
  near(assert, refill.taxExemptInterest, before.taxBal * (20000 / 60000), 0.01, 'the same yield on the opening balance');
  assert.ok(refill.taxExemptInterest < 5000);
  /* ...so a few thousand dollars of bonds no longer books 20,000 of interest and an IRMAA tier */
  for (const r of rows.filter(x => x.age >= 77 && x.age <= 80)) assert.equal(r.irmaaSurcharge, 0, `no IRMAA at ${r.age}`);
  /* No taxable account: nothing counted, and the form says so */
  const none = run(baseInputs({ taxableBalance: 0, taxableCostBasis: 0, taxExemptInterest: 5000 }));
  assert.equal(none[0].taxExemptInterest, 0);
  near(assert, none[0].taxDetail.magi, none[0].agi, 0.01);
  assert.ok(E.validateInputs(baseInputs({ taxableBalance: 0, taxExemptInterest: 5000 }), td).warnings.some(w => w.field === 'taxExemptInterest'));
  assert.ok(!E.validateInputs(baseInputs({ taxableBalance: 100000, taxExemptInterest: 5000 }), td).warnings.some(w => w.field === 'taxExemptInterest'));
});

test('HSA contributions stop at the Medicare start age (none are allowed once on Medicare)', () => {
  const inp = baseInputs({ currentAge: 60, retirementAge: 64, grossIncome: 100000, hsaBalance: 10000, medicareAge: 62,
    annualContributions: { traditional: 0, roth: 0, taxable: 0, hsa: 4000 }, preRetirementGrowth: 0, rothGrowth: 0, taxableGrowth: 0, inflationRate: 0, bracketInflation: 0 });
  const rows = run(inp);
  near(assert, rows[0].hsaBal, 14000, 0.01);
  near(assert, rows[1].hsaBal, 18000, 0.01);
  near(assert, rows[2].hsaBal, 18000, 0.01, 'age 62: on Medicare, no contribution');
  near(assert, rows[3].hsaBal, 18000, 0.01);
  near(assert, rows[1].wages, 96000, 0.01, 'the contribution is pre-tax while it lasts');
  near(assert, rows[2].wages, 100000, 0.01);
  const warn = (over) => E.validateInputs(baseInputs({ retirementAge: 64, annualContributions: { traditional: 0, roth: 0, taxable: 0, hsa: 4000 }, ...over }), td).warnings.some(w => w.field === 'annualContributions.hsa');
  assert.ok(warn({ medicareAge: 62 }));
  assert.ok(warn({ retirementAge: 67 }), 'the default Medicare age of 65 also stops them for someone working past 65');
  assert.ok(!warn({ medicareAge: 65 }));
  assert.ok(!warn({ medicareAge: 62, annualContributions: { traditional: 0, roth: 0, taxable: 0, hsa: 0 } }));
  /* Default Medicare age: someone retiring at 64 keeps contributing every working year, as before */
  const def = run({ ...inp, medicareAge: '' });
  near(assert, def[3].hsaBal, 26000, 0.01);
});

test('IRMAA in the first two years uses the prior-year income entered', () => {
  /* single, 70, on Medicare, modest income now; two years ago income was high (still working). */
  const opts = { currentAge: 70, retirementAge: 65, ssStartAge: 70, pensionIncome: 20000, inflationRate: 0, bracketInflation: 0 };
  const est = run(baseInputs(opts));
  assert.equal(est[0].irmaaSurcharge, 0);                      /* estimated from this year's low income */
  const known = run(baseInputs({ ...opts, magiTwoYearsAgo: 300000, magiLastYear: 150000 }));
  near(assert, known[0].irmaaMagi, 300000, 0.01);               /* year 1 looks back to two years ago */
  near(assert, known[1].irmaaMagi, 150000, 0.01);               /* year 2 looks back to last year */
  near(assert, known[0].irmaaSurcharge, E.irmaaSurcharge(td, 300000, 'single', START, 0, 0, 1).annual, 0.01);
  assert.ok(known[0].irmaaSurcharge > known[1].irmaaSurcharge);
  near(assert, known[2].irmaaMagi, known[0].taxDetail ? known[0].taxDetail.magi : known[2].irmaaMagi, 0.01); /* then the projection's own history */
});

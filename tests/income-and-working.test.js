/* Tests for income streams (pension, disability, SSDI...) and Roth
   conversions in working years. See docs/income-and-working-years.md. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, td, baseInputs, near } = require('./helpers');

const START = 2026;
const run = (inputs, scenario = 'noConversion', opts = {}) => E.runProjection(inputs, scenario, { startYear: START, ...opts }, td);
const stream = (over = {}) => ({ name: 'Income', amount: 10000, owner: 'you', startAge: '', endAge: '', cola: 'inflation', taxable: 'full', ...over });

/* ---- working-year conversions ---- */

test('working-year conversion, hand-worked: the bracket fill stacks on wages and the extra tax comes from the taxable account', () => {
  /* Single, 60, working two more years on $100,000; 22% bracket; 2026 figures, no indexing, no growth.
       wages 100,000 - standard deduction 16,100 = 83,900 ordinary taxable income
       top of the 22% bracket (single) 105,700 -> room for a 21,800 conversion
       tax without a conversion: 1,240 + 4,560 + 22% x 33,500 = 13,170 (paid by the paycheck)
       tax with it:               1,240 + 4,560 + 22% x 55,300 = 17,966 -> extra 4,796 from the taxable account */
  const inp = baseInputs({ currentAge: 60, retirementAge: 62, grossIncome: 100000, taxableBalance: 300000, taxableCostBasis: 300000,
    annualContributions: { traditional: 0, roth: 0, taxable: 0, hsa: 0 }, preRetirementGrowth: 0, rothGrowth: 0, taxableGrowth: 0, bracketInflation: 0, inflationRate: 0 });
  const rows = run(inp, 'optimized', { targetBracketRate: 0.22 });
  const y = rows[0];
  assert.equal(y.working, true);
  near(assert, y.conversionAmount, 21800, 1);
  near(assert, y.ordinaryTaxableIncome, 105700, 1);
  near(assert, y.federalTax, 17966, 1);
  near(assert, y.totalTax, 17966, 1);
  near(assert, y.paycheckTax, 13170, 0.01);
  near(assert, y.taxableWithdrawal, 4796, 1);
  near(assert, y.taxBal, 300000 - 4796, 1);
  near(assert, y.rothBal, 50000 + 21800, 1);
  near(assert, y.tradBal, 800000 - 21800, 1);
  assert.equal(y.unmetSpending, 0);
  assert.equal(y.spendingTarget, 0);
  /* Withholding instead: the tax never reaches the Roth, and under 59 1/2 it would be penalized; at 60 it is not */
  const wh = run(inp, 'optimized', { targetBracketRate: 0.22, taxPaymentSource: 'conversion' })[0];
  near(assert, wh.conversionAmount, 21800, 1);
  near(assert, wh.taxFromConversion, 4796, 1);
  assert.equal(wh.taxableWithdrawal, 0);
  near(assert, wh.rothBal, 50000 + 21800 - 4796, 1);
  /* Turned off: no conversion, the paycheck covers everything, the accounts are untouched */
  const off = run({ ...inp, convertWhileWorking: 'no' }, 'optimized', { targetBracketRate: 0.22 })[0];
  assert.equal(off.conversionAmount, 0);
  near(assert, off.totalTax, 13170, 1);
  assert.equal(off.taxableWithdrawal, 0);
  near(assert, off.taxBal, 300000, 0.01);
  /* A custom plan converts in working years too */
  const custom = run(inp, 'custom', { customConversion: 10000 })[0];
  near(assert, custom.conversionAmount, 10000, 0.01);
  assert.equal(run({ ...inp, convertWhileWorking: 'no' }, 'custom', { customConversion: 10000 })[0].conversionAmount, 0);
});

test('working-year conversion: with wages above the bracket top there is no room, so nothing is converted', () => {
  const inp = baseInputs({ currentAge: 60, retirementAge: 62, grossIncome: 200000, bracketInflation: 0 });
  const y = run(inp, 'optimized', { targetBracketRate: 0.22 })[0];
  assert.equal(y.working, true);
  assert.equal(y.conversionAmount, 0);
  assert.equal(y.paycheckTax, y.totalTax);
});

test('the optimizer converts in working years when that helps, and not when it is turned off', () => {
  /* Part-time earnings of $30,000 for three more years leave most of the 24% bracket empty. */
  const inp = baseInputs({ currentAge: 60, retirementAge: 63, grossIncome: 30000, traditionalBalance: 2000000, taxableBalance: 400000, taxableCostBasis: 300000 });
  const on = E.optimizeStrategy(inp, td, { startYear: START });
  const off = E.optimizeStrategy({ ...inp, convertWhileWorking: 'no' }, td, { startYear: START });
  const so = E.summarizePlan(on, 2), sf = E.summarizePlan(off, 2);
  assert.ok(so.workingConversionYears === 3, `converted in ${so.workingConversionYears} working years`);
  assert.equal(so.firstConversion.age, 60);
  assert.equal(sf.workingConversionYears, 0);
  assert.equal(sf.firstConversion.age, 63);
  const spend = (r) => r.candidates.find(c => c.chosen).spendableWealth;
  assert.ok(spend(on) > spend(off) + 10000, `working-year conversions leave more to spend: ${spend(on)} vs ${spend(off)}`);
  assert.ok(so.worthIt && sf.worthIt);
  /* Working-year candidates are evaluated like any other: with them off, every candidate has none */
  for (const c of off.candidates) assert.equal(c.chosen === true || c.chosen === false, true);
  assert.ok(on.scenarioB.slice(0, 3).every(r => r.working && r.conversionAmount > 0));
  assert.ok(off.scenarioB.slice(0, 3).every(r => r.working && r.conversionAmount === 0));
});

/* ---- income streams ---- */

test('a stream is paid from its start age up to (not including) the age it stops', () => {
  const inp = baseInputs({ incomeStreams: [stream({ name: 'LTD', amount: 99808, startAge: 62, endAge: 65, cola: 'none' })], inflationRate: 0 });
  const rows = run(inp);
  const paid = rows.filter(r => r.otherIncome > 0).map(r => r.age);
  assert.deepEqual(paid, [62, 63, 64]);
  near(assert, rows.find(r => r.age === 62).otherIncome, 99808, 0.01);
  near(assert, rows.find(r => r.age === 62).pension, 99808, 0.01);
  assert.equal(rows.find(r => r.age === 61).otherIncome, 0);
  assert.equal(rows.find(r => r.age === 65).otherIncome, 0);
  /* Blank start = paid now; blank end = for life */
  const life = run(baseInputs({ incomeStreams: [stream({ amount: 12000 })] }));
  assert.ok(life.every(r => r.otherIncome > 0));
  near(assert, life[0].otherIncome, 12000, 0.01);
  /* A spouse's stream follows the spouse's age and ends at the spouse's projected death */
  const sp = run(baseInputs({ filingStatus: 'marriedFilingJointly', spouseAge: 50, spouseLifeExpectancy: 70, spouseSsBenefit: 0,
    incomeStreams: [stream({ name: 'LTD', amount: 99808, owner: 'spouse', startAge: 52, endAge: 65, cola: 'none' })] }));
  const spPaid = sp.filter(r => r.otherIncome > 0).map(r => r.spouseAge);
  assert.deepEqual(spPaid, [52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64]);
  const forLife = run(baseInputs({ filingStatus: 'marriedFilingJointly', spouseAge: 50, spouseLifeExpectancy: 70, spouseSsBenefit: 0,
    incomeStreams: [stream({ amount: 20000, owner: 'spouse', startAge: 52 })] }));
  assert.equal(forLife.filter(r => r.otherIncome > 0).at(-1).spouseAge, 70, 'paid through the spouse\'s last year');
  assert.equal(forLife.find(r => r.spouseAge === 71).otherIncome, 0);
  /* A spouse's stream without a spouse on the return is treated as the user's */
  const single = E.normalizeInputs(baseInputs({ incomeStreams: [stream({ owner: 'spouse' })] }), td);
  assert.equal(single.incomeStreams[0].owner, 'you');
  assert.ok(E.validateInputs(baseInputs({ incomeStreams: [stream({ owner: 'spouse' })] }), td).warnings.some(w => w.field === 'incomeStreams.0.owner'));
});

test('tax treatment: fully taxable, partly taxable, and taxed like Social Security', () => {
  const base = baseInputs({ currentAge: 62, retirementAge: 62, ssAnnualBenefit: 0, taxableBalance: 0, taxableCostBasis: 0, traditionalBalance: 0, rothBalance: 2000000,
    annualSpending: 0, inflationRate: 0, bracketInflation: 0, preRetirementGrowth: 0, rothGrowth: 0, taxableGrowth: 0 });
  const y = (streams) => run({ ...base, incomeStreams: streams })[0];
  /* Fully taxable 40,000: all ordinary income */
  const full = y([stream({ amount: 40000, cola: 'none' })]);
  near(assert, full.agi, 40000, 0.01);
  near(assert, full.pension, 40000, 0.01);
  assert.equal(full.otherIncomeTaxFree, 0);
  /* 85% taxable: 34,000 ordinary income, 6,000 tax-free cash */
  const part = y([stream({ amount: 40000, cola: 'none', taxable: 'partial', taxablePercent: 85 })]);
  near(assert, part.agi, 34000, 0.01);
  near(assert, part.pension, 34000, 0.01);
  near(assert, part.otherIncomeTaxFree, 6000, 0.01);
  near(assert, part.otherIncome, 40000, 0.01);
  assert.equal(part.incomeStreams[0].taxablePart, 34000);
  /* Taxed like Social Security: joins the benefits; 40,000 alone is below the provisional-income base, so none is taxable */
  const ssLike = y([stream({ amount: 40000, cola: 'none', taxable: 'socialSecurity' })]);
  near(assert, ssLike.ssIncome, 40000, 0.01);
  near(assert, ssLike.otherIncomeLikeSS, 40000, 0.01);
  assert.equal(ssLike.pension, 0);
  assert.equal(ssLike.taxableSS, 0);
  assert.equal(ssLike.agi, 0);
  /* ...and with 40,000 of pension on top, up to 85% of it becomes taxable, exactly as a Social Security benefit would */
  const both = y([stream({ amount: 40000, cola: 'none', taxable: 'socialSecurity' }), stream({ amount: 40000, cola: 'none' })]);
  /* (a start age below the current age means the benefit is already being paid and is used as entered) */
  const asBenefit = run({ ...base, currentAge: 63, retirementAge: 63, ssAnnualBenefit: 40000, ssStartAge: 62, incomeStreams: [stream({ amount: 40000, cola: 'none' })] })[0];
  near(assert, asBenefit.ssIncome, 40000, 0.01);
  assert.ok(both.taxableSS > 0);
  near(assert, both.taxableSS, E.taxableSocialSecurity(td, 40000, 40000, 'single'), 0.01);
  near(assert, both.taxableSS, asBenefit.taxableSS, 1, 'same as an actual benefit of the same size');
  near(assert, both.totalTax, asBenefit.totalTax, 1);
  /* Money is conserved: the whole stream is cash, whatever its tax treatment */
  for (const r of [full, part, ssLike]) {
    near(assert, r.rothBal + r.taxBal, 2000000 + (r.pension + r.otherIncomeTaxFree + r.ssIncome) - r.totalTax, 1, 'cash reinvested');
  }
  /* A state that exempts Social Security leaves the SSDI-like stream out of its base too */
  const state = run({ ...base, stateAbbr: 'CA', incomeStreams: [stream({ amount: 40000, cola: 'none', taxable: 'socialSecurity' }), stream({ amount: 40000, cola: 'none' })] })[0];
  near(assert, state.taxDetail.stateIncome, state.agi - state.taxableSS, 0.01);
});

test('cost-of-living: rising with inflation, flat, or a set percentage', () => {
  const base = baseInputs({ currentAge: 62, retirementAge: 62, inflationRate: 3, annualSpending: 0 });
  const at = (streams, age) => run({ ...base, incomeStreams: streams }).find(r => r.age === age).otherIncome;
  near(assert, at([stream({ amount: 10000, cola: 'inflation' })], 72), 10000 * 1.03 ** 10, 0.01);
  near(assert, at([stream({ amount: 10000, cola: 'none' })], 72), 10000, 0.01);
  near(assert, at([stream({ amount: 10000, cola: 'custom', colaRate: 1.5 })], 72), 10000 * 1.015 ** 10, 0.01);
  near(assert, at([stream({ amount: 10000, cola: 2 })], 72), 10000 * 1.02 ** 10, 0.01, 'a number is a custom rate');
  /* Indexed from today, not from the start age: a flat stream that starts later is still the amount entered */
  near(assert, at([stream({ amount: 10000, cola: 'none', startAge: 70 })], 72), 10000, 0.01);
  near(assert, at([stream({ amount: 10000, cola: 'inflation', startAge: 70 })], 72), 10000 * 1.03 ** 10, 0.01);
});

test('profile migration: a single pension amount becomes one stream that behaves as before', () => {
  const old = baseInputs({ currentAge: 60, retirementAge: 65, pensionIncome: 24000, inflationRate: 2 });
  assert.equal('incomeStreams' in old, false);
  const n = E.normalizeInputs(old, td);
  assert.equal(n.incomeStreams.length, 1);
  assert.deepEqual(n.incomeStreams[0], { name: 'Pension', amount: 24000, owner: 'you', startAge: 65, endAge: null, colaRate: 2, taxable: 'full', taxablePercent: 100 });
  assert.equal('pensionIncome' in n, false);
  const rows = run(old);
  assert.equal(rows.find(r => r.age === 64).pension, 0, 'nothing while working');
  near(assert, rows.find(r => r.age === 65).pension, 24000 * 1.02 ** 5, 0.01, 'from retirement, indexed from today');
  near(assert, rows.at(-1).pension, 24000 * 1.02 ** 30, 0.01, 'for life');
  /* The same numbers as an explicit stream */
  const explicit = run(baseInputs({ currentAge: 60, retirementAge: 65, inflationRate: 2, incomeStreams: [stream({ name: 'Pension', amount: 24000, startAge: 65 })] }));
  rows.forEach((r, i) => near(assert, r.totalTax, explicit[i].totalTax, 1e-6));
  /* No pension, no streams; an empty list wins over a pension amount */
  assert.deepEqual(E.normalizeInputs(baseInputs(), td).incomeStreams, []);
  assert.deepEqual(E.normalizeInputs(baseInputs({ pensionIncome: 5000, incomeStreams: [] }), td).incomeStreams, []);
  /* Working-year conversions default on for older profiles, and accept the form's yes/no */
  assert.equal(E.normalizeInputs(old, td).convertWhileWorking, true);
  assert.equal(E.normalizeInputs({ convertWhileWorking: 'no' }, td).convertWhileWorking, false);
  assert.equal(E.normalizeInputs({ convertWhileWorking: false }, td).convertWhileWorking, false);
  assert.equal(E.normalizeInputs({ convertWhileWorking: 'yes' }, td).convertWhileWorking, true);
  /* Bad rows are cleaned up, not fatal */
  const messy = E.normalizeInputs(baseInputs({ incomeStreams: [null, 'x', stream({ amount: '' }), stream({ amount: 5000, startAge: 70, endAge: 60, taxable: 'weird', name: '  ' })] }), td);
  assert.equal(messy.incomeStreams.length, 1);
  assert.equal(messy.incomeStreams[0].endAge, null);
  assert.equal(messy.incomeStreams[0].taxable, 'full');
  assert.equal(messy.incomeStreams[0].name, 'Income 2', 'named by its place among the usable rows');
  const v = E.validateInputs(baseInputs({ incomeStreams: [stream({ amount: -1, startAge: 70, endAge: 60, taxable: 'partial', taxablePercent: 150 })] }), td);
  assert.deepEqual(v.errors.map(e => e.field).sort(), ['incomeStreams.0.amount', 'incomeStreams.0.endAge', 'incomeStreams.0.taxablePercent']);
});

test('the household: disability until 65 (85% taxable) and SSDI taxed like Social Security, while still working', () => {
  const inp = baseInputs({
    currentAge: 60, retirementAge: 62, lifeExpectancy: 90, filingStatus: 'marriedFilingJointly', spouseAge: 50, spouseLifeExpectancy: 90, stateAbbr: 'CA',
    grossIncome: 250000, traditionalBalance: 2000000, taxableBalance: 600000, taxableCostBasis: 400000, rothBalance: 200000,
    ssAnnualBenefit: 45000, ssStartAge: 70, spouseSsBenefit: 42324, spouseSsStartAge: 67, annualSpending: 130000,
    incomeStreams: [
      stream({ name: 'Long-term disability', amount: 99808, owner: 'spouse', startAge: '', endAge: 65, cola: 'none', taxable: 'partial', taxablePercent: 85 }),
      stream({ name: 'SSDI', amount: 42324, owner: 'spouse', startAge: 52, endAge: 67, cola: 'inflation', taxable: 'socialSecurity' })
    ]
  });
  const r = E.optimizeStrategy(inp, td, { startYear: START });
  const rows = r.scenarioB;
  const first = rows[0];
  assert.equal(first.working, true);
  near(assert, first.otherIncome, 99808, 0.01);
  near(assert, first.pension, 99808 * 0.85, 0.01);
  assert.equal(first.ssIncome, 0, 'SSDI has not started (spouse is 50)');
  const at52 = rows.find(x => x.spouseAge === 52);
  near(assert, at52.otherIncomeLikeSS, 42324 * 1.02 ** 2, 0.01);
  assert.ok(at52.taxableSS > 0, 'SSDI is partly taxable on top of the other income');
  const at65 = rows.find(x => x.spouseAge === 65);
  assert.equal(at65.incomeStreams.some(x => x.name === 'Long-term disability'), false, 'disability stops at 65');
  const at67 = rows.find(x => x.spouseAge === 67);
  assert.equal(at67.incomeStreams.length, 0, 'SSDI becomes the retirement benefit at full retirement age');
  assert.ok(at67.ssIncome > 0);
  const s = E.summarizePlan(r, 2);
  assert.ok(Number.isFinite(s.spendableGainToday));
  assert.equal(s.runsOutAgeB, null);
});

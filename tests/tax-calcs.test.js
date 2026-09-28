/* Unit tests for every single-year tax calculation, using the frozen 2026
   figures in tests/fixtures/rates-2026.json. Expected values are worked by hand. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, td, near } = require('./helpers');

const Y = 2026;
const S = 'single', J = 'marriedFilingJointly', M = 'marriedFilingSeparately';
const br = (fs, year = Y, rate = 0) => E.getBrackets(td, fs, year, rate);

test('indexAmount grows, shrinks and passes through "no limit"', () => {
  near(assert, E.indexAmount(100, 2026, 2028, 0.02), 104.04, 1e-9);
  near(assert, E.indexAmount(100, 2026, 2025, 0.02), 100 / 1.02, 1e-9);
  assert.equal(E.indexAmount(100, 2026, 2026, 0.05), 100);
  assert.equal(E.indexAmount(Infinity, 2026, 2030, 0.02), Infinity);
  assert.equal(E.indexAmount(null, 2026, 2030, 0.02), Infinity);
});

test('federal brackets: 2026 tax for single and joint filers', () => {
  assert.equal(E.ordinaryIncomeTax(0, br(S)), 0);
  assert.equal(E.ordinaryIncomeTax(-500, br(S)), 0);
  near(assert, E.ordinaryIncomeTax(12400, br(S)), 1240);
  near(assert, E.ordinaryIncomeTax(60000, br(S)), 7912);
  near(assert, E.ordinaryIncomeTax(250000, br(J)), 45196);
  near(assert, E.ordinaryIncomeTax(1000000, br(S)), 325957.25);
});

test('federal brackets: married filing separately differs only in the 35% band', () => {
  const s = br(S), m = br(M);
  for (let i = 0; i < 5; i++) assert.deepEqual(m[i], s[i]);
  assert.equal(m[5][1], 384350);
  assert.equal(s[5][1], 640600);
});

test('federal brackets are inflation-indexed for later years', () => {
  near(assert, E.ordinaryIncomeTax(60000, br(S, 2027, 0.02)), 7806.24);
  assert.equal(br(S, 2027, 0.02)[6][1], Infinity);
});

test('marginal rate is the rate on the next dollar', () => {
  assert.equal(E.marginalRate(0, br(S)), 0.10);
  assert.equal(E.marginalRate(12399.99, br(S)), 0.10);
  assert.equal(E.marginalRate(12400, br(S)), 0.12);
  assert.equal(E.marginalRate(5e6, br(S)), 0.37);
});

test('bracket ceiling and bracket fill', () => {
  assert.equal(E.bracketCeiling(br(S), 0.24), 201775);
  assert.equal(E.bracketCeiling(br(S), 0.10), 12400);
  assert.equal(E.bracketCeiling(br(J), 0.35), 768700);
  const fill = E.bracketFill(60000, br(S));
  assert.equal(fill.length, 3);
  near(assert, fill.reduce((s, f) => s + f.filled, 0), 60000);
  near(assert, fill.reduce((s, f) => s + f.tax, 0), 7912);
  assert.equal(E.bracketFill(0, br(S)).length, 1);
});

test('standard deduction incl. extra amount per person 65+', () => {
  assert.equal(E.standardDeduction(td, S, 64, null, Y, 0), 16100);
  assert.equal(E.standardDeduction(td, S, 65, null, Y, 0), 18150);
  assert.equal(E.standardDeduction(td, J, 66, 64, Y, 0), 33850);
  assert.equal(E.standardDeduction(td, J, 66, 70, Y, 0), 35500);
  assert.equal(E.standardDeduction(td, M, 65, 70, Y, 0), 17750);
  near(assert, E.standardDeduction(td, S, 50, null, 2027, 0.02), 16422);
});

test('senior deduction: $6,000 per person 65+, 6% phase-out, 2025-2028 only', () => {
  assert.equal(E.seniorBonusDeduction(td, 70000, S, 65, null, Y), 6000);
  near(assert, E.seniorBonusDeduction(td, 75500, S, 65, null, Y), 5970); /* continuous, not per $1,000 */
  near(assert, E.seniorBonusDeduction(td, 100000, S, 65, null, Y), 4500);
  assert.equal(E.seniorBonusDeduction(td, 175000, S, 65, null, Y), 0);
  assert.equal(E.seniorBonusDeduction(td, 250000, S, 65, null, Y), 0);
  near(assert, E.seniorBonusDeduction(td, 200000, J, 66, 67, Y), 6000);
  assert.equal(E.seniorBonusDeduction(td, 100000, J, 66, 60, Y), 6000);
  assert.equal(E.seniorBonusDeduction(td, 50000, M, 70, null, Y), 0);
  assert.equal(E.seniorBonusDeduction(td, 50000, S, 64, null, Y), 0);
  assert.equal(E.seniorBonusDeduction(td, 50000, S, 70, null, 2028), 6000);
  assert.equal(E.seniorBonusDeduction(td, 50000, S, 70, null, 2029), 0);
});

test('capital gains stack on top of ordinary income', () => {
  const cg = (fs) => E.getCapitalGainsBrackets(td, fs, Y, 0);
  near(assert, E.capitalGainsTax(40000, 20000, cg(S)), 1582.5);
  near(assert, E.capitalGainsTax(0, 60000, cg(S)), 1582.5);
  near(assert, E.capitalGainsTax(600000, 10000, cg(S)), 2000);
  near(assert, E.capitalGainsTax(540000, 10000, cg(S)), 1725);
  assert.equal(E.capitalGainsTax(0, 98900, cg(J)), 0);
  near(assert, E.capitalGainsTax(300000, 10000, cg(M)), 1500 + 0.05 * 3150);
  assert.equal(E.capitalGainsTax(10000, 0, cg(S)), 0);
});

test('net investment income tax: 3.8% of lesser of NII or MAGI over threshold', () => {
  near(assert, E.netInvestmentIncomeTax(td, 250000, 30000, S), 1140);
  near(assert, E.netInvestmentIncomeTax(td, 250000, 80000, S), 1900);
  assert.equal(E.netInvestmentIncomeTax(td, 190000, 80000, S), 0);
  near(assert, E.netInvestmentIncomeTax(td, 260000, 50000, J), 380);
  near(assert, E.netInvestmentIncomeTax(td, 130000, 50000, M), 190);
  assert.equal(E.netInvestmentIncomeTax(td, 500000, 0, S), 0);
});

test('taxable Social Security follows the Pub 915 worksheet', () => {
  assert.equal(E.taxableSocialSecurity(td, 0, 100000, S), 0);
  assert.equal(E.taxableSocialSecurity(td, 20000, 10000, S), 0);
  near(assert, E.taxableSocialSecurity(td, 20000, 20000, S), 2500);
  near(assert, E.taxableSocialSecurity(td, 20000, 40000, S), 17000);
  near(assert, E.taxableSocialSecurity(td, 40000, 30000, J), 11100);
  near(assert, E.taxableSocialSecurity(td, 20000, 0, M), 8500); /* not a flat 85% */
  near(assert, E.taxableSocialSecurity(td, 20000, 100000, M), 17000);
});

test('computeYearTax: unused deduction shelters capital gains', () => {
  const t = E.computeYearTax(td, { filingStatus: S, year: Y, age: 60, wages: 10000, capitalGains: 20000 });
  assert.equal(t.agi, 30000);
  assert.equal(t.taxableIncome, 13900);
  assert.equal(t.preferentialIncome, 13900);
  assert.equal(t.ordinaryTaxableIncome, 0);
  assert.equal(t.federalTax, 0);
  assert.equal(t.cgTax, 0);
});

test('computeYearTax: retiree with SS, IRA, dividends and progressive state tax', () => {
  const stateBrackets = [[0.05, null]];
  const t = E.computeYearTax(td, {
    filingStatus: S, year: Y, age: 70, iraDistributions: 50000, ssBenefits: 30000, dividends: 10000,
    stateBrackets, stateTaxesSocialSecurity: false
  });
  near(assert, t.taxableSS, 25500);
  near(assert, t.agi, 85500);
  near(assert, t.stdDeduction, 18150);
  near(assert, t.seniorBonus, 5370);
  near(assert, t.taxableIncome, 61980);
  near(assert, t.ordinaryTaxableIncome, 51980);
  near(assert, t.federalTax, 6147.6);
  near(assert, t.cgTax, 1500);
  assert.equal(t.niit, 0);
  near(assert, t.stateTax, 1824); /* SS excluded from the state base */
  assert.equal(t.marginalRate, 0.22);
  const taxedSS = E.computeYearTax(td, {
    filingStatus: S, year: Y, age: 70, iraDistributions: 50000, ssBenefits: 30000, dividends: 10000,
    stateBrackets, stateTaxesSocialSecurity: true
  });
  near(assert, taxedSS.stateTax, 3099);
  const flat = E.computeYearTax(td, { filingStatus: S, year: Y, age: 40, wages: 116100, stateRate: 5 });
  near(assert, flat.stateTax, 5000);
});

const stateOf = (abbr) => td.states.find(s => s.abbr === abbr);

test("state allowances: the state's own standard deduction + personal exemptions, and personal credits", () => {
  /* Tax Foundation 2026: California $5,540 / $11,080 standard deduction, $153 / $306 credit;
     Alabama $3,000 / $8,500 standard deduction + $1,500 / $3,000 exemption. */
  assert.deepEqual(E.stateAllowances(td, stateOf('CA'), S, Y, 0), { deduction: 5540, credit: 153 });
  assert.deepEqual(E.stateAllowances(td, stateOf('CA'), J, Y, 0), { deduction: 11080, credit: 306 });
  assert.deepEqual(E.stateAllowances(td, stateOf('CA'), M, Y, 0), { deduction: 5540, credit: 153 });
  assert.deepEqual(E.stateAllowances(td, stateOf('AL'), J, Y, 0), { deduction: 11500, credit: 0 });
  assert.deepEqual(E.stateAllowances(td, stateOf('PA'), S, Y, 0), { deduction: 0, credit: 0 });
  /* Utah's "standard deduction" is a credit */
  assert.deepEqual(E.stateAllowances(td, stateOf('UT'), S, Y, 0), { deduction: 0, credit: 966 });
  /* indexed like the state brackets */
  const later = E.stateAllowances(td, stateOf('CA'), S, 2027, 0.02);
  near(assert, later.deduction, 5650.8);
  near(assert, later.credit, 156.06);
});

test('computeYearTax: state income starts from the state deduction, not federal taxable income', () => {
  /* Single, 70, California. Federal AGI 85,500 (see above) less 25,500 taxable
     SS (CA does not tax it) = 60,000; less the CA deduction 5,540 = 54,460.
     1% x 11,079 + 2% x 15,185 + 4% x 15,188 + 6% x 13,008 = 1,802.49; less the
     $153 personal credit = 1,649.49. (Federal taxable income less SS would
     have given 36,480.) */
  const ca = stateOf('CA');
  const t = E.computeYearTax(td, {
    filingStatus: S, year: Y, age: 70, iraDistributions: 50000, ssBenefits: 30000, dividends: 10000,
    stateBrackets: ca.brackets.single, stateTaxesSocialSecurity: false, stateDeduction: 5540, stateCredit: 153
  });
  near(assert, t.stateIncome, 60000);
  near(assert, t.stateDeduction, 5540);
  near(assert, t.stateTaxableIncome, 54460);
  near(assert, t.stateTax, 1649.49);
  /* the credit never makes the tax negative */
  const small = E.computeYearTax(td, {
    filingStatus: S, year: Y, age: 40, wages: 8000,
    stateBrackets: ca.brackets.single, stateDeduction: 5540, stateCredit: 153
  });
  assert.equal(small.stateTax, 0);
  /* a flat rate typed with a state picked uses the same state base: (40,000 - 5,540) x 5% - 153 */
  const flat = E.computeYearTax(td, { filingStatus: S, year: Y, age: 40, wages: 40000, stateRate: 5, stateDeduction: 5540, stateCredit: 153 });
  near(assert, flat.stateTax, 1570);
});

test('computeYearTax: states that exempt IRA withdrawals, Roth conversions and pensions', () => {
  const tax = (abbr, p) => {
    const s = stateOf(abbr);
    const a = E.stateAllowances(td, s, S, Y, 0);
    return E.computeYearTax(td, {
      filingStatus: S, year: Y, stateBrackets: s.brackets.single, stateTaxesSocialSecurity: s.taxesSocialSecurity,
      stateDeduction: a.deduction, stateCredit: a.credit, stateRetirementExclusion: s.retirementExclusion, ...p
    });
  };
  /* Pennsylvania, 65: IRA 70,000 (30,000 of it converted) and pension 10,000
     are exempt; only the 5,000 of dividends is taxed: 3.07% x 5,000 = 153.50 */
  const pa65 = tax('PA', { age: 65, iraDistributions: 70000, rothConversion: 30000, pension: 10000, dividends: 5000 });
  near(assert, pa65.stateExcludedRetirement, 80000);
  near(assert, pa65.stateTax, 153.5);
  /* Pennsylvania, 55: the conversion is still exempt, the other 20,000 is not
     (under 59 1/2): 3.07% x 20,000 = 614 */
  const pa55 = tax('PA', { age: 55, iraDistributions: 50000, rothConversion: 30000 });
  near(assert, pa55.stateTax, 614);
  /* 59 counts as 59 1/2 (birthdays mid-year, as for the early-withdrawal penalty) */
  near(assert, tax('PA', { age: 59, iraDistributions: 50000 }).stateTax, 0);
  /* Illinois, any age: 40,000 converted at 50 is exempt; wages 10,000 less the
     $2,925 exemption = 7,075 x 4.95% = 350.21 */
  near(assert, tax('IL', { age: 50, wages: 10000, iraDistributions: 40000, rothConversion: 40000 }).stateTax, 350.2125);
  /* Mississippi, 50: conversion 20,000 exempt, the other 40,000 taxed; less the
     2,300 deduction + 6,000 exemption = 31,700; 0% to 10,000, 4% above = 868 */
  near(assert, tax('MS', { age: 50, iraDistributions: 60000, rothConversion: 20000 }).stateTax, 868);
  /* Mississippi, 65: all 60,000 exempt; dividends 20,000 - 8,300 = 11,700 -> 4% x 1,700 = 68 */
  near(assert, tax('MS', { age: 65, iraDistributions: 60000, rothConversion: 20000, dividends: 20000 }).stateTax, 68);
  /* A state without an exclusion taxes it all: California, 65, 60,000 IRA:
     60,000 - 5,540 = 54,460 -> 1,802.49 - 153 = 1,649.49 */
  near(assert, tax('CA', { age: 65, iraDistributions: 60000, rothConversion: 20000 }).stateTax, 1649.49);
});

test('computeYearTax: a state that stops taxing Social Security at an age leaves that share out', () => {
  /* Colorado, single, 70: IRA 50,000 + SS 30,000 (25,500 taxable) = AGI 75,500;
     less the 16,100 CO deduction. All of the SS exempt (share 1): 4.4% x 33,900 = 1,491.60;
     none exempt: 4.4% x 59,400 = 2,613.60; half (one spouse 65+): 4.4% x 46,650 = 2,052.60 */
  const co = stateOf('CO');
  const a = E.stateAllowances(td, co, S, Y, 0);
  const tax = (share) => E.computeYearTax(td, {
    filingStatus: S, year: Y, age: 70, iraDistributions: 50000, ssBenefits: 30000,
    stateBrackets: co.brackets.single, stateTaxesSocialSecurity: true, stateSsExemptShare: share,
    stateDeduction: a.deduction, stateCredit: a.credit
  });
  near(assert, tax(1).stateTax, 1491.6);
  near(assert, tax(0).stateTax, 2613.6);
  near(assert, tax(undefined).stateTax, 2613.6);
  near(assert, tax(0.5).stateTax, 2052.6);
  near(assert, tax(7).stateTax, 1491.6); /* clamped */
  assert.equal(co.socialSecurityExemption.fromAge, 65);
});

test('IRMAA: surcharge = Part B above standard + Part D, per person', () => {
  const irmaa = (magi, fs, year = Y, people = 1, bi = 0, pi = 0) => E.irmaaSurcharge(td, magi, fs, year, bi, pi, people);
  assert.equal(irmaa(109000, S).annual, 0);
  near(assert, irmaa(109000.01, S).annual, 1148.4);
  assert.equal(irmaa(109000.01, S).tier, 1);
  near(assert, irmaa(300000, J, Y, 2).annual, 5769.6);
  near(assert, irmaa(499999, S).annual, 6355.2);
  near(assert, irmaa(500000, S).annual, 6936);
  near(assert, irmaa(150000, M).annual, 6355.2);
  near(assert, irmaa(391000, M).annual, 6936);
  assert.equal(irmaa(1e6, S, Y, 0).annual, 0);
  /* thresholds indexed with bracket inflation, premiums with premium inflation */
  assert.equal(irmaa(112000, S, 2028, 1, 0.02, 0.05).annual, 0);
  near(assert, irmaa(120000, S, 2028, 1, 0.02, 0.05).annual, 1148.4 * 1.1025);
  assert.deepEqual(E.irmaaThresholds(td, S, Y, 0), [109000, 137000, 171000, 205000, 499999]);
});

test('RMD start age by birth year (SECURE 2.0)', () => {
  assert.equal(E.rmdStartAge(td, 1949), 72);
  assert.equal(E.rmdStartAge(td, 1950), 72);
  assert.equal(E.rmdStartAge(td, 1951), 73);
  assert.equal(E.rmdStartAge(td, 1959), 73);
  assert.equal(E.rmdStartAge(td, 1960), 75);
  assert.equal(E.rmdStartAge(td, 1975), 75);
});

test('RMD amounts: Uniform table, Joint table, and no gap for the 1959 cohort', () => {
  near(assert, E.requiredMinimumDistribution(td, 73, 1953, 265000, null), 10000);
  near(assert, E.requiredMinimumDistribution(td, 74, 1959, 255000, null), 10000); /* 2033: still due */
  assert.equal(E.requiredMinimumDistribution(td, 72, 1954, 265000, null), 0);
  assert.equal(E.requiredMinimumDistribution(td, 74, 1960, 255000, null), 0);
  near(assert, E.requiredMinimumDistribution(td, 75, 1960, 246000, null), 10000);
  near(assert, E.requiredMinimumDistribution(td, 75, 1951, 324000, 55), 10000); /* joint 75/55 = 32.4 */
  near(assert, E.requiredMinimumDistribution(td, 80, 1951, 278000, 60), 10000); /* joint 80/60 = 27.8 */
  near(assert, E.requiredMinimumDistribution(td, 75, 1951, 246000, 65), 10000); /* 10 yrs younger: uniform */
  near(assert, E.requiredMinimumDistribution(td, 125, 1901, 20000, null), 10000); /* 120+: 2.0 */
  assert.equal(E.requiredMinimumDistribution(td, 80, 1946, 0, null), 0);
  assert.equal(E.rmdDivisor(td, 76, 18), td.rmd.joint.rows['76'][0]); /* below table: youngest row value */
});

test('Social Security full retirement age and claiming adjustments', () => {
  assert.equal(E.fullRetirementAgeMonths(td, 1937), 780);
  assert.equal(E.fullRetirementAgeMonths(td, 1938), 782);
  assert.equal(E.fullRetirementAgeMonths(td, 1950), 792);
  assert.equal(E.fullRetirementAgeMonths(td, 1955), 794);
  assert.equal(E.fullRetirementAgeMonths(td, 1960), 804);
  near(assert, E.ssClaimingFactor(td, 1960, 62), 0.70, 1e-9);
  near(assert, E.ssClaimingFactor(td, 1960, 67), 1.00, 1e-9);
  near(assert, E.ssClaimingFactor(td, 1960, 70), 1.24, 1e-9);
  near(assert, E.ssClaimingFactor(td, 1956, 62), 1 - 0.2 - 16 * 0.05 / 12, 1e-9);
  near(assert, E.ssClaimingFactor(td, 1956, 70), 1 + 44 * 0.08 / 12, 1e-9);
  near(assert, E.ssClaimingFactor(td, 1950, 62), 0.75, 1e-9);
  near(assert, E.ssClaimingFactor(td, 1950, 72), 1.32, 1e-9); /* credits stop at 70 */
  near(assert, E.ssClaimingFactor(td, 1960, 60), 0.70, 1e-9); /* clamped to 62 */
});

test('state: California senior exemption credit, per person 65 or older', () => {
  /* FTB Form 540 line 9: same amount per person as the personal credit (153 in the fixture year) */
  const ca = stateOf('CA');
  assert.deepEqual(E.stateAllowances(td, ca, S, Y, 0, 1), { deduction: 5540, credit: 306 });
  assert.deepEqual(E.stateAllowances(td, ca, J, Y, 0, 1), { deduction: 11080, credit: 459 });
  assert.deepEqual(E.stateAllowances(td, ca, J, Y, 0, 2), { deduction: 11080, credit: 612 });
  assert.deepEqual(E.stateAllowances(td, ca, J, Y, 0, 5), { deduction: 11080, credit: 612 }); /* at most 2 */
  assert.deepEqual(E.stateAllowances(td, stateOf('AL'), J, Y, 0, 2), { deduction: 11500, credit: 0 }); /* no senior credit */
  /* single, 70, IRA 50,000: 50,000 - 5,540 = 44,460 CA taxable.
     1% x 11,079 = 110.79; 2% x 15,185 = 303.70; 4% x 15,188 = 607.52; 6% x 3,008 = 180.48
     = 1,202.49 before credits; less 153 personal + 153 senior = 896.49 (1,049.49 without the senior credit) */
  const tax = (seniors) => {
    const a = E.stateAllowances(td, ca, S, Y, 0, seniors);
    return E.computeYearTax(td, { filingStatus: S, year: Y, age: 70, iraDistributions: 50000,
      stateBrackets: ca.brackets.single, stateTaxesSocialSecurity: false, stateDeduction: a.deduction, stateCredit: a.credit }).stateTax;
  };
  near(assert, tax(1), 896.49);
  near(assert, tax(0), 1049.49);
  assert.equal(ca.seniorCredit.fromAge, 65);
});

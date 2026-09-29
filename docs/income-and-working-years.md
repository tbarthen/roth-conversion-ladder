# Other income streams and conversions while working

Two parts of the model that a real household needs: income other than wages
and Social Security, described as dated streams; and Roth conversions in the
years before retirement.

## Other income streams

The form's **Other income** list replaces the old single "Pension / Other
Income" number. Each row is one stream:

| Field | Meaning | Default |
| --- | --- | --- |
| What is it? | A name, used in the results and in Show the math | blank ("Income N") |
| Yearly amount | Today's dollars a year, before tax | |
| Whose income? | You, or your spouse (joint filers only). Ages below are that person's | you |
| Starts at age | The owner's age when it starts; blank = already being paid | blank |
| Stops at age | The first age it is no longer paid; blank = for life | blank |
| Each year it... | Rises with inflation, stays flat, or rises by a set % | rises with inflation |
| How is it taxed? | Fully taxable; partly taxable (with a taxable share); or taxed like Social Security | fully taxable |
| Taxable share | For partly taxable streams, the part that is income | 85% |

Under each row a sentence restates it in plain English ("$99,808 a year of
your spouse's income from their age 58, until their age 65, flat, 85%
taxable"), and the results repeat that list in "Things to know".

**How a stream is paid.** In each projection year a stream pays if its owner's
age is at or past the start age and below the stop age; a spouse's stream also
stops at the spouse's projected death. The amount is grown from today's
dollars at the stream's own rate (the inflation rate, 0%, or the set %),
counted from the first projection year, so a flat stream pays the amount
entered whenever it starts and an inflation-linked one pays the amount in the
dollars of the year it is paid.

**Tax treatment.**

- *Fully taxable*: ordinary income, like a pension (and, in states with a
  retirement-income exclusion that covers pensions, excluded there).
- *Partly taxable*: the taxable share is ordinary income; the rest is tax-free
  cash. Long-term disability paid for with a mix of pre-tax and after-tax
  premiums is the usual case.
- *Taxed like Social Security*: added to that person's Social Security. Up to
  85% of it is taxable by the same provisional-income formula, and the state
  treats it as Social Security (left out where the state exempts benefits,
  including Colorado's age rule, by owner). SSDI and railroad tier 1 benefits
  work this way.

**Cash flow.** Once retired, stream income (taxable and tax-free parts alike)
pays for spending before the accounts do, exactly as the old pension did.
While working, the salary is assumed to cover spending and its tax, so stream
income in those years is taxed but not saved; that matters for the bracket
fill of a working-year conversion, which stacks on it.

**End-of-plan valuation.** The drawdown tax behind the spendable-wealth goal
is computed on top of the last year's Social Security and taxable other
income, so the streams enter it the way pensions did.

**SSDI that becomes a retirement benefit.** Enter SSDI as a stream taxed like
Social Security, stopping at full retirement age, and enter the same amount as
that person's Social Security benefit starting at full retirement age. The
amount does not change at the switch; entering it this way lets the survivor
and claiming logic see the retirement benefit.

**Migration.** Profiles saved before this change had `pensionIncome`. They
load as one stream: named "Pension", fully taxable, owned by the user,
starting at the retirement age, for life, rising with inflation. That is what
the old number always did, so results do not change. An explicit
`incomeStreams` list (even an empty one) wins over an old pension amount.
Sample profiles carry their own list.

## Conversions while still working

Before this change no plan converted in a working year. Now every year is a
candidate year: the optimized plan fills ordinary taxable income to the top of
the target bracket after wages, other income, dividends and the taxable part
of Social Security, so in a working year only the room left under the bracket
is converted (a salary above the bracket top means nothing is converted). The
IRMAA-avoid and IRMAA-ignore variants apply as in any other year, and the
optimizer scores the resulting plans the same way, so a plan converts while
working only when that comes out ahead on the chosen goal. Custom plans
convert in working years too.

**Paying the tax.** The paycheck is assumed to cover the tax there would have
been without a conversion (the year's tax computed with no conversion and no
withdrawals). The extra tax the conversion causes, including the tax on any
gains realized to pay it, is paid from the accounts in the usual order:
taxable account, then Roth, then traditional, then HSA, or withheld from the
conversion when "Pay from Converted Amount" is chosen (with the early-
distribution penalty before 59½, as in retirement). Anything the accounts
cannot cover is a shortfall, which the guard counts against the plan. No other
working-year cash flows are modeled.

**Turning it off.** "Convert while still working?" under Conversion Strategy
(shown only while there are working years) defaults to yes. "No — only after I
retire" restores the old behaviour. The switch is saved with the profile
(`convertWhileWorking`, `yes`/`no`); older profiles load with it on.

**Where it shows.** The headline's conversion range and count include working
years; a note says how many conversions happen while working and how their tax
is paid; Show the math has a "Paying the conversion tax while working"
section for such a year (taxes, the part the paycheck covers, and where the
rest came from); Key Assumptions describes the rule.

## Engine API (`js/tax-engine.js`)

- `normalizeInputs(raw).incomeStreams`: `[{ name, amount, owner, startAge, endAge (null = for life), colaRate (% a year), taxable ('full' | 'partial' | 'socialSecurity'), taxablePercent }]`; `normalizeInputs(raw).convertWhileWorking` (boolean; raw accepts `true/false` or `'yes'/'no'`).
- `incomeStreamsAt(inp, { age, sAge, spouseAlive, startYear, year })` → `{ taxable, taxFree, ssOwn, ssSpouse, total, items }`.
- Projection rows: `pension` is now the taxable ordinary part of other income; also `otherIncome`, `otherIncomeTaxable`, `otherIncomeTaxFree`, `otherIncomeLikeSS`, `incomeStreams` (the items paid that year) and `paycheckTax` (the tax the paycheck covers in a working year).
- `summarizePlan(...).workingConversionYears`.

Tests: `tests/income-and-working.test.js`.

# What the optimizer ranks plans by: the goal choice

The form asks one question near the top: **"What matters most to you?"**

- **Keep the most for myself** (the default)
- **Leave the most to my heirs**

The answer decides which of the conversion plans the optimizer tries is the one
shown as "the plan". Everything else (the year-by-year projection, the taxes in
each year, the candidates tried) is the same under both goals.

## Why there are two goals

The optimizer originally ranked every plan by the after-tax estate at the end
of the projection (traditional balances counted after the heirs' tax rate, less
any spending the plan could not pay for). That is the right measure for a
household whose aim is a bequest. For a household that does not care what is
left at death it is the wrong one, and it errs toward converting too little.

The first replacement, the lowest total lifetime tax in today's dollars, erred
the other way. Summing taxes deflated by inflation ignores the growth given up
by paying tax early, so it favoured very large early conversions: a wealthy
California couple (about $3M traditional, $2.7M taxable, $0.8M Roth, spending
$115K) was told to convert about $450K a year at the 32% bracket. The current
measure, spendable wealth, counts both effects.

## The candidates (both goals)

Each retired year a plan converts enough to fill ordinary taxable income to the
top of a target bracket. In "let the calculator choose" mode every bracket from
10% to 35% is tried, each with and without staying $1,000 under the next
Medicare IRMAA threshold, which gives twelve candidates. The candidates are
ordered from the **least to the most aggressive**: lower bracket first, and
within a bracket, staying under the IRMAA threshold ("avoid") before ignoring it.
That order is what "less aggressive" means below.

## Goal 1: keep the most for myself (spendable wealth)

**Measure.** Spendable wealth at the end of the plan, in today's dollars:

    Roth + HSA + taxable account + traditional balance − drawdown tax

The **drawdown tax** is what the owner (or, after the projected death, the
surviving spouse) would pay to take the money out: the traditional balance and
the taxable account's unrealized gains (balance − cost basis) are drawn in
equal parts over `DRAWDOWN_YEARS` (10) years, on top of that year's Social
Security, pension and dividends, at that year's filing status and ages, with
that year's indexed brackets, deductions and thresholds. The tax is computed
with the engine's own functions (`computeYearTax` for federal, state,
capital-gains and NIIT; `irmaaSurcharge` for Medicare), as the difference
between the year's tax with and without the withdrawal, times ten. Roth and
HSA money counts in full (HSA for medical costs). It is a valuation, not a
spending plan; its purpose is to make a dollar in a traditional account worth
less than a dollar in a Roth by exactly the tax the owner would face, at their
own brackets rather than a flat rate.

Because it is a wealth measure, it charges the growth given up by paying
conversion tax early, and because it nets out the future tax on the traditional
balance, it credits the tax saved by converting. For the couple above it lands
at the 24% bracket (see the test).

The projection carries `drawdownTax` and `spendableWealth` on every row, so the
measure can be charted over time.

**Guard.** A plan that leaves spending unpaid is never chosen over one that
leaves less unpaid, whatever it ends with. Among plans that pay for every year,
the one with the most spendable wealth wins; if every plan falls short, the one
falling short by least wins. The guard also lets a more aggressive plan beat a
less aggressive one that runs out.

**Ties.** Differences of a dollar or less are ties, and a tie goes to the less
aggressive plan. Identical plans are common: at a high bracket the whole
balance is converted in the first year, so the IRMAA-avoid and IRMAA-ignore
variants, or two adjacent brackets, produce the same projection.

**Worth it?** The plan is recommended when it converts something, ends with
more than $500 more spendable wealth than not converting, and does not leave
more spending unpaid than not converting.

## Goal 2: leave the most to my heirs

Unchanged from the original behaviour: the plan with the highest **net
position** at the end of the projection, where net position = Roth + taxable +
(traditional + HSA) × (1 − heirs' tax rate) − spending the plan could not pay
for. Ties (a dollar or less) go to the less aggressive plan. The heirs' tax rate
field is shown only under this goal; under the other goal it changes nothing.

## Where the goal shows up in the results

Every place that compares "the plan" with not converting reflects the chosen
goal and says what was optimized:

| Place | Keep the most for myself | Leave the most to my heirs |
| --- | --- | --- |
| Headline / subline | "...this is the one that leaves you the most to spend" | "...this is the one that leaves the most to your heirs after all taxes" |
| "Worth it" test | spendable-wealth gain > $500 and no extra unpaid spending | after-tax estate gain > $500 |
| First tile | Yours to spend (± vs not converting, both totals) | Left to your heirs (± vs not converting) |
| Second tile | Tax over your lifetime | Tax over your lifetime |
| Break-even tile | same age; "not in your lifetime" does not promise a payoff for heirs | as before |
| Notes | what was optimized, the drawdown tax in each total, the plans set aside by the guard, how to switch goal | what was optimized, the heirs' rate used, how to switch goal |
| Plain-view chart | What you'd have to spend, over time | What you'd leave after taxes |
| Details summary | Spendable Wealth Advantage first (with both drawdown taxes), Lifetime Taxes second | After-Tax Wealth Advantage first, Lifetime Taxes second |
| Details charts | Spendable Wealth Over Time | After-Tax Wealth Over Time |
| Show the math | caption names the goal the suggested plan was chosen for | same |
| Key Assumptions | one bullet per goal, including the drawdown valuation and the guard | |

## Saved profiles

`goal` is part of the profile (export, import, browser storage). Profiles saved
before the question existed have no goal, and profiles from the first version
of the question say `lifetimeTax`; both load as `spendable`. An import without
the field reports it as defaulted so the user sees the question. The export
schema version is 2. Sample profiles do not set a goal; picking one keeps the
goal already chosen.

## Engine API (`js/tax-engine.js`)

- `GOALS = ['spendable', 'heirs']`, `DRAWDOWN_YEARS = 10`.
- `normalizeInputs(raw).goal`: `'heirs'` or `'spendable'` (anything else, or missing, is `'spendable'`).
- Projection rows: `drawdownTax`, `spendableWealth` (that year's dollars), alongside `afterTaxEstate` and `netPosition`.
- `lifetimeTax(scenario, inflationRate)`, `unmetSpendingTotal(scenario, inflationRate)`, `planMetrics(scenario, inflationRate)` (lifetime tax, unpaid spending, spendable wealth and drawdown tax in today's dollars; net position and after-tax estate as projected).
- `choosePlan(candidates, goal)`: the selection rule above, on candidates ordered least-aggressive first; returns `{ index, passedOver }`.
- `optimizeStrategy(raw, td, { goal, ... })`: `goal` defaults to the inputs' goal. The result carries `goal`, `chosen.goal`, `chosen.passedOver`, `baseline` (the no-conversion plan's metrics) and per-candidate metrics plus `chosen`.
- `summarizePlan(result, inflationRate)`: `goal`, `worthIt`, `shortOfMoney`, `gainToday` (the gain under the goal), `spendableGainToday`, `spendableA/B`, `drawdownTaxA/B`, `drawdownYears`, `taxSavedToday`, `estateGainToday`, `totalEstateA/B`, `estateA/B`, `unmetA/B`, `passedOver`.
- `strategyScore(scenario)` is unchanged: the heirs' measure (net position at the end).

Tests: `tests/goal.test.js` (the California couple, a modest retiree, the
hand-worked valuation, the survivor's filing status, the guard, tie-breaking,
profile migration) and the goal step of `scripts/smoke-test.mjs`.

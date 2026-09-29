# What the optimizer ranks plans by: the goal choice

The form asks one question near the top: **"What matters most to you?"**

- **Pay the least tax over my lifetime** (the default)
- **Leave the most to my heirs**

The answer decides which of the conversion plans the optimizer tries is the one
shown as "the plan". Everything else (the year-by-year projection, the taxes in
each year, the candidates tried) is the same under both goals.

## Why there are two goals

Until this change the optimizer ranked every plan by the after-tax estate at the
end of the projection (traditional balances counted after the heirs' tax rate,
less any spending the plan could not pay for). That is the right measure for a
household whose aim is a bequest. For most users it is the wrong one: a couple
that does not care what is left at death could be told not to convert even when
a plan filling the 22% bracket cuts their own lifetime taxes by a large amount
without changing what they can spend.

## The candidates (both goals)

Each retired year a plan converts enough to fill ordinary taxable income to the
top of a target bracket. In "let the calculator choose" mode every bracket from
10% to 35% is tried, each with and without staying $1,000 under the next
Medicare IRMAA threshold, which gives twelve candidates. The candidates are
ordered from the **least to the most aggressive**: lower bracket first, and
within a bracket, staying under the IRMAA threshold ("avoid") before ignoring it.
That order is what "less aggressive" means below.

## Goal 1: pay the least tax over my lifetime

**Measure.** Lifetime tax = the sum over the projection of each year's total
tax, in today's dollars. A year's total tax is federal income tax + state income
tax + capital-gains tax + NIIT + Medicare IRMAA surcharges + early-withdrawal,
HSA and Roth penalties (the projection's `totalTax`). Each year's figure is
deflated by the user's inflation rate before it is added, the same "today's
dollars" convention the rest of the app uses.

**Guard.** Running out of money also ends the tax bill, so without a guard the
cheapest plan could be the one that goes broke. The rule: a plan that leaves
spending unpaid is never chosen over one that leaves less unpaid, whatever its
tax. In practice: among plans that pay for every year, the one with the lowest
lifetime tax wins; if every plan falls short, the one falling short by least
wins, and lifetime tax only breaks ties among equals. The guard also lets a more
aggressive plan beat a less aggressive one that runs out (conversions can make
money last longer).

**Ties.** Differences of a dollar or less are ties, and a tie goes to the less
aggressive plan. Identical plans are common: at a high bracket the whole balance
is converted in the first year, so the IRMAA-avoid and IRMAA-ignore variants,
or two adjacent brackets, produce the same projection.

**Worth it?** The plan is recommended when it converts something, saves more
than $500 of lifetime tax, and does not leave more spending unpaid than not
converting. A plan that "saves" tax only because the money runs out is not
recommended; the summary says so.

**What it does not count.** What is left at the end is not part of this goal.
Tax paid early forgoes the growth that money would have earned, and the
deflation is by inflation, not by the investment return, so this goal favours
paying tax sooner. For a wealthy household the suggested plan can pay much less
lifetime tax and still leave noticeably less in the accounts at the end, before
any heirs' tax. The results show both figures side by side, and the notes point
to the other goal.

## Goal 2: leave the most to my heirs

Unchanged from the previous behaviour: the plan with the highest **net
position** at the end of the projection, where net position = Roth + taxable +
(traditional + HSA) × (1 − heirs' tax rate) − spending the plan could not pay
for. Ties (a dollar or less) go to the less aggressive plan. The heirs' tax rate
field is shown only under this goal; under the lifetime-tax goal it changes
nothing.

## Where the goal shows up in the results

Every place that used to speak of the estate now reflects the chosen goal and
says what was optimized:

| Place | Lifetime-tax goal | Heirs goal |
| --- | --- | --- |
| Headline / subline | "...this is the one that pays the least tax over your lifetime" | "...this is the one that leaves the most to your heirs after all taxes" |
| "Worth it" test | lifetime tax saved > $500 and no extra unpaid spending | after-tax estate gain > $500 |
| First tile | Tax over your lifetime (± vs not converting) | Left to your heirs (± vs not converting) |
| Second tile | Left at the end, before heirs' tax (so the trade-off is visible) | Tax over your lifetime |
| Break-even tile | same age; "not in your lifetime" no longer promises a payoff for heirs | as before |
| Notes | what was optimized, the plans set aside by the guard and why, how to switch goal | what was optimized, the heirs' rate used, how to switch goal |
| Plain-view chart | Taxes paid so far, both paths | What you'd leave after taxes |
| Details summary | Lifetime Tax Saved first, After-Tax Wealth Difference second | After-Tax Wealth Advantage first, Lifetime Taxes second |
| Details charts | After-Tax Wealth Over Time added, so both measures are always available | same |
| Show the math | caption names the goal the suggested plan was chosen for | same |
| Key Assumptions | one bullet per goal, including the guard and the time-value caveat | |

## Saved profiles

`goal` is part of the profile (export, import, browser storage). Profiles saved
before the question existed have no goal and load with the lifetime-tax goal;
an import reports the field as defaulted so the user sees the new question. The
export schema version is now 2. Sample profiles do not set a goal; picking one
keeps the goal already chosen.

## Engine API (`js/tax-engine.js`)

- `normalizeInputs(raw).goal`: `'heirs'` or `'lifetimeTax'` (anything else, or missing, is `'lifetimeTax'`).
- `lifetimeTax(scenario, inflationRate)`, `unmetSpendingTotal(scenario, inflationRate)`, `planMetrics(scenario, inflationRate)`.
- `choosePlan(candidates, goal)`: the selection rule above, on candidates ordered least-aggressive first; returns `{ index, passedOver }`.
- `optimizeStrategy(raw, td, { goal, ... })`: `goal` defaults to the inputs' goal. The result carries `goal`, `chosen.goal`, `chosen.passedOver`, `baseline` (the no-conversion plan's metrics) and per-candidate `lifetimeTax`, `unmetSpending`, `netPosition`, `afterTaxEstate`, `runsOutAge`, `chosen`.
- `summarizePlan(result, inflationRate)`: `goal`, `worthIt`, `shortOfMoney`, `gainToday` (the gain under the goal), `taxSavedToday`, `estateGainToday`, `totalEstateA/B`, `estateA/B`, `unmetA/B`, `passedOver`.
- `strategyScore(scenario)` is unchanged: the heirs' measure (net position at the end).

Tests: `tests/goal.test.js` (the California couple, the guard, tie-breaking,
profile migration) and the goal step of `scripts/smoke-test.mjs`.

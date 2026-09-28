# Social Security survivor benefits — design

Status: implemented (see "What was built" at the end). This document was
written before the code and is the reference for how the app treats a
widow(er)'s survivor benefit.

## 1. The problem

Before this change the app knew one Social Security benefit per person,
claimable from 62 to 70 and adjusted only by the retirement-benefit
formula. Two people were served badly:

- **A. Already widowed.** A widow(er) can take a *survivor benefit* on the
  late spouse's record from age 60, and can take it and their own
  retirement benefit at different times (survivor first, own at 70; or own
  first, survivor at full retirement age). The app had no place to enter
  the late spouse's benefit at all.
- **B. Married, spouse projected to die first.** After the projected death
  the app paid the survivor nothing until the survivor's own start age, and
  only then the larger of the two benefits. A survivor whose spouse dies at
  64 while they plan to start their own benefit at 70 was shown six years
  with no Social Security.

## 2. UX for a layman

### Which questions, and when

Everything survivor-related is hidden until it applies.

**Widowed users.** The *Filing Status* question gains an option
"Single — widowed". Picking it files the return as Single (which is the
tax status of a widow(er) without a dependent child) and opens the
survivor questions in the Income card, right after the user's own Social
Security fields:

| Question (label) | Shown when | Default | Help text (plain English) |
| --- | --- | --- | --- |
| Survivor benefit start age | widowed | 67 | "As a widow or widower you can start a survivor benefit at 60. It is 71.5% of the full amount at 60 and rises each month to 100% at your survivor full retirement age (66–67); waiting past that adds nothing. Already collecting it? Enter the age you started." |
| Had your late spouse started Social Security? — *No: I'll enter their full-retirement-age amount* / *Yes: I'll enter what they were receiving* | widowed and not already collecting the survivor benefit | No | "If they had started early, Social Security caps your survivor benefit; if they had waited past full retirement age, you get the higher amount." |
| Your late spouse's benefit at their full retirement age (yearly) *or* Social Security your late spouse was receiving (yearly) *or* Survivor benefit you receive now (yearly) | widowed; the label follows the previous answer, and flips to "you receive now" when the survivor start age is below the current age | blank | "Today's dollars. From their Social Security statement, their award letter, or ask SSA for your survivor benefit amount." |
| Age your late spouse started Social Security | widowed, late spouse had started | 67 | "62 to 70. Starting before their full retirement age limits your survivor benefit to at least 82.5% of their full amount." |
| Late spouse's year of birth | widowed, late spouse had started | blank = same as yours | "Sets their full retirement age, which decides whether they started early or late." |

The user's own benefit questions do not change (amount at full retirement
age, start age 62–70). The help for the own start age gains one sentence:
"You can take one benefit first and switch to the other later; each year
we pay whichever of the two is larger."

**Married users.** Nothing new is required. If a spouse benefit is entered,
one optional question appears under the spouse's Social Security fields:

| Question | Default | Help |
| --- | --- | --- |
| Survivor benefit start age (if your spouse dies first) | 67 | "If your spouse dies first you can take a survivor benefit from 60 (71.5% of theirs, rising to 100% at your survivor full retirement age of 66–67). We start it at this age or when the projection has your spouse die, whichever is later, and pay whichever of your two benefits is larger each year." |

Why one field and not the whole widowed set: for a married couple the late
spouse's benefit, start age and birth year are already known from the
spouse fields; the model derives the survivor benefit from them.

### Defaults

- Survivor start age 67 for both cases, mirroring the existing own-benefit
  default. 67 is at or after every survivor full retirement age, so the
  default never reduces the survivor benefit; the claiming note (below)
  tells the user when starting it earlier pays more.
- "Late spouse had started" defaults to *No* (enter the full-retirement-age
  amount from the statement), the number most widows can find.
- Late spouse's birth year defaults to the user's own.

### "Already collecting" convention

The app already treats a start age below the current age as "this benefit
is being paid now; the amount entered is the current amount, not adjusted
again". The survivor benefit follows the same convention, so a widow of 63
who has drawn the survivor benefit since 60 enters start age 60 and the
amount on her deposit; the late-spouse questions disappear because they are
no longer needed.

### How results explain what was assumed

The default view (the plain-English summary) gets one Social Security
note whenever a survivor benefit is in play, built from the projection
itself, for example:

> Social Security: survivor benefit of $21,450 a year from age 61 (71.5% of
> your late spouse's $30,000, because it starts 6 years before your survivor
> full retirement age), then your own benefit of $37,200 from age 70 (124%
> of $30,000). Today's dollars.

or, for a couple:

> Social Security: your own $28,000 from 67 and your spouse's $22,000 from
> 67; if your spouse dies at 85 as projected, you keep the larger benefit
> ($28,000). Today's dollars.

Detail on demand: the year-by-year tables get a "SS source" column
(own / survivor / spouse dies), "Show the math" names the benefit being
paid ("Social Security (survivor benefit)"), and Key Assumptions carries
the full rule set (section 4).

## 3. Should the app suggest the best claiming order?

**Decision: yes, as a before-tax suggestion with a one-click "Use these
ages" button, shown only when there is a survivor decision to make. It is
not folded into the conversion optimizer, and it never changes the user's
inputs by itself.**

Why suggest at all: the survivor/own ordering is the single biggest lever a
widow(er) has, it is not obvious (most people take whichever benefit is
bigger today), and the app has every number needed to rank the orders. The
rule of thumb ("take the smaller benefit first and let the larger one grow")
is right in principle but depends on the amounts, the survivor's age and
life expectancy, so the app computes it rather than stating it.

How: `suggestSocialSecurityClaiming()` tries every whole-year pair of
(survivor start age 60–70, own start age 62–70) that is still open (a
benefit already being collected is fixed), values each pair as the sum of
the benefits it pays through life expectancy in today's dollars, discounted
at the user's investment growth rate (the same rate at which the projection
compounds money that is not spent), and reports the best pair next to the
pair the user entered. The note appears when the best pair pays more than
$500 (today's dollars) over the entered one:

> Social Security claiming: starting the survivor benefit at 60 and your own
> at 70 would pay about $61,000 more over your lifetime than the ages you
> entered (before taxes, today's dollars). [Use these ages]

For married users the note appears only when the projected death falls
before the user turns 70; after that there is no order to choose (both
benefits are at their final size and the survivor simply keeps the larger).

Why not inside the conversion optimizer: the optimizer already runs 12
projections (six brackets, with and without the IRMAA cap), each with a
bisection per year. Multiplying that by the 99 claiming pairs would make
"Calculate" take a minute or more in the browser, while the claiming
answer is dominated by the benefit sizes and longevity, not by conversions.
Taxes change the answer only at the margin (more benefit means more taxable
Social Security and IRMAA exposure), which is why the note says "before
taxes" and leaves the decision to the user.

Why not auto-apply: the ages are an input the user typed. Health, cash
needs, a job before full retirement age (earnings test), and the fact that
SSA's exact computation can differ by a few dollars are all things the app
cannot see. A suggestion with the size of the gap and one button respects
that.

## 4. Rules modeled, with sources

The SSA pages could not be opened from the development sandbox (network
policy) when this was written. Checked against ssa.gov on 2026-09-28: the
survivor benefit starts at 71.5% at 60 and reaches 100% at survivor FRA
(https://www.ssa.gov/benefits/survivors/survivorchartred.html), and survivor
FRA is 66 for 1945-1956 births rising to 67 for 1962 and later
(https://www.ssa.gov/international/Agreement_Pamphlets/full-retirement-age-survivors.html),
matching the table below.

| Rule | Modeled as | Source |
| --- | --- | --- |
| Earliest survivor claiming age is 60 (50 if disabled) | `earliestClaimAge: 60`; disability not modeled | SSA, Survivors benefits: if you are the survivor — https://www.ssa.gov/benefits/survivors/ifyou.html |
| Survivor full retirement age (FRA) by year of birth: 65 (born through 1939), 65+2 mo (1940) … 65+10 (1944), 66 (1945–1956), 66+2 (1957) … 66+10 (1961), 67 (1962 and later). It is two birth years behind the retirement FRA. | `fullRetirementAge` table in the new rates item | SSA, Survivor benefit reduction chart — https://www.ssa.gov/benefits/survivors/survivorchartred.html; 20 CFR 404.409 — https://www.ssa.gov/OP_Home/cfr20/404/404-0409.htm |
| Reduction for starting before survivor FRA: 71.5% at 60, rising evenly each month to 100% at FRA (28.5% spread over the months from 60 to FRA) | `factor = 1 − 0.285 × (FRA − claim months) / (FRA − 60 × 12)`, clamped at 1 | same chart page; 20 CFR 404.410 — https://www.ssa.gov/OP_Home/cfr20/404/404-0410.htm |
| No increase for starting after survivor FRA (no delayed credits on survivor benefits) | factor is 1 from FRA on; the suggestion never proposes a later survivor age | https://www.ssa.gov/benefits/survivors/ifyou.html |
| Base amount: 100% of what the deceased was receiving (or entitled to at death), including delayed retirement credits they earned | deceased's amount = their full-retirement-age amount × their own claiming factor (`ssClaimingFactor`); if they died after FRA without claiming, credits to the year of death | 20 CFR 404.338 — https://www.ssa.gov/OP_Home/cfr20/404/404-0338.htm; https://www.ssa.gov/benefits/retirement/planner/delayret.html |
| Deceased claimed early (RIB-LIM): survivor gets the smaller of (their own age-reduced amount computed on the deceased's full amount) and (the larger of the deceased's reduced benefit and 82.5% of the deceased's full amount) | `earlyClaimerFloor: 0.825`; implemented exactly as stated | POMS RS 00615.320, widow(er)'s benefit under RIB-LIM — https://secure.ssa.gov/poms.nsf/lnx/0300615320; 20 CFR 404.338(c) |
| Own and survivor benefits are separate: you may take one first and switch to the other later; deemed filing does not apply to survivor benefits; SSA pays the larger (technically your own plus the excess) | each year the user receives max(own benefit if started, survivor benefit if started); each benefit's amount is fixed by its own start age | https://www.ssa.gov/benefits/survivors/ifyou.html; https://www.ssa.gov/benefits/retirement/planner/claiming.html |
| Survivor benefits are taxed like other Social Security benefits (up to 85%, Pub 915) | unchanged: the paid benefit goes through `taxableSocialSecurity` | https://www.irs.gov/publications/p915 |
| Cost-of-living increases | benefits rise with the inflation input (unchanged) | https://www.ssa.gov/cola/ |
| Government Pension Offset no longer reduces survivor benefits (Social Security Fairness Act, 2025) | nothing to model | https://www.ssa.gov/benefits/retirement/social-security-fairness-act.html |

Worked example used in the tests (survivor and late spouse both born
1966, survivor FRA 67, retirement FRA 67; late spouse's full amount
$30,000):

| Case | Computation | Survivor benefit |
| --- | --- | --- |
| Late spouse had not started; survivor starts at 60 | 30,000 × (1 − 0.285 × 84/84) | $21,450 |
| … survivor starts at 64 | 30,000 × (1 − 0.285 × 36/84) | $26,336 |
| … survivor starts at 67 or later | 30,000 × 1 | $30,000 |
| Late spouse started at 62 (70%, was getting $21,000); survivor at 60 | min(30,000 × 0.715, max(21,000, 24,750)) | $21,450 |
| … survivor at 67 | min(30,000, max(21,000, 24,750)) | $24,750 |
| Late spouse started at 70 (124%, was getting $37,200); survivor at 67 | 37,200 × 1 | $37,200 |
| … survivor at 60 | 37,200 × 0.715 | $26,598 (see simplification 1) |

### Simplifications (stated in Key Assumptions)

1. **Delayed credits and an early survivor claim.** When the late spouse
   earned delayed retirement credits and the survivor starts before their
   FRA, the app applies the survivor reduction to the credit-increased
   amount. SSA's exact computation may reduce only the full-retirement-age
   amount and then add the credits, which would be a little higher. The
   combination (a survivor claiming early on a record worth waiting for) is
   one the claiming suggestion steers away from, so the difference rarely
   matters; the conservative figure is used.
2. **Whole years.** Ages are whole years and benefits start at the birthday
   year, as everywhere in the app. The monthly survivor formula is evaluated
   at whole-year ages, so a survivor FRA of 66 and 2 months gives 99.2% at
   66 and 100% at 67.
3. **Death timing.** In the married case the spouse dies at the end of the
   year they reach their life expectancy; the survivor benefit starts the
   following year (or at the survivor start age, or at 60, whichever is
   latest). The last year of the spouse's own benefit is paid in full.

## 5. Edge cases

| Case | Handling |
| --- | --- |
| Remarriage before 60 | Ends survivor eligibility on the late spouse's record. Not modeled; the survivor start age help says so, and the user should simply not enter a survivor benefit. Remarriage at 60 or later does not affect the benefit. |
| Earnings test before FRA (own or survivor benefit while still working) | Not modeled. The app adds a validation warning when a benefit starts before the retirement age entered and before 67: SSA withholds part of the benefit above a yearly earnings limit and repays it later through a recomputed reduction. |
| Deceased spouse claimed early | RIB-LIM, as above. Needs the late spouse's start age and birth year (to know their FRA); both are asked only when the user says the spouse had started. |
| Deceased spouse delayed past FRA | Credits are included in the survivor amount (simplification 1 for early survivor claims). |
| Deceased died after FRA without claiming | Married case: credits accrue to the year of death. Widowed case: the user enters the amount SSA quotes as the full-retirement-age amount (the help says so). |
| Survivor younger than 60 | Nothing is paid until 60. Validation keeps the survivor start age at 60–70. |
| Survivor already collecting the survivor benefit (start age below current age) | The amount entered is paid as is; only the own start age is still open to the claiming suggestion. |
| Own benefit already being collected | As today: paid as is; only the survivor start age is open. |
| Both already collecting | Nothing to suggest; each year pays the larger. |
| Own benefit larger than the survivor benefit at every age | The survivor benefit is never paid; the summary says so. |
| Married, projected death after the user is 70 | Survivor keeps the larger benefit from the year after the death; no claiming note. |
| Married, projected death before the user is 60 | Survivor benefit starts at 60 (or the start age if later). |
| Surviving divorced spouse (marriage lasted 10+ years) | Same rules and fields; the app does not ask about the divorce. |
| Married filing separately | Cannot be widowed; survivor fields do not apply. A married-filing-separately couple gets the married projection. |
| IRMAA | Unchanged: a surviving spouse is judged on the joint return for the two lookback years. |
| State tax | The survivor benefit is Social Security for every state rule (Colorado's age exemption uses the survivor's own age). |

## 6. Out of scope

- Disabled widow(er)s' benefits from 50, and benefits for a surviving spouse
  caring for a child under 16 (mother's/father's benefits), and the
  qualifying-surviving-spouse filing status.
- The $255 lump-sum death payment.
- Family maximum, the earnings test itself, and month-level timing.
- Suggesting the own-benefit start age for married couples whose survivor
  decision is moot (the app is a conversion optimizer, not a general
  claiming optimizer).
- Optimizing claiming ages jointly with conversions (see section 3).

## 7. Data and code

- `data/rates.json` gets a required item `socialSecuritySurvivor`
  (survivor FRA table, earliest claiming age, maximum reduction, RIB-LIM
  floor, remarriage cutoff age), each with the SSA source. It is statutory:
  the fetcher carries it forward like the other Social Security rules.
- `js/tax-engine.js`: `survivorFullRetirementAgeMonths`,
  `ssSurvivorFactor`, `survivorBenefitAmount` (RIB-LIM included),
  `socialSecurityPlan` (the year-by-year own / spouse / survivor schedule
  shared by the projection and the suggestion),
  `suggestSocialSecurityClaiming`, and new inputs `widowed`,
  `survivorBenefit`, `survivorBenefitType`, `lateSpouseStartAge`,
  `lateSpouseBirthYear`, `survivorStartAge`. Projection rows carry
  `ssOwn`, `ssSurvivor`, `ssSource`.
- Tests: hand-worked values in `tests/tax-calcs.test.js` (factor, FRA
  table, RIB-LIM), projection cases in `tests/projection.test.js`
  (widowed switch both ways, already collecting, married projected death
  before and after the survivor's FRA, suggestion picks the right order),
  and validation of the new rates item in `tests/rates-data.test.js`.

## 8. What was built

See the commit that adds this file. Every item in sections 2–5 marked
"modeled", "warning", or "shown" is implemented; items marked "not
modeled" are listed in Key Assumptions in the app.

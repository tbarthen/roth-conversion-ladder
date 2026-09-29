# Roth Conversion Ladder Optimizer

## Project Overview
Single-page React app (no build tools) that shows whether Roth conversions lower lifetime taxes and how much to convert each year. Hosted on GitHub Pages from the `main` branch.

**Live site:** https://tbarthen.github.io/roth-conversion-ladder/

## Architecture
- `index.html` — the UI: React 18 + Babel (in-browser) + Recharts, all inline. Contains **no tax math**. Also holds an embedded copy of `data/rates.json` (`<script id="embedded-rates">`) used when that file can't be fetched.
- `js/tax-engine.js` — **all** tax math and the projection/optimizer (plain JS, UMD: `window.TaxEngine` in the browser, `require()` in Node). Pure functions; every figure comes from the rates document passed in. The optimizer ranks plans by the user's **goal** (`inputs.goal`): `lifetimeTax` (default: lowest total tax in today's dollars, with a guard against plans that leave spending unpaid; ties to the less aggressive plan) or `heirs` (largest after-tax estate). See `docs/optimization-goal.md`.
- `data/rates.json` — **single source of truth for every tax figure** (federal brackets, deductions, capital gains, NIIT, Social Security rules incl. survivor benefits, IRMAA, RMD tables, penalties, state brackets). Schema v2: each item has `label`, `sourceName`, `source` (https URL), `effectiveYear`, `indexed`, `value`. Top level has `taxYear`, `lastChecked`, `lastUpdated`. The app fetches it at runtime.
- `scripts/sync-rates.js` — validates `data/rates.json`, rewrites it in canonical format, and copies it into the embedded fallback in `index.html`. `--check` fails if anything is out of sync.
- `scripts/smoke-test.mjs` — headless-browser smoke test (loads the page, runs a calculation, opens every tab, exercises the stale-data banner and "Check now").
- `tests/*.test.js` — unit tests for every calculation (`node:test`, no dependencies); `tests/goal.test.js` covers the goal choice. The calculation tests run on `tests/fixtures/rates-2026.json`, a frozen copy of the 2026 figures (also used by the fetcher's parser/updater tests), so hand-worked expected values stay valid when `data/rates.json` moves to a new tax year; only `tests/rates-data.test.js` checks the live file.
- `docs/optimization-goal.md` — the goal choice ("Pay the least tax over my lifetime" vs "Leave the most to my heirs"): the measures, the run-out-of-money guard, tie-breaking, where each result view reflects the goal, and profile migration. Read it before touching `choosePlan` / `optimizeStrategy` / `summarizePlan` in the engine or the goal question, tiles and notes in the page.
- `docs/survivor-benefits.md` — design of the Social Security survivor-benefit model (widowed users and married couples after the projected death): the questions asked, the SSA rules with sources, the claiming-order suggestion, edge cases and what is out of scope. Read it before touching `socialSecurityPlan` / `suggestSocialSecurityClaiming` in the engine or the survivor fields in the form.
- `fetcher/` — Python Cloud Run function (+ monthly Cloud Scheduler job) that fetches current IRS/CMS/state figures, validates them, and commits `data/rates.json` + the embedded copy to `claude/tax-data-update`, or opens a GitHub issue (label `tax-data-fetcher`). See README for deployment.

**CSP note:** `unsafe-eval` and `unsafe-inline` are accepted trade-offs of the no-build-tools / in-browser Babel architecture — Babel standalone transforms JSX at runtime via `eval`. Removing them would require adding a build step. `connect-src` allows `https://*.run.app` so "Check now" can reach the fetcher.

## Rules for changes
- Results text must say which goal the plan was chosen for. Anything in `index.html` that compares "the plan" with not converting (headline, tiles, notes, charts, details cards, show-the-math) must read `result.goal` / `summary.goal` and describe the goal's measure; never show the estate as the headline figure under the lifetime-tax goal or lifetime tax as the headline under the heirs goal. The heirs' tax rate field is shown only for the heirs goal.
- Profile fields: add new inputs to `INPUT_FIELD_PATHS`, `FIELD_LABELS` and `makeDefaultInputs` in `index.html` and give them a default in `normalizeInputs` so older saved profiles keep working (a profile without `goal` is the lifetime-tax goal).
- Tax math goes in `js/tax-engine.js` with a unit test in `tests/`. Never hard-code a tax figure in code — add it to `data/rates.json` (with source URL and effective year) and read it from there.
- After editing `data/rates.json`, run `node scripts/sync-rates.js` (keeps the embedded fallback identical). The Python fetcher writes the same canonical format (`fetcher/tax_fetcher/ratesfmt.py`); keep the two formatters in step.
- Each state entry carries `standardDeduction`, `personalExemption` and `personalCredit` (single / joint) from the Tax Foundation table; the fetcher re-parses them. An optional `retirementExclusion` (`iraFromAge`, `conversions`, `pensions`, `sourceName`, `source`) marks a state that exempts IRA withdrawals / Roth conversions / pensions (currently PA, IL, MS). It is maintained by hand with its own source, and the fetcher carries it forward. Partial exclusions in other states are a documented limitation (Key Assumptions), not modeled. Likewise an optional `socialSecurityExemption` (`fromAge`, `sourceName`, `source`) on a state with `taxesSocialSecurity: true` marks a state that leaves each person's Social Security out from that age (currently CO, 65); the engine exempts the share of the benefits belonging to people at or past that age. An optional `seniorCredit` (`fromAge`, `perPerson`, `sourceName`, `source`) adds a per-person credit for each person on the return at or past `fromAge` (currently CA's senior exemption credit, 65); it is indexed like the other state amounts, hand-maintained, and carried forward by the fetcher.
- A state entry with `"override": true` was corrected by hand (e.g. a mid-year retroactive law); the fetcher won't flag or replace it until the next tax year's table.
- Before pushing, all of these must pass:
  ```bash
  node scripts/sync-rates.js --check
  node --test tests/*.test.js
  python3 -m unittest discover -s fetcher/tests -t fetcher
  node scripts/smoke-test.mjs          # needs Playwright + Chromium; add --cdn-dir <dir> when unpkg.com is unreachable
  ```

## Deployment Workflow

**Claude Code cannot push directly to `main`.** All pushes go to a `claude/*` branch (any name, e.g. the branch the session was given).

A GitHub Action (`.github/workflows/auto-merge-claude.yml`) runs on every `claude/*` push: it runs the rates sync check, the JS unit tests and the fetcher tests, and **only if they pass** merges the commit into `main`, which triggers the GitHub Pages deployment. A red run means nothing was deployed.

### If auto-merge fails
- **Tests failed:** open the run in the Actions tab, fix, push again.
- **Merge conflict:** `main` has changes that conflict with the branch (e.g. manual edits). Merge `main` into the branch locally, resolve, push.
- **Permissions:** the workflow needs `contents: write` (already configured).

### Manual deployment (from iTerm2)
```bash
cd ~/roth-conversion-ladder
git fetch origin <claude-branch>
git checkout main
git merge origin/<claude-branch>
git push origin main
```

## Tax Data Updates
- The fetcher runs monthly (3rd of the month) and on demand via the app's "Check now" (for the site owner, after entering the fetcher URL + secret under Sources → "Site owner: data updater"). Every clean run commits an updated `lastChecked` date; changed figures also bump `lastUpdated`.
- It re-fetches federal brackets/deductions/capital gains (Tax Foundation's annual page), Medicare IRMAA (CMS fact sheet) and state rates (Tax Foundation). Statutory items (NIIT, Social Security taxation, claiming and survivor rules, RMD tables, penalties, the 2025–2028 senior deduction) are carried forward. Any figure moving more than 15% (for states: the top rate, the number of brackets, and every bracket rate and bound), a changed page layout, a missing source after March, or a same-year discrepancy opens/updates a GitHub issue instead of committing.
- The app shows "Tax data: <year> figures · last checked <date>" and a banner only when the data is stale (new calendar year without new figures, or last check > 45 days) or newer data is available.
- To fix data by hand (e.g. from a fetcher issue): edit `data/rates.json`, run `node scripts/sync-rates.js`, run the tests, push to a `claude/*` branch. Or ask Claude Code: "Update the tax figures in data/rates.json for <year> and resolve the open tax-data-fetcher issue."
- The old `annual-tax-reminder.yml` workflow was retired; the fetcher's issues replace it.

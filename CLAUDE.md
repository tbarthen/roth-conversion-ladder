# Roth Conversion Ladder Optimizer

## Project Overview
Single-page React app (no build tools) that calculates optimal Roth conversion ladder strategies. Hosted on GitHub Pages from the `main` branch.

**Live site:** https://tbarthen.github.io/roth-conversion-ladder/

## Architecture
- `index.html` — The entire app: React 18 + Babel (in-browser) + Recharts, all inline
- `data/rates.json` — State tax rates fetched at runtime (with embedded fallback in index.html)
- `scripts/rates.json` — Canonical source for rate data
- `scripts/update-state-tax-rates.js` — Syncs rates.json into data/ and patches the embedded fallback in index.html

## Deployment Workflow

**Claude Code cannot push directly to `main`.** All pushes must go to a `claude/*` branch.

A GitHub Action (`.github/workflows/auto-merge-claude.yml`) automatically merges `claude/*` branch pushes into `main`, which triggers the GitHub Pages deployment.

### How it works
1. Claude Code pushes to `claude/roth-conversion-optimizer-BBrBE` (or any `claude/*` branch)
2. The auto-merge Action checks out `main`, merges the commit, and pushes to `main`
3. GitHub Pages deploys from `main`

### If auto-merge fails
Common causes:
- **Merge conflict:** `main` has changes that conflict with the `claude/*` branch (e.g., from manual edits). Fix by pulling both branches locally in iTerm2 and resolving conflicts.
- **Branch doesn't exist:** `main` must exist on the remote. If starting fresh, create it manually first.
- **Permissions:** The workflow needs `contents: write` permission (already configured).

To check: go to the repo's Actions tab on GitHub and look at the failed run's logs.

### Manual deployment (from iTerm2)
If auto-merge is broken, you can always deploy manually:
```bash
cd ~/roth-conversion-ladder
git fetch origin claude/roth-conversion-optimizer-BBrBE
git checkout main
git merge origin/claude/roth-conversion-optimizer-BBrBE
git push origin main
```

## Annual Tax Rate Updates
- The same workflow (`.github/workflows/auto-merge-claude.yml`) also has a scheduled job that fires every January 2 and creates a GitHub issue reminding you to update state tax rates. Both jobs live in one file to avoid junk notification emails from GitHub.
- To update: edit `data/rates.json` (year, updated date, any changed rates), commit, and push. The app fetches this file at runtime.
- Alternatively, ask Claude Code: "Update the state tax rates for [year]. Research the latest rates from Tax Foundation and update data/rates.json."
- The script `scripts/update-state-tax-rates.js` can also sync rates into the embedded fallback in index.html.

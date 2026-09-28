# Roth Conversion Ladder Optimizer

Shows whether moving money from a traditional IRA/401(k) into a Roth IRA would lower your lifetime taxes, and how much to convert each year. The results open with a plain-English summary. **Show details** opens charts, year-by-year tables and a step-by-step "Show the math" view.

Live site: https://tbarthen.github.io/roth-conversion-ladder/

- `index.html`: the app (no build step)
- `js/tax-engine.js`: all tax math
- `data/rates.json`: every tax figure, with its source and tax year
- `fetcher/`: monthly updater for those figures

Architecture and working rules are in `CLAUDE.md`.

```bash
# run locally
python3 -m http.server 8000        # then open http://localhost:8000

# tests
node scripts/sync-rates.js --check
node --test tests/*.test.js
python3 -m unittest discover -s fetcher/tests -t fetcher
node scripts/smoke-test.mjs        # browser smoke test (needs Playwright + Chromium)
```

## Tax-data fetcher: one-time setup (steps you run yourself)

The fetcher is a Python Cloud Run function in GCP project `glossy-reserve-153120`, called monthly by Cloud Scheduler. Each run either commits the current figures to the `claude/tax-data-update` branch, which auto-merges and deploys after the tests pass, or opens a GitHub issue labeled `tax-data-fetcher`.

Limits: max 1 instance, 60 s timeout, at most 1 scheduler retry.

### 1. Create a GitHub token (about 2 minutes)

1. Go to GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → *Generate new token*.
2. Fill in the token:
   - Name: `roth-ladder-tax-fetcher`
   - Expiration: up to 1 year. Set a reminder to rotate it.
   - Repository access: **Only select repositories** → `tbarthen/roth-conversion-ladder`
   - Permissions → Repository: **Contents: Read and write**, **Issues: Read and write** (Metadata: read is added automatically).
3. Copy the token. The deploy script prompts for it once and stores it in Secret Manager, not in the repo.

### 2. Deploy (about 5 minutes)

From a machine with the [gcloud CLI](https://cloud.google.com/sdk/docs/install):

```bash
gcloud auth login
cd roth-conversion-ladder
./fetcher/deploy.sh
```

The script:
1. Enables the needed APIs (Cloud Functions/Run, Cloud Build, Artifact Registry, Secret Manager, Cloud Scheduler).
2. Creates two secrets:
   - `tax-fetcher-github-token`: prompts you for the token.
   - `tax-fetcher-check-secret`: randomly generated.
3. Deploys the function `tax-data-fetcher` in `us-central1`.
4. Creates the scheduler job `tax-data-monthly` (09:17 New York time on the 3rd of each month, 1 retry).
5. Prints the function URL.

Re-running the script is safe. It redeploys and keeps the existing secrets.

If your organization blocks public (unauthenticated) Cloud Run services, the deploy will fail at `--allow-unauthenticated`. In that case allow it for this project: IAM → Organization policies → "Domain restricted sharing".

### 3. Try it

```bash
gcloud scheduler jobs run tax-data-monthly --location=us-central1
gcloud functions logs read tax-data-fetcher --gen2 --region=us-central1 --limit=20
```

Within about a minute you should see either:
- a new commit on `claude/tax-data-update`, followed by an auto-merge run in the Actions tab, or
- an issue labeled `tax-data-fetcher` explaining what needs a human.

The first live run may open an issue. The page parsers were built against the documented layouts of the Tax Foundation and CMS pages, but they couldn't be tested against the live pages from the development sandbox. If that happens, the issue says which source failed, and the parser in `fetcher/tax_fetcher/sources.py` needs adjusting.

### 4. Turn on "Check now" for yourself (optional)

1. On the live site, open **Sources & References → Site owner: data updater**.
2. Paste the function URL and the secret. To print the secret, run `gcloud secrets versions access latest --secret=tax-fetcher-check-secret`.
3. Both values are saved only in that browser.

After this, **Check now** asks the fetcher for fresh official figures. Visitors without the secret still get a working "Check now" that re-reads the published data file.

### Maintenance

- **Rotate the GitHub token:**
  ```bash
  printf '%s' NEW_TOKEN | gcloud secrets versions add tax-fetcher-github-token --data-file=-
  ```
  Then redeploy with `./fetcher/deploy.sh`.
- **Rotate the shared secret:** add a new version of `tax-fetcher-check-secret`, re-run `./fetcher/deploy.sh` (it updates the scheduler header), and re-enter the secret in the browser.
- **Pause the monthly job:**
  ```bash
  gcloud scheduler jobs pause tax-data-monthly --location=us-central1
  ```

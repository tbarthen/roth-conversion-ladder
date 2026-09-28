#!/usr/bin/env bash
# Deploy the tax-data fetcher as a Cloud Run function plus a monthly
# Cloud Scheduler job. Safe to re-run: existing secrets are kept, the
# function is redeployed, and the scheduler job is updated in place.
#
# Prerequisites (see README "Tax-data fetcher: one-time setup"):
#   - gcloud CLI logged in as a project owner/editor
#   - a fine-grained GitHub token (Contents + Issues: read/write on the repo)
#
# Usage:  ./fetcher/deploy.sh
set -euo pipefail

PROJECT="${PROJECT:-glossy-reserve-153120}"
REGION="${REGION:-us-central1}"
FUNCTION="${FUNCTION:-tax-data-fetcher}"
JOB="${JOB:-tax-data-monthly}"
REPO="${GITHUB_REPO:-tbarthen/roth-conversion-ladder}"
ORIGIN="${ALLOWED_ORIGIN:-https://tbarthen.github.io}"
SCHEDULE="${SCHEDULE:-17 9 3 * *}"          # 09:17 on the 3rd of every month
TIME_ZONE="${TIME_ZONE:-America/New_York}"
HERE="$(cd "$(dirname "$0")" && pwd)"

gcloud config set project "$PROJECT" >/dev/null
echo "==> Enabling APIs (first run takes a minute)"
gcloud services enable cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com

ensure_secret() {  # name, prompt, generate?
  local name="$1" prompt="$2" generate="${3:-}"
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    echo "==> Secret $name exists (keeping it)"
    return
  fi
  local value
  if [[ -n "$generate" ]]; then
    value="$(openssl rand -hex 32)"
    echo "==> Generated $name"
  else
    read -r -s -p "$prompt: " value; echo
  fi
  printf '%s' "$value" | gcloud secrets create "$name" --replication-policy=automatic --data-file=-
}
ensure_secret tax-fetcher-github-token "Paste the GitHub fine-grained token"
ensure_secret tax-fetcher-check-secret "" generate

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for s in tax-fetcher-github-token tax-fetcher-check-secret; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:${RUNTIME_SA}" \
    --role=roles/secretmanager.secretAccessor >/dev/null
done

echo "==> Deploying $FUNCTION (max 1 instance, 60 s timeout)"
gcloud functions deploy "$FUNCTION" \
  --gen2 --region="$REGION" --runtime=python312 \
  --source="$HERE" --entry-point=check_tax_data \
  --trigger-http --allow-unauthenticated \
  --max-instances=1 --timeout=60s --memory=256Mi \
  --set-env-vars="GITHUB_REPO=${REPO},ALLOWED_ORIGIN=${ORIGIN}" \
  --set-secrets="GITHUB_TOKEN=tax-fetcher-github-token:latest,CHECK_SECRET=tax-fetcher-check-secret:latest"

echo "==> Setting image cleanup policy (keep latest 3, delete older than 1 day)"
# Each deploy stores a container image in gcf-artifacts; without this, old
# images accumulate past the 0.5 GB free tier and bill monthly.
POLICY_FILE="$(mktemp)"
cat > "$POLICY_FILE" <<'JSON'
[
  {"name": "delete-older-than-1d", "action": {"type": "Delete"},
   "condition": {"tagState": "any", "olderThan": "1d"}},
  {"name": "keep-latest-3", "action": {"type": "Keep"},
   "mostRecentVersions": {"keepCount": 3}}
]
JSON
gcloud artifacts repositories set-cleanup-policies gcf-artifacts \
  --location="$REGION" --policy="$POLICY_FILE" --no-dry-run >/dev/null
rm -f "$POLICY_FILE"

URL="$(gcloud functions describe "$FUNCTION" --gen2 --region="$REGION" --format='value(serviceConfig.uri)')"
SECRET="$(gcloud secrets versions access latest --secret=tax-fetcher-check-secret)"

echo "==> Scheduling monthly check ($SCHEDULE $TIME_ZONE), at most 1 retry"
JOB_ARGS=(--location="$REGION" --schedule="$SCHEDULE" --time-zone="$TIME_ZONE" --uri="$URL"
  --http-method=POST --message-body='{"source":"scheduler"}'
  --attempt-deadline=90s --max-retry-attempts=1 --min-backoff=10m)
if gcloud scheduler jobs describe "$JOB" --location="$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$JOB" "${JOB_ARGS[@]}" \
    --update-headers="Content-Type=application/json,X-Check-Secret=${SECRET}"
else
  gcloud scheduler jobs create http "$JOB" "${JOB_ARGS[@]}" \
    --headers="Content-Type=application/json,X-Check-Secret=${SECRET}"
fi

cat <<EOF

Done.
  Function URL : $URL
  Run it now   : gcloud scheduler jobs run $JOB --location=$REGION
  "Check now"  : on the site, open Sources -> "Site owner: data updater", paste the URL above
                 and the secret from:  gcloud secrets versions access latest --secret=tax-fetcher-check-secret
EOF

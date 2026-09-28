"""Cloud Run function entry point: POST to run the tax-data check.

Called monthly by Cloud Scheduler and on demand by the app's "Check now"
button. Both must send the shared secret in the X-Check-Secret header.

Environment:
  GITHUB_TOKEN    fine-grained token (Contents + Issues read/write on the repo)
  GITHUB_REPO     owner/repo, e.g. tbarthen/roth-conversion-ladder
  CHECK_SECRET    shared secret for X-Check-Secret
  ALLOWED_ORIGIN  site origin allowed to call from the browser
                  (default https://tbarthen.github.io)
"""
import datetime
import hmac
import json
import os
import time

import functions_framework

from tax_fetcher.github import GitHub
from tax_fetcher.updater import run_check

COOLDOWN_SECONDS = 60
_last = {"at": 0.0, "result": None}


def _cors(origin):
    allowed = os.environ.get("ALLOWED_ORIGIN", "https://tbarthen.github.io")
    headers = {"Vary": "Origin"}
    if origin == allowed:
        headers.update({
            "Access-Control-Allow-Origin": allowed,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Check-Secret",
            "Access-Control-Max-Age": "3600",
        })
    return headers


def _reply(status, body, headers):
    return (json.dumps(body), status, {**headers, "Content-Type": "application/json", "Cache-Control": "no-store"})


@functions_framework.http
def check_tax_data(request):
    headers = _cors(request.headers.get("Origin", ""))
    if request.method == "OPTIONS":
        return ("", 204, headers)
    if request.method != "POST":
        return _reply(405, {"status": "error", "message": "Use POST."}, headers)

    expected = os.environ.get("CHECK_SECRET", "")
    given = request.headers.get("X-Check-Secret", "")
    if not expected:
        return _reply(500, {"status": "error", "message": "Server is missing CHECK_SECRET."}, headers)
    if not hmac.compare_digest(given.encode(), expected.encode()):
        return _reply(401, {"status": "error", "message": "Wrong or missing secret."}, headers)

    now = time.monotonic()
    if _last["result"] is not None and now - _last["at"] < COOLDOWN_SECONDS:
        return _reply(200, {**_last["result"], "message": _last["result"]["message"] + " (cached)"}, headers)

    try:
        gh = GitHub(os.environ.get("GITHUB_TOKEN"), os.environ.get("GITHUB_REPO"))
        result = run_check(gh, datetime.datetime.now(datetime.timezone.utc).date())
    except Exception as e:  # report, don't leak a stack trace to the browser
        print(f"check failed: {type(e).__name__}: {e}", flush=True)
        return _reply(502, {"status": "error", "message": f"Check failed: {type(e).__name__}."}, headers)

    print(json.dumps({k: v for k, v in result.items() if k != "rates"}), flush=True)
    _last.update(at=now, result=result)
    return _reply(200, result, headers)

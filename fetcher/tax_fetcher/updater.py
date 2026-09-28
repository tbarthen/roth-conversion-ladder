"""Monthly check: fetch current figures, validate, then commit or open an issue."""
import copy
import json
import time

from . import sources
from .ratesfmt import embed_in_index, format_rates_json
from .validate import compare_to_prior, differs, validate_rates

RATES_PATH = "data/rates.json"
INDEX_PATH = "index.html"
ISSUE_LABEL = "tax-data-fetcher"
PENDING_GRACE_MONTH = 3   # a new year's figures may be missing through March

GROUPS = (
    ("Federal brackets and deductions", sources.federal_urls, sources.parse_federal,
     ("federalBrackets", "standardDeduction", "additionalStandardDeduction65", "capitalGainsBrackets")),
    ("Medicare IRMAA", sources.irmaa_urls,
     lambda html, year: {"medicareIrmaa": sources.parse_irmaa(html, year)}, ("medicareIrmaa",)),
    ("State income tax", sources.state_urls,
     lambda html, year: {"stateIncomeTax": sources.parse_states(html, year)}, ("stateIncomeTax",)),
)
STATUTORY = ("seniorBonusDeduction", "niit", "socialSecurityTaxation", "socialSecurityClaiming", "rmd", "penalties")


STATE_ALLOWANCE_KEYS = ("standardDeduction", "personalExemption", "personalCredit")


def _merge_states(prior_value, parsed):
    """Build a new stateIncomeTax value from parsed rates and deductions,
    keeping names, the Social Security flag and the hand-maintained
    Social Security age exemptions, senior credits and retirement-income exclusions from the
    prior data (overrides are dropped)."""
    states, missing = [], []
    for s in prior_value["states"]:
        p = parsed.get(s["abbr"])
        if not p:
            missing.append(s["abbr"])
            continue
        new = {"abbr": s["abbr"], "name": s["name"], "rate": p["rate"], "taxesSocialSecurity": s["taxesSocialSecurity"]}
        if "socialSecurityExemption" in s:
            new["socialSecurityExemption"] = s["socialSecurityExemption"]
        new.update({k: p[k] for k in STATE_ALLOWANCE_KEYS})
        if "seniorCredit" in s:
            new["seniorCredit"] = s["seniorCredit"]
        if "retirementExclusion" in s:
            new["retirementExclusion"] = s["retirementExclusion"]
        new["brackets"] = p["brackets"]
        states.append(new)
    return {"states": states}, missing


def _state_discrepancies(prior_value, parsed):
    out = []
    for s in prior_value["states"]:
        p = parsed.get(s["abbr"])
        if p is None:
            out.append(f"{s['abbr']} missing from the page")
        elif not s.get("override"):
            if abs(p["rate"] - s["rate"]) > 1e-6:
                out.append(f"{s['abbr']}: page says {p['rate']}%, data has {s['rate']}%")
            for k in STATE_ALLOWANCE_KEYS:
                if differs(s.get(k), p[k]):
                    out.append(f"{s['abbr']}: page says {k} {p[k]}, data has {s.get(k)}")
    return out


def build_candidate(prior, today, fetch, deadline):
    """Return (candidate, problems, notes). Pure apart from `fetch`."""
    year = today.year
    cand = copy.deepcopy(prior)
    items = cand["items"]
    problems, notes = [], []

    for label, urls_for, parse, keys in GROUPS:
        lagging = any(prior["items"][k]["effectiveYear"] < year for k in keys)
        if time.monotonic() > deadline:
            problems.append(f"{label}: skipped, ran out of time")
            continue
        try:
            url, html = fetch(urls_for(year))
            parsed = parse(html, year)
        except sources.NotPublished as e:
            if lagging:
                if today.month > PENDING_GRACE_MONTH:
                    problems.append(f"{label}: {year} figures are still not published ({e}).")
                else:
                    notes.append(f"{label}: {year} figures not published yet; keeping {prior['items'][keys[0]]['effectiveYear']} figures.")
            else:
                notes.append(f"{label}: source page not found ({e}); keeping current {year} figures.")
            continue
        except sources.ParseError as e:
            problems.append(f"{label}: the source page changed or could not be read ({e}).")
            continue
        except Exception as e:  # network errors, timeouts, HTTP 5xx
            problems.append(f"{label}: could not fetch the source ({type(e).__name__}: {e}).")
            continue

        staged, group_problems = {}, []
        for key in keys:
            it = items[key]
            before = prior["items"][key]
            if key == "stateIncomeTax":
                new_value, missing = _merge_states(before["value"], parsed[key])
                if missing:
                    group_problems.append(f"{label}: states missing from the page: {', '.join(missing)}")
                    continue
            else:
                new_value = parsed[key]
            if before["effectiveYear"] < year:
                changes = compare_to_prior(key, before["value"], new_value)
                if changes:
                    group_problems.extend(changes)
                    continue
                staged[key] = new_value
            else:
                if key == "stateIncomeTax":
                    diffs = _state_discrepancies(before["value"], parsed[key])
                else:
                    diffs = [f"{key}: figures differ"] if differs(before["value"], new_value) else []
                if diffs:
                    group_problems.append(f"{it['label']}: the source now shows different {year} figures than our data: "
                                          + "; ".join(diffs[:10]))
        # All-or-nothing per source, so one page never leaves items on mixed years
        problems.extend(group_problems)
        if not group_problems:
            for key, new_value in staged.items():
                it = items[key]
                it["value"], it["effectiveYear"], it["source"] = new_value, year, url
                notes.append(f"{it['label']}: updated to {year} figures.")

    fed_year = items["federalBrackets"]["effectiveYear"]
    for key in STATUTORY:
        if items[key]["effectiveYear"] < fed_year:
            items[key]["effectiveYear"] = fed_year
            notes.append(f"{items[key]['label']}: set by law; carried forward to {fed_year}.")
    cand["taxYear"] = fed_year
    return cand, problems, notes


def _content(doc):
    return json.dumps({k: v for k, v in doc.items() if k not in ("lastChecked", "lastUpdated")}, sort_keys=True)


def run_check(gh, today, fetch=None, time_budget=45.0, base_branch="main", target_branch="claude/tax-data-update"):
    """Run one check. Returns a JSON-serializable result dict."""
    fetch = fetch or (lambda urls: sources.fetch_first(urls, timeout=12))
    deadline = time.monotonic() + time_budget
    prior = json.loads(gh.read_file(RATES_PATH, base_branch))
    prior_problems = validate_rates(prior)
    if prior_problems:
        body = "The current data/rates.json on main is invalid:\n\n" + "\n".join(f"- {p}" for p in prior_problems)
        url = gh.open_or_update_issue(ISSUE_LABEL, f"Tax data needs attention ({today.isoformat()})", body)
        return {"status": "problems", "message": "Current data is invalid; opened an issue.", "issueUrl": url,
                "problems": prior_problems}

    cand, problems, notes = build_candidate(prior, today, fetch, deadline)
    problems += validate_rates(cand)

    if problems:
        body = "\n".join([
            f"The monthly tax-data check on {today.isoformat()} found problems, so nothing was committed.",
            "", "**Problems**", *[f"- {p}" for p in problems],
            *(["", "**Notes**", *[f"- {n}" for n in notes]] if notes else []),
            "", "**What to do**",
            "- If a figure really changed by more than 15%, or a source page moved, update `data/rates.json` by hand "
            "(or ask Claude Code: \"Update the tax figures for this year in data/rates.json\"), then run "
            "`node scripts/sync-rates.js` and push to a `claude/*` branch.",
            "- If a source is temporarily down, the next monthly run (or the app's \"Check now\") will retry.",
            "- Close this issue once the data is right.",
        ])
        url = gh.open_or_update_issue(ISSUE_LABEL, f"Tax data needs attention ({today.isoformat()})", body)
        return {"status": "problems", "message": "Found problems; opened a GitHub issue for review.",
                "issueUrl": url, "problems": problems, "notes": notes, "rates": prior}

    changed = _content(cand) != _content(prior)
    cand["lastChecked"] = today.isoformat()
    if changed:
        cand["lastUpdated"] = today.isoformat()
    if not changed and prior["lastChecked"] == cand["lastChecked"]:
        return {"status": "unchanged", "message": "Already checked today; figures unchanged.", "notes": notes, "rates": prior}

    formatted = format_rates_json(cand)
    index_html = gh.read_file(INDEX_PATH, base_branch)
    files = {RATES_PATH: formatted, INDEX_PATH: embed_in_index(index_html, formatted)}
    summary = "Update tax data" if changed else "Tax data check: no changes"
    message = f"{summary} ({today.isoformat()})\n\n" + "\n".join(f"- {n}" for n in notes or ["All figures confirmed."])
    commit_url = gh.commit_files(base_branch, target_branch, files, message)
    return {"status": "updated" if changed else "checked",
            "message": "Committed new figures; the site updates in a few minutes." if changed
            else "Figures unchanged; recorded today's check.",
            "commitUrl": commit_url, "notes": notes, "rates": cand}

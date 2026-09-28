import re
"""Unit tests for the tax-data fetcher (stdlib unittest, no network).

Run from the repo root:  python3 -m unittest discover -s fetcher/tests -t fetcher
"""
import copy
import datetime
import json
import os
import sys
import time
import unittest

HERE = os.path.dirname(__file__)
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..")))

from tax_fetcher import sources, updater  # noqa: E402
from tax_fetcher.ratesfmt import embed_in_index, format_rates_json  # noqa: E402
from tax_fetcher.validate import compare_to_prior, differs, validate_rates  # noqa: E402


def fixture(name):
    with open(os.path.join(HERE, "fixtures", name), encoding="utf-8") as f:
        return f.read()


def load_rates():
    with open(os.path.join(ROOT, "data", "rates.json"), encoding="utf-8") as f:
        return json.load(f)


class FormatAndEmbed(unittest.TestCase):
    def test_python_formatter_matches_committed_file_byte_for_byte(self):
        with open(os.path.join(ROOT, "data", "rates.json"), encoding="utf-8") as f:
            text = f.read()
        self.assertEqual(format_rates_json(json.loads(text)), text)

    def test_integral_floats_print_like_javascript(self):
        self.assertEqual(format_rates_json({"a": 5.0, "c": None, "d": True, "e": 0.0127448}),
                         '{"a": 5, "c": null, "d": true, "e": 0.0127448}\n')
        self.assertEqual(format_rates_json({"b": [0.1, 2.5]}), '{\n  "b": [0.1, 2.5]\n}\n')

    def test_embed_replaces_only_the_block(self):
        html = '<p>x</p><script type="application/json" id="embedded-rates">\nOLD\n</script><p>y</p>'
        self.assertEqual(embed_in_index(html, '{"a": 1}\n'),
                         '<p>x</p><script type="application/json" id="embedded-rates">\n{"a": 1}\n</script><p>y</p>')
        with self.assertRaises(ValueError):
            embed_in_index("<html></html>", "{}")

    def test_index_html_embeds_current_rates(self):
        with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
            html = f.read()
        text = format_rates_json(load_rates())
        self.assertEqual(embed_in_index(html, text), html)


class Validation(unittest.TestCase):
    def test_committed_rates_are_valid(self):
        self.assertEqual(validate_rates(load_rates()), [])

    def assertProblem(self, mutate, needle):
        r = load_rates()
        mutate(r)
        errs = validate_rates(r)
        self.assertTrue(any(needle in e for e in errs), f"{needle!r} not in {errs[:4]}")

    def test_rejects_broken_documents(self):
        self.assertProblem(lambda r: r["items"].pop("niit"), "niit: missing")
        self.assertProblem(lambda r: r["items"]["federalBrackets"]["value"]["single"][2].__setitem__(1, 1000), "ascending")
        self.assertProblem(lambda r: r["items"]["federalBrackets"]["value"]["single"][6].__setitem__(1, 1), "must be null")
        self.assertProblem(lambda r: r["items"]["standardDeduction"]["value"].pop("single"), "single")
        self.assertProblem(lambda r: r["items"]["niit"].__setitem__("effectiveYear", 2020), "effectiveYear")
        self.assertProblem(lambda r: r["items"]["niit"].__setitem__("label", "<b>x</b>"), "unsafe")
        self.assertProblem(lambda r: r["items"]["medicareIrmaa"]["value"]["tiers"]["single"][2].__setitem__("magiOver", 1), "ascending")
        self.assertProblem(lambda r: r["items"]["stateIncomeTax"]["value"]["states"][4].__setitem__("rate", 12), "does not match")
        self.assertProblem(lambda r: r["items"]["stateIncomeTax"]["value"]["states"].pop(), "expected 51")
        self.assertProblem(lambda r: r.__setitem__("lastChecked", "yesterday"), "lastChecked")
        self.assertEqual(validate_rates([]), ["rates document must be a JSON object"])

    def test_fifteen_percent_rule(self):
        old = {"single": [[0.1, 10000], [0.2, None]]}
        self.assertEqual(compare_to_prior("x", old, {"single": [[0.1, 11500], [0.2, None]]}), [])
        self.assertEqual(len(compare_to_prior("x", old, {"single": [[0.1, 11600], [0.2, None]]})), 1)
        self.assertTrue(compare_to_prior("x", old, {"single": [[0.1, 10000], [0.2, 5], [0.3, None]]}))
        states_old = {"states": [{"abbr": "OH", "rate": 3.5}, {"abbr": "TX", "rate": 0}]}
        self.assertEqual(len(compare_to_prior("stateIncomeTax", states_old,
                                              {"states": [{"abbr": "OH", "rate": 2.75}, {"abbr": "TX", "rate": 0}]})), 1)
        self.assertEqual(len(compare_to_prior("stateIncomeTax", states_old,
                                              {"states": [{"abbr": "OH", "rate": 3.4}, {"abbr": "TX", "rate": 1}]})), 1)
        self.assertFalse(differs(old, copy.deepcopy(old)))
        self.assertTrue(differs(old, {"single": [[0.1, 10001], [0.2, None]]}))


class Parsers(unittest.TestCase):
    def test_federal_same_year_matches_committed_data(self):
        items = load_rates()["items"]
        parsed = sources.parse_federal(fixture("federal_2026.html"), 2026)
        for key in ("federalBrackets", "standardDeduction", "additionalStandardDeduction65", "capitalGainsBrackets"):
            self.assertEqual(parsed[key], items[key]["value"], key)

    def test_federal_new_year_and_derived_mfs(self):
        parsed = sources.parse_federal(fixture("federal_2027.html"), 2027)
        mfj35 = parsed["federalBrackets"]["marriedFilingJointly"][5][1]
        self.assertEqual(parsed["federalBrackets"]["marriedFilingSeparately"][5][1], mfj35 / 2)
        self.assertEqual(parsed["capitalGainsBrackets"]["marriedFilingSeparately"][1][1], 629000 / 2)
        self.assertEqual(parsed["standardDeduction"],
                         {"single": 16500, "marriedFilingJointly": 33000, "marriedFilingSeparately": 16500})
        self.assertEqual(parsed["additionalStandardDeduction65"], {"unmarried": 2100, "married": 1700})

    def test_federal_rejects_wrong_year_or_missing_tables(self):
        with self.assertRaises(sources.ParseError):
            sources.parse_federal(fixture("federal_2026.html"), 2031)
        with self.assertRaises(sources.ParseError):
            sources.parse_federal("<html><p>2026</p><table><tr><td>10%</td></tr></table></html>", 2026)

    def test_additional_65_order_independent(self):
        text = "an additional standard deduction of $1,650 for married taxpayers and $2,050 for unmarried taxpayers"
        self.assertEqual(sources._additional_65(text), {"unmarried": 2050, "married": 1650})

    def test_irmaa_matches_committed_data(self):
        parsed = sources.parse_irmaa(fixture("irmaa_2026.html"), 2026)
        self.assertEqual(parsed, load_rates()["items"]["medicareIrmaa"]["value"])

    def test_irmaa_missing_part_d_is_an_error(self):
        html = re.sub(r"<table\b(?:(?!</table>).)*?Part D(?:(?!</table>).)*</table>", "",
                      fixture("irmaa_2026.html"), flags=re.S | re.I)
        self.assertNotIn("Part D</", html.replace(" ", ""))
        with self.assertRaises(sources.ParseError):
            sources.parse_irmaa(html, 2026)

    def test_states_parse_all_51_with_matching_top_rates(self):
        parsed = sources.parse_states(fixture("states_2026.html"), 2026)
        self.assertEqual(len(parsed), 51)
        for s in load_rates()["items"]["stateIncomeTax"]["value"]["states"]:
            if s.get("override"):
                continue   # hand-corrected for a 2026 mid-year law the page predates
            self.assertAlmostEqual(parsed[s["abbr"]]["rate"], s["rate"], places=6, msg=s["abbr"])
            self.assertEqual(len(parsed[s["abbr"]]["brackets"]["single"]), len(s["brackets"]["single"]), s["abbr"])
        self.assertEqual(parsed["TX"]["brackets"]["single"], [[0, None]])
        # Continuation rows ("- Alabama") carry the higher brackets.
        self.assertEqual(parsed["AL"]["brackets"]["single"], [[0.02, 500], [0.04, 3000], [0.05, None]])
        self.assertEqual(len(parsed["DC"]["brackets"]["single"]), 7)
        # A "- Iowa" row with no rates must not wipe Iowa's flat rate.
        self.assertEqual(parsed["IA"]["brackets"]["single"], [[0.038, None]])
        # Washington taxes capital gains only: nothing on wages, IRA withdrawals or conversions.
        self.assertEqual(parsed["WA"], {"rate": 0, "brackets": {"single": [[0, None]], "marriedFilingJointly": [[0, None]]}})

    def test_state_name_aliases(self):
        self.assertEqual(sources._state_from_cell("N.Y. (a, b, c)"), "NY")
        self.assertEqual(sources._state_from_cell("W.Va."), "WV")
        self.assertEqual(sources._state_from_cell("District of Columbia*"), "DC")
        self.assertEqual(sources._state_from_cell("Washington DC (u)"), "DC")
        self.assertEqual(sources._state_from_cell("- Alabama"), "AL")
        self.assertEqual(sources._state_from_cell("Washington (n, ss, tt)"), "WA")
        self.assertIsNone(sources._state_from_cell("(a) footnote text"))


class FakeGitHub:
    def __init__(self, rates, index_html):
        self.files = {"data/rates.json": format_rates_json(rates), "index.html": index_html}
        self.commits, self.issues = [], []

    def read_file(self, path, ref):
        return self.files[path]

    def commit_files(self, base, target, files, message):
        self.commits.append((base, target, files, message))
        return "https://github.com/x/y/commit/abc"

    def open_or_update_issue(self, label, title, body):
        self.issues.append((label, title, body))
        return "https://github.com/x/y/issues/1"


def fake_fetch(pages):
    def fetch(urls):
        for url in urls:
            if url in pages:
                page = pages[url]
                if isinstance(page, Exception):
                    raise page
                return url, page
        raise sources.NotPublished("404")
    return fetch


def pages_for(year, federal, irmaa=None, states=None):
    return {
        sources.federal_urls(year)[0]: federal,
        sources.irmaa_urls(year)[0]: irmaa if irmaa is not None else sources.NotPublished("404"),
        sources.state_urls(year)[0]: states if states is not None else sources.NotPublished("404"),
    }


class Updater(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
            self.index = f.read()

    def run_check(self, rates, today, pages):
        gh = FakeGitHub(rates, self.index)
        result = updater.run_check(gh, today, fetch=fake_fetch(pages))
        return gh, result

    def test_same_year_recheck_commits_new_check_date_only(self):
        rates = load_rates()
        today = datetime.date(2026, 10, 28)
        gh, result = self.run_check(rates, today, pages_for(2026, fixture("federal_2026.html"),
                                                            fixture("irmaa_2026.html"), fixture("states_2026.html")))
        self.assertEqual(result["status"], "checked", result)
        self.assertEqual(len(gh.commits), 1)
        base, target, files, message = gh.commits[0]
        self.assertEqual((base, target), ("main", "claude/tax-data-update"))
        new = json.loads(files["data/rates.json"])
        self.assertEqual(new["lastChecked"], "2026-10-28")
        self.assertEqual(new["lastUpdated"], rates["lastUpdated"])
        self.assertEqual(embed_in_index(files["index.html"], files["data/rates.json"]), files["index.html"])
        self.assertIn(files["data/rates.json"], files["index.html"])
        self.assertEqual(gh.issues, [])

    def test_already_checked_today_does_not_commit(self):
        rates = load_rates()
        today = datetime.date.fromisoformat(rates["lastChecked"])
        gh, result = self.run_check(rates, today, pages_for(2026, fixture("federal_2026.html"),
                                                            fixture("irmaa_2026.html"), fixture("states_2026.html")))
        self.assertEqual(result["status"], "unchanged")
        self.assertEqual(gh.commits, [])

    def test_new_year_updates_federal_and_carries_statutory_items(self):
        rates = load_rates()
        gh, result = self.run_check(rates, datetime.date(2027, 1, 5), pages_for(2027, fixture("federal_2027.html")))
        self.assertEqual(result["status"], "updated", result)
        new = json.loads(gh.commits[0][2]["data/rates.json"])
        self.assertEqual(new["taxYear"], 2027)
        self.assertEqual(new["lastUpdated"], "2027-01-05")
        self.assertEqual(new["items"]["federalBrackets"]["effectiveYear"], 2027)
        self.assertEqual(new["items"]["niit"]["effectiveYear"], 2027)
        self.assertEqual(new["items"]["medicareIrmaa"]["effectiveYear"], 2026)   # pending, allowed until April
        self.assertEqual(new["items"]["stateIncomeTax"]["effectiveYear"], 2026)
        self.assertEqual(validate_rates(new), [])
        self.assertTrue(any("not published yet" in n for n in result["notes"]))

    def test_pending_source_after_march_opens_issue(self):
        rates = load_rates()
        gh, result = self.run_check(rates, datetime.date(2027, 5, 3), pages_for(2027, fixture("federal_2027.html")))
        self.assertEqual(result["status"], "problems")
        self.assertEqual(gh.commits, [])
        self.assertEqual(len(gh.issues), 1)
        self.assertIn("still not published", gh.issues[0][2])

    def test_big_jump_opens_issue_instead_of_committing(self):
        rates = load_rates()
        page = fixture("federal_2027.html").replace("$16,500", "$25,000")
        gh, result = self.run_check(rates, datetime.date(2027, 1, 5), pages_for(2027, page))
        self.assertEqual(result["status"], "problems")
        self.assertTrue(any("standardDeduction" in p and "15%" in p for p in result["problems"]), result["problems"])
        self.assertEqual(gh.commits, [])
        self.assertEqual(result["rates"], rates)

    def test_changed_page_layout_opens_issue(self):
        rates = load_rates()
        gh, result = self.run_check(rates, datetime.date(2026, 11, 2),
                                    pages_for(2026, "<html>2026 redesigned page</html>",
                                              fixture("irmaa_2026.html"), fixture("states_2026.html")))
        self.assertEqual(result["status"], "problems")
        self.assertTrue(any("could not be read" in p for p in result["problems"]))

    def test_same_year_discrepancy_is_flagged_but_overrides_are_respected(self):
        rates = load_rates()
        states = rates["items"]["stateIncomeTax"]["value"]["states"]
        ga = next(s for s in states if s["abbr"] == "GA")
        self.assertTrue(ga.get("override"))
        page = fixture("states_2026.html").replace("4.99%", "5.09%")   # older published GA rate
        gh, result = self.run_check(rates, datetime.date(2026, 10, 28),
                                    pages_for(2026, fixture("federal_2026.html"), fixture("irmaa_2026.html"), page))
        self.assertEqual(result["status"], "checked", result.get("problems"))
        page = fixture("states_2026.html").replace("4.95%", "4.85%")   # IL has no override
        gh, result = self.run_check(rates, datetime.date(2026, 10, 28),
                                    pages_for(2026, fixture("federal_2026.html"), fixture("irmaa_2026.html"), page))
        self.assertEqual(result["status"], "problems")
        self.assertTrue(any("IL: page says 4.85%" in p for p in result["problems"]))

    def test_network_error_is_reported(self):
        rates = load_rates()
        pages = pages_for(2026, fixture("federal_2026.html"), TimeoutError("timed out"), fixture("states_2026.html"))
        gh, result = self.run_check(rates, datetime.date(2026, 10, 28), pages)
        self.assertEqual(result["status"], "problems")
        self.assertTrue(any("Medicare IRMAA: could not fetch" in p for p in result["problems"]))

    def test_invalid_current_data_opens_issue(self):
        rates = load_rates()
        rates["items"].pop("rmd")
        gh = FakeGitHub(rates, self.index)
        result = updater.run_check(gh, datetime.date(2026, 10, 28), fetch=fake_fetch({}))
        self.assertEqual(result["status"], "problems")
        self.assertEqual(len(gh.issues), 1)

    def test_time_budget_is_respected(self):
        rates = load_rates()
        cand, problems, notes = updater.build_candidate(rates, datetime.date(2026, 10, 28),
                                                        fake_fetch({}), time.monotonic() - 1)
        self.assertEqual(len(problems), 3)
        self.assertTrue(all("ran out of time" in p for p in problems))


class HttpEntryPoint(unittest.TestCase):
    """main.py needs functions-framework; skip when it isn't installed."""

    def setUp(self):
        try:
            import functions_framework  # noqa: F401
        except ImportError:
            self.skipTest("functions-framework not installed")
        import importlib
        import main
        self.main = importlib.reload(main)
        os.environ["CHECK_SECRET"] = "s3cret"
        os.environ["ALLOWED_ORIGIN"] = "https://example.github.io"

    def request(self, method="POST", headers=None):
        from flask import Flask
        app = Flask(__name__)
        with app.test_request_context("/", method=method, headers=headers or {}):
            from flask import request
            return self.main.check_tax_data(request)

    def test_preflight_and_auth(self):
        body, status, headers = self.request("OPTIONS", {"Origin": "https://example.github.io"})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "https://example.github.io")
        _, status, headers = self.request("OPTIONS", {"Origin": "https://evil.example"})
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(self.request("GET")[1], 405)
        self.assertEqual(self.request("POST", {"X-Check-Secret": "nope"})[1], 401)
        self.assertEqual(self.request("POST")[1], 401)

    def test_authorized_call_runs_check_once_per_cooldown(self):
        calls = []
        self.main.run_check = lambda gh, today: calls.append(today) or {"status": "checked", "message": "ok", "rates": {}}
        self.main.GitHub = lambda token, repo: object()
        body, status, _ = self.request("POST", {"X-Check-Secret": "s3cret"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["status"], "checked")
        body, status, _ = self.request("POST", {"X-Check-Secret": "s3cret"})
        self.assertIn("(cached)", json.loads(body)["message"])
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()

"""Validation for rates documents.

validate_rates() mirrors validateRates() in js/tax-engine.js (schema,
all fields present, brackets ascending, sane ranges). compare_to_prior()
adds the fetcher-only rule that numbers may not move more than 15% from
the previous figures without a human looking at them.
"""
import math
import re

FILING_STATUSES = ("single", "marriedFilingJointly", "marriedFilingSeparately")
REQUIRED_ITEMS = (
    "federalBrackets", "standardDeduction", "additionalStandardDeduction65",
    "seniorBonusDeduction", "capitalGainsBrackets", "niit",
    "socialSecurityTaxation", "socialSecurityClaiming", "medicareIrmaa",
    "rmd", "penalties", "stateIncomeTax",
)
SCHEMA_VERSION = 2
MAX_CHANGE = 0.15
_UNSAFE = re.compile(r"[<>`\x00-\x1f]")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _check_strings(value, path, err):
    if isinstance(value, str):
        if _UNSAFE.search(value):
            err(f"{path}: contains unsafe characters")
        if len(value) > 300:
            err(f"{path}: string too long")
    elif isinstance(value, list):
        for i, v in enumerate(value):
            _check_strings(v, f"{path}[{i}]", err)
    elif isinstance(value, dict):
        for k, v in value.items():
            if _UNSAFE.search(k) or k in ("__proto__", "constructor", "prototype"):
                err(f"{path}: unsafe key {k!r}")
            _check_strings(v, f"{path}.{k}", err)


def _brackets(value, err, allow_zero=False):
    if not isinstance(value, dict):
        return err("must be an object keyed by filing status")
    for fs in FILING_STATUSES:
        rows = value.get(fs)
        if not isinstance(rows, list) or len(rows) < 2:
            err(f"{fs}: needs at least 2 brackets")
            continue
        prev_rate, prev_upper = -1, 0
        for i, row in enumerate(rows):
            last = i == len(rows) - 1
            if not isinstance(row, list) or len(row) != 2:
                err(f"{fs}[{i}]: must be [rate, upperBound]")
                continue
            rate, upper = row
            if not _num(rate) or rate < 0 or rate >= 1 or (not allow_zero and rate == 0):
                err(f"{fs}[{i}]: rate {rate} out of range")
            elif rate <= prev_rate:
                err(f"{fs}[{i}]: rates must be ascending")
            if last:
                if upper is not None:
                    err(f"{fs}: last bracket upper bound must be null (no limit)")
            elif not _num(upper) or upper <= prev_upper:
                err(f"{fs}[{i}]: upper bound {upper} must be a number above {prev_upper} (brackets ascending)")
            if _num(rate):
                prev_rate = rate
            if _num(upper):
                prev_upper = upper


def _positive(obj, keys, err, maximum=1e7):
    if not isinstance(obj, dict):
        return err("must be an object")
    for k in keys:
        v = obj.get(k)
        if not _num(v) or v <= 0 or v > maximum:
            err(f"{k}: {v} must be a positive number")


def _v_senior(v, err):
    if not isinstance(v, dict):
        return err("must be an object")
    _positive(v, ("amountPerPerson", "phaseoutRate"), err, 1e6)
    if _num(v.get("phaseoutRate")) and v["phaseoutRate"] >= 1:
        err("phaseoutRate must be < 1")
    _positive(v.get("phaseoutStart"), ("single", "marriedFilingJointly"), lambda m: err(f"phaseoutStart.{m}"))
    if not _int(v.get("firstYear")) or not _int(v.get("lastYear")) or v["firstYear"] > v["lastYear"]:
        err("firstYear/lastYear invalid")


def _v_niit(v, err):
    if not isinstance(v, dict):
        return err("must be an object")
    if not _num(v.get("rate")) or not 0 < v["rate"] < 0.2:
        err("rate out of range")
    _positive(v.get("thresholds"), FILING_STATUSES, lambda m: err(f"thresholds.{m}"))


def _v_ss_tax(v, err):
    if not isinstance(v, dict):
        return err("must be an object")
    for fs in FILING_STATUSES:
        t = v.get(fs)
        if not isinstance(t, dict) or not _num(t.get("baseAmount")) or not _num(t.get("additionalAmount")) \
                or t["baseAmount"] < 0 or t["additionalAmount"] < t["baseAmount"]:
            err(f"{fs}: needs 0 <= baseAmount <= additionalAmount")
    for k in ("tier1Rate", "tier2Rate"):
        if not _num(v.get(k)) or not 0 < v[k] <= 1:
            err(f"{k} out of range")


def _ascending_table(rows, key, value_check, name, err):
    if not isinstance(rows, list) or not rows:
        return err(f"{name} missing")
    prev = -math.inf
    for i, row in enumerate(rows):
        last = i == len(rows) - 1
        if not isinstance(row, dict) or not value_check(row):
            err(f"{name}[{i}] invalid")
            continue
        b = row.get(key)
        if (b is not None) if last else (not _int(b) or b <= prev):
            err(f"{name}[{i}].{key} must ascend and end with null")
        if _int(b):
            prev = b


def _v_ss_claim(v, err):
    if not isinstance(v, dict):
        return err("must be an object")
    _ascending_table(v.get("fullRetirementAge"), "bornThrough",
                     lambda r: _int(r.get("years")) and _int(r.get("months")) and 0 <= r["months"] <= 11,
                     "fullRetirementAge", err)
    for k in ("earlyReductionFirst36Months", "earlyReductionPerYearBeyond36", "delayedCreditPerYear"):
        if not _num(v.get(k)) or not 0 < v[k] < 1:
            err(f"{k} out of range")
    if not _int(v.get("earliestClaimAge")) or not _int(v.get("maxCreditAge")) or v["earliestClaimAge"] >= v["maxCreditAge"]:
        err("claim ages invalid")


def _v_irmaa(v, err):
    if not isinstance(v, dict):
        return err("must be an object")
    std = v.get("partBStandardPremium")
    if not _num(std) or not 0 < std <= 2000:
        err("partBStandardPremium invalid")
        std = 0
    if not _int(v.get("lookbackYears")) or not 1 <= v["lookbackYears"] <= 3:
        err("lookbackYears invalid")
    tiers = v.get("tiers")
    if not isinstance(tiers, dict):
        return err("tiers missing")
    for fs in FILING_STATUSES:
        rows = tiers.get(fs)
        if not isinstance(rows, list) or not rows:
            err(f"tiers.{fs} missing")
            continue
        prev = {"magiOver": 0, "partBTotal": std, "partD": -1}
        for i, t in enumerate(rows):
            if not isinstance(t, dict) or not all(_num(t.get(k)) for k in ("magiOver", "partBTotal", "partD")):
                err(f"tiers.{fs}[{i}] invalid")
                continue
            if t["magiOver"] <= prev["magiOver"]:
                err(f"tiers.{fs}[{i}]: MAGI thresholds must be ascending")
            if t["partBTotal"] <= prev["partBTotal"]:
                err(f"tiers.{fs}[{i}]: Part B premiums must be ascending and above the standard premium")
            if t["partD"] <= prev["partD"]:
                err(f"tiers.{fs}[{i}]: Part D amounts must be ascending")
            prev = t


def _v_rmd(v, err):
    if not isinstance(v, dict):
        return err("must be an object")
    _ascending_table(v.get("startAgeByBirthYear"), "bornThrough",
                     lambda r: _int(r.get("age")) and 70 <= r["age"] <= 80, "startAgeByBirthYear", err)
    ult = v.get("uniformLifetimeTable")
    if not isinstance(ult, dict):
        err("uniformLifetimeTable missing")
    else:
        prev = math.inf
        for age in range(72, 121):
            d = ult.get(str(age))
            if not _num(d) or d <= 0:
                err(f"uniformLifetimeTable.{age} missing")
                continue
            if d > prev:
                err(f"uniformLifetimeTable.{age}: divisors must not increase with age")
            prev = d
    jlt = v.get("jointLifeTable")
    if jlt is not None:
        if not isinstance(jlt, dict) or not _int(jlt.get("minBeneficiaryAge")) or not isinstance(jlt.get("rows"), dict):
            err("jointLifeTable invalid")
        else:
            for owner, row in jlt["rows"].items():
                if not owner.isdigit() or not isinstance(row, list) or not row:
                    err(f"jointLifeTable.rows.{owner} invalid")
                    continue
                prev = math.inf
                for i, d in enumerate(row):
                    if not _num(d) or d <= 0:
                        err(f"jointLifeTable.rows.{owner}[{i}] invalid")
                    elif d > prev:
                        err(f"jointLifeTable.rows.{owner}: divisors must not increase with beneficiary age")
                    else:
                        prev = d


def _v_penalties(v, err):
    if not isinstance(v, dict):
        return err("must be an object")
    for k in ("earlyDistributionRate", "hsaNonMedicalRate"):
        if not _num(v.get(k)) or not 0 < v[k] < 1:
            err(f"{k} out of range")
    for k in ("earlyDistributionAge", "hsaPenaltyFreeAge"):
        if not _num(v.get(k)) or not 50 <= v[k] <= 75:
            err(f"{k} out of range")
    if not _int(v.get("rothConversionSeasoningYears")) or v["rothConversionSeasoningYears"] < 1:
        err("rothConversionSeasoningYears invalid")


_NAME = re.compile(r"^[A-Za-z .'-]+$")


def _v_states(v, err):
    if not isinstance(v, dict) or not isinstance(v.get("states"), list):
        return err("states array missing")
    states = v["states"]
    if len(states) < 51:
        err(f"expected 51 states (incl. DC), got {len(states)}")
    seen = set()
    for i, s in enumerate(states):
        if not isinstance(s, dict) or not isinstance(s.get("abbr"), str) or not re.match(r"^[A-Z]{2}$", s["abbr"]):
            err(f"states[{i}].abbr invalid")
            continue
        ab = s["abbr"]
        if ab in seen:
            err(f"duplicate state {ab}")
        seen.add(ab)
        if not isinstance(s.get("name"), str) or not _NAME.match(s["name"]):
            err(f"{ab}: name invalid")
        if not _num(s.get("rate")) or not 0 <= s["rate"] <= 20:
            err(f"{ab}: rate {s.get('rate')} out of range")
        if not isinstance(s.get("taxesSocialSecurity"), bool):
            err(f"{ab}: taxesSocialSecurity must be true/false")
        br = s.get("brackets")
        if not isinstance(br, dict):
            err(f"{ab}: brackets missing")
            continue
        for fs in ("single", "marriedFilingJointly"):
            rows = br.get(fs)
            if not isinstance(rows, list) or not rows:
                err(f"{ab}.brackets.{fs} missing")
                continue
            prev_rate, prev_upper = -1, 0
            ok = True
            for j, row in enumerate(rows):
                last = j == len(rows) - 1
                if not isinstance(row, list) or len(row) != 2 or not _num(row[0]) or not 0 <= row[0] < 0.25:
                    err(f"{ab}.brackets.{fs}[{j}] invalid")
                    ok = False
                    continue
                if row[0] <= prev_rate:
                    err(f"{ab}.brackets.{fs}[{j}]: rates must be ascending")
                if (row[1] is not None) if last else (not _num(row[1]) or row[1] <= prev_upper):
                    err(f"{ab}.brackets.{fs}[{j}]: upper bounds must ascend and end with null")
                prev_rate = row[0]
                if _num(row[1]):
                    prev_upper = row[1]
            if ok and _num(s.get("rate")) and abs(rows[-1][0] * 100 - s["rate"]) > 0.0005:
                err(f"{ab}.brackets.{fs}: top rate {rows[-1][0] * 100}% does not match rate {s['rate']}%")


ITEM_VALIDATORS = {
    "federalBrackets": lambda v, e: _brackets(v, e),
    "capitalGainsBrackets": lambda v, e: _brackets(v, e, allow_zero=True),
    "standardDeduction": lambda v, e: _positive(v, FILING_STATUSES, e, 1e6),
    "additionalStandardDeduction65": lambda v, e: _positive(v, ("unmarried", "married"), e, 1e5),
    "seniorBonusDeduction": _v_senior,
    "niit": _v_niit,
    "socialSecurityTaxation": _v_ss_tax,
    "socialSecurityClaiming": _v_ss_claim,
    "medicareIrmaa": _v_irmaa,
    "rmd": _v_rmd,
    "penalties": _v_penalties,
    "stateIncomeTax": _v_states,
}


def validate_rates(rates):
    """Return a list of problems (empty when the document is valid)."""
    errs = []
    err = errs.append
    if not isinstance(rates, dict):
        return ["rates document must be a JSON object"]
    if rates.get("schemaVersion") != SCHEMA_VERSION:
        err(f"schemaVersion must be {SCHEMA_VERSION}")
    year = rates.get("taxYear")
    if not _int(year) or not 2024 <= year <= 2100:
        err("taxYear invalid")
        year = None
    for k in ("lastChecked", "lastUpdated"):
        if not isinstance(rates.get(k), str) or not _DATE.match(rates[k]):
            err(f"{k} must be a YYYY-MM-DD date")
    _check_strings(rates, "rates", err)
    items = rates.get("items")
    if not isinstance(items, dict):
        err("items missing")
        return errs
    for key in REQUIRED_ITEMS:
        it = items.get(key)

        def e(m, key=key):
            err(f"items.{key}: {m}")
        if not isinstance(it, dict):
            e("missing")
            continue
        if not isinstance(it.get("label"), str) or not it["label"]:
            e("label missing")
        if not isinstance(it.get("sourceName"), str) or not it["sourceName"]:
            e("sourceName missing")
        if not isinstance(it.get("source"), str) or not re.match(r"^https://\S+$", it["source"]):
            e("source must be an https URL")
        ey = it.get("effectiveYear")
        if year is not None and (not _int(ey) or ey > year or ey < year - 1):
            e(f"effectiveYear {ey} must be {year} or {year - 1}")
        if not isinstance(it.get("indexed"), bool):
            e("indexed must be true/false")
        if "value" not in it:
            e("value missing")
        else:
            ITEM_VALIDATORS[key](it["value"], e)
    return errs


def _leaves(value, path=""):
    """Yield (path, number) for every numeric leaf."""
    if isinstance(value, dict):
        for k, v in value.items():
            yield from _leaves(v, f"{path}.{k}" if path else k)
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from _leaves(v, f"{path}[{i}]")
    elif _num(value):
        yield path, value


def compare_to_prior(key, prior_value, new_value, max_change=MAX_CHANGE):
    """Return problems where a figure moved more than max_change vs. before.

    State data is compared on each state's top rate only (bracket layouts
    legitimately change). Other items must keep the same shape.
    """
    problems = []
    if key == "stateIncomeTax":
        before = {s["abbr"]: s["rate"] for s in prior_value.get("states", [])}
        for s in new_value.get("states", []):
            old = before.get(s["abbr"])
            if old is None:
                problems.append(f"{key}: new state {s['abbr']}")
            elif _moved(old, s["rate"], max_change):
                problems.append(f"{key}: {s['abbr']} top rate {old}% -> {s['rate']}% (more than {int(max_change * 100)}%)")
        return problems
    old = dict(_leaves(prior_value))
    new = dict(_leaves(new_value))
    if set(old) != set(new):
        missing = sorted(set(old) - set(new))
        added = sorted(set(new) - set(old))
        problems.append(f"{key}: structure changed (missing {missing[:5]}, new {added[:5]})")
    for path in sorted(set(old) & set(new)):
        if _moved(old[path], new[path], max_change):
            problems.append(f"{key}: {path} {old[path]} -> {new[path]} (more than {int(max_change * 100)}%)")
    return problems


def _moved(old, new, max_change):
    if old == 0:
        return new != 0
    return abs(new - old) / abs(old) > max_change + 1e-12


def differs(prior_value, new_value, tolerance=1e-6):
    """True when any numeric leaf or the shape differs."""
    old = dict(_leaves(prior_value))
    new = dict(_leaves(new_value))
    if set(old) != set(new):
        return True
    return any(abs(old[p] - new[p]) > tolerance for p in old)

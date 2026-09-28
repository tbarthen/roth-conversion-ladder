"""Fetch and parse official tax figures.

Each parser takes page HTML plus the target tax year and returns the
`value` for one or more rates.json items, or raises ParseError. Parsers
are deliberately strict: anything unexpected is an error, which makes the
fetcher open a GitHub issue instead of committing questionable numbers.

Sources (all public HTML pages):
  * Federal brackets, standard deduction, 65+ deduction, capital gains:
    Tax Foundation's annual "<year> Tax Brackets" page (summarizes the IRS
    Rev. Proc.; married-filing-separately figures are derived from the
    statutory relationship to the single/joint figures).
  * Medicare IRMAA: CMS "<year> Medicare Parts A & B Premiums and
    Deductibles" fact sheet.
  * State income tax: Tax Foundation's "State Individual Income Tax Rates
    and Brackets, <year>" table.
Statutory items (NIIT, Social Security taxation and claiming rules, RMD
tables, penalties, the 2025-2028 senior deduction) are not re-fetched;
they only change by legislation.
"""
from html.parser import HTMLParser
import re
import urllib.error
import urllib.request

USER_AGENT = ("Mozilla/5.0 (compatible; roth-ladder-tax-fetcher/1.0; "
              "+https://github.com/tbarthen/roth-conversion-ladder)")


class ParseError(Exception):
    """The page was found but did not contain what we expected."""


class NotPublished(Exception):
    """The page for this tax year does not exist (yet)."""


def federal_urls(year):
    return [f"https://taxfoundation.org/data/all/federal/{year}-tax-brackets/"]


def irmaa_urls(year):
    return [
        f"https://www.cms.gov/newsroom/fact-sheets/{year}-medicare-parts-b-premiums-and-deductibles",
        f"https://www.cms.gov/newsroom/fact-sheets/{year}-medicare-parts-b-premiums-deductibles",
    ]


def state_urls(year):
    return [f"https://taxfoundation.org/data/all/state/state-income-tax-rates-{year}/"]


def fetch_first(urls, timeout):
    """GET the first URL that exists. Returns (url, html).

    Raises NotPublished if every URL is a 404/410, or the underlying error.
    """
    last_error = None
    for url in urls:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return url, resp.read(3_000_000).decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code in (404, 410):
                last_error = NotPublished(f"{url} returned {e.code}")
                continue
            raise
    raise last_error or NotPublished("no URL")


# ---------------------------------------------------------------- HTML tables
class _TableParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = []      # list of tables; table = list of rows; row = list of cell text
        self._stack = []
        self._row = None
        self._cell = None
        self._span = 1
        self.text = []

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._stack.append([])
        elif tag == "tr" and self._stack:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []
            try:
                self._span = max(1, min(20, int(dict(attrs).get("colspan") or 1)))
            except ValueError:
                self._span = 1
        elif tag == "br" and self._cell is not None:
            self._cell.append(" ")

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None and self._row is not None:
            text = " ".join("".join(self._cell).split())
            self._row.extend([text] * self._span)   # expand colspan so columns line up
            self._cell = None
        elif tag == "tr" and self._row is not None and self._stack:
            if self._row:
                self._stack[-1].append(self._row)
            self._row = None
        elif tag == "table" and self._stack:
            self.tables.append(self._stack.pop())

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)
        self.text.append(data)


def parse_tables(html):
    p = _TableParser()
    p.feed(html)
    return p.tables, " ".join(" ".join(p.text).split())


_MONEY = re.compile(r"\$\s*([\d,]+(?:\.\d+)?)")
_PCT = re.compile(r"(\d+(?:\.\d+)?)\s*%")


def money(text):
    return [float(m.replace(",", "")) for m in _MONEY.findall(text)]


def _int_or_float(x):
    return int(x) if float(x).is_integer() else x


def _require_year(text, year):
    if str(year) not in text:
        raise ParseError(f"page does not mention {year}")


# ------------------------------------------------------- federal (Tax Foundation)
def _column_roles(header):
    roles = []
    for cell in header:
        c = cell.lower()
        if "single" in c or "unmarried" in c:
            roles.append("single")
        elif "joint" in c:
            roles.append("marriedFilingJointly")
        elif "head" in c:
            roles.append("hoh")
        else:
            roles.append(None)
    return roles


def _bracket_table(tables, expected_rates):
    """Find a table whose rows start with the expected percentages and
    return {role: [[rate, upper|None], ...]} for single and joint."""
    for table in tables:
        rate_rows = [r for r in table if r and _PCT.fullmatch(r[0].strip())]
        rates = [float(_PCT.fullmatch(r[0].strip()).group(1)) for r in rate_rows]
        if rates != expected_rates:
            continue
        header = next((r for r in table if r not in rate_rows), None)
        if not header:
            continue
        roles = _column_roles(header)
        out = {}
        for col, role in enumerate(roles):
            if role not in ("single", "marriedFilingJointly"):
                continue
            cells = [r[col] if col < len(r) else "" for r in rate_rows]
            nums = [money(c) for c in cells]
            if any(not n for n in nums):
                raise ParseError(f"bracket table column '{header[col]}' has blank cells")
            ranged = any(len(n) >= 2 for n in nums)
            rows = []
            for i, rate in enumerate(rates):
                if ranged:   # "$0 to $12,400" ... "$640,600 or more"
                    upper = nums[i][1] if len(nums[i]) >= 2 else None
                else:        # lower bounds only: "$0", "$49,450", ...
                    upper = nums[i + 1][0] if i + 1 < len(nums) else None
                rows.append([_int_or_float(round(rate / 100, 4)), _int_or_float(upper) if upper is not None else None])
            if rows[-1][1] is not None:
                raise ParseError("top bracket has an upper bound")
            out[role] = rows
        if "single" in out and "marriedFilingJointly" in out:
            return out
    raise ParseError(f"no bracket table with rates {expected_rates}")


def parse_federal(html, year):
    """Return values for federalBrackets, standardDeduction,
    additionalStandardDeduction65 and capitalGainsBrackets."""
    tables, text = parse_tables(html)
    _require_year(text, year)
    ordinary = _bracket_table(tables, [10.0, 12.0, 22.0, 24.0, 32.0, 35.0, 37.0])
    cg = _bracket_table(tables, [0.0, 15.0, 20.0])

    # Married filing separately: same as single except the 35% bracket,
    # which (like the 15% capital-gains bracket) ends at half the joint figure.
    mfs = [list(r) for r in ordinary["single"]]
    mfs[5][1] = _int_or_float(ordinary["marriedFilingJointly"][5][1] / 2)
    cg_mfs = [list(r) for r in cg["single"]]
    cg_mfs[1][1] = _int_or_float(cg["marriedFilingJointly"][1][1] / 2)

    std = {}
    for table in tables:
        for row in table:
            if len(row) < 2:
                continue
            label, amounts = row[0].lower(), money(" ".join(row[1:]))
            if len(amounts) != 1:
                continue
            if label.startswith("single") and "single" not in std:
                std["single"] = amounts[0]
            elif "jointly" in label and "marriedFilingJointly" not in std:
                std["marriedFilingJointly"] = amounts[0]
    if set(std) != {"single", "marriedFilingJointly"}:
        raise ParseError("standard deduction table not found")
    standard = {
        "single": _int_or_float(std["single"]),
        "marriedFilingJointly": _int_or_float(std["marriedFilingJointly"]),
        "marriedFilingSeparately": _int_or_float(std["single"]),
    }

    add = _additional_65(text)
    return {
        "federalBrackets": {"single": ordinary["single"], "marriedFilingJointly": ordinary["marriedFilingJointly"],
                            "marriedFilingSeparately": mfs},
        "capitalGainsBrackets": {"single": cg["single"], "marriedFilingJointly": cg["marriedFilingJointly"],
                                 "marriedFilingSeparately": cg_mfs},
        "standardDeduction": standard,
        "additionalStandardDeduction65": add,
    }


def _additional_65(text):
    m = re.search(r"additional standard deduction(.{0,400})", text, re.I)
    if not m:
        raise ParseError("additional standard deduction (65+) not found")
    window = m.group(1)
    found = {}
    for am in _MONEY.finditer(window):
        after = window[am.end():am.end() + 60].lower()
        value = float(am.group(1).replace(",", ""))
        kw = re.search(r"\b(single|unmarried|married|joint)", after)   # nearest keyword wins
        if not kw:
            continue
        role = "unmarried" if kw.group(1) in ("single", "unmarried") else "married"
        found.setdefault(role, value)
    if set(found) != {"unmarried", "married"}:
        raise ParseError("could not tell the single and married 65+ amounts apart")
    if not found["unmarried"] > found["married"]:
        raise ParseError("65+ amounts look swapped")
    return {"unmarried": _int_or_float(found["unmarried"]), "married": _int_or_float(found["married"])}


# ---------------------------------------------------------------- IRMAA (CMS)
_THRESH = re.compile(r"^(less than or equal to|greater than)", re.I)


def _threshold_over(cell):
    """MAGI above which the tier applies ('greater than or equal to X' -> X - 1)."""
    c = cell.lower()
    nums = money(cell)
    if c.startswith("less than or equal"):
        return None
    if not nums:
        raise ParseError(f"no amount in '{cell}'")
    if c.startswith("greater than or equal"):
        return nums[0] - 1
    return nums[0]


def parse_irmaa(html, year):
    """Return the medicareIrmaa value."""
    tables, text = parse_tables(html)
    _require_year(text, year)
    part_b, part_d = {}, {}
    standard = None
    for table in tables:
        rows = [r for r in table if r and _THRESH.match(r[0])]
        if len(rows) < 2:
            continue
        n_thresh = sum(1 for c in rows[0] if _THRESH.match(c))
        n_money = len(rows[0]) - n_thresh
        if n_thresh not in (1, 2) or n_money not in (1, 2):
            raise ParseError(f"unexpected IRMAA table layout: {rows[0]}")
        statuses = ["single", "marriedFilingJointly"] if n_thresh == 2 else ["marriedFilingSeparately"]
        target = part_b if n_money == 2 else part_d
        for col, fs in enumerate(statuses):
            tiers = []
            for r in rows:
                over = _threshold_over(r[col])
                amounts = [money(c) for c in r[n_thresh:]]
                if any(len(a) != 1 for a in amounts):
                    raise ParseError(f"bad premium cells {r}")
                if over is None:
                    if n_money == 2:
                        standard = amounts[1][0]
                    continue
                tiers.append((over, [a[0] for a in amounts]))
            if fs in target:
                raise ParseError(f"duplicate IRMAA table for {fs}")
            target[fs] = tiers
    need = {"single", "marriedFilingJointly", "marriedFilingSeparately"}
    if set(part_b) != need or set(part_d) != need or standard is None:
        raise ParseError("Part B / Part D IRMAA tables not all found")
    out = {}
    for fs in sorted(need, key=["single", "marriedFilingJointly", "marriedFilingSeparately"].index):
        b, d = part_b[fs], part_d[fs]
        if [t[0] for t in b] != [t[0] for t in d]:
            raise ParseError(f"Part B and Part D thresholds differ for {fs}")
        out[fs] = [{"magiOver": _int_or_float(o), "partBTotal": _int_or_float(round(amts[1], 2)),
                    "partD": _int_or_float(round(dd[1][0], 2))}
                   for (o, amts), dd in zip(b, d)]
    return {"partBStandardPremium": _int_or_float(round(standard, 2)), "lookbackYears": 2, "tiers": out}


# ------------------------------------------------------- states (Tax Foundation)
STATE_NAMES = {
    "AL": ("alabama", "ala."), "AK": ("alaska",), "AZ": ("arizona", "ariz."), "AR": ("arkansas", "ark."),
    "CA": ("california", "calif."), "CO": ("colorado", "colo."), "CT": ("connecticut", "conn."),
    "DE": ("delaware", "del."), "DC": ("district of columbia", "d.c."), "FL": ("florida", "fla."),
    "GA": ("georgia", "ga."), "HI": ("hawaii",), "ID": ("idaho",), "IL": ("illinois", "ill."),
    "IN": ("indiana", "ind."), "IA": ("iowa",), "KS": ("kansas", "kans.", "kan."), "KY": ("kentucky", "ky."),
    "LA": ("louisiana", "la."), "ME": ("maine",), "MD": ("maryland", "md."), "MA": ("massachusetts", "mass."),
    "MI": ("michigan", "mich."), "MN": ("minnesota", "minn."), "MS": ("mississippi", "miss."),
    "MO": ("missouri", "mo."), "MT": ("montana", "mont."), "NE": ("nebraska", "nebr.", "neb."),
    "NV": ("nevada", "nev."), "NH": ("new hampshire", "n.h."), "NJ": ("new jersey", "n.j."),
    "NM": ("new mexico", "n.m.", "n.mex."), "NY": ("new york", "n.y."), "NC": ("north carolina", "n.c."),
    "ND": ("north dakota", "n.d.", "n.dak."), "OH": ("ohio",), "OK": ("oklahoma", "okla."),
    "OR": ("oregon", "ore.", "oreg."), "PA": ("pennsylvania", "pa."), "RI": ("rhode island", "r.i."),
    "SC": ("south carolina", "s.c."), "SD": ("south dakota", "s.d.", "s.dak."), "TN": ("tennessee", "tenn."),
    "TX": ("texas", "tex."), "UT": ("utah",), "VT": ("vermont", "vt."), "VA": ("virginia", "va."),
    "WA": ("washington", "wash."), "WV": ("west virginia", "w.va.", "w. va."), "WI": ("wisconsin", "wis."),
    "WY": ("wyoming", "wyo."),
}
_LOOKUP = {alias: abbr for abbr, names in STATE_NAMES.items() for alias in names}


def _state_from_cell(cell):
    name = re.sub(r"\(.*?\)|\*|\d", "", cell).strip().lower()
    name = " ".join(name.split())
    return _LOOKUP.get(name)


def _rate_bound_pairs(cells):
    """Split a row's cells into (rate%, lower bound) pairs in order."""
    pairs, rate = [], None
    for c in cells:
        t = c.strip().lower()
        if t in ("none", "n.a.", "n/a"):
            pairs.append((0.0, 0.0))
            continue
        pm = _PCT.fullmatch(t)
        if pm:
            rate = float(pm.group(1))
            continue
        mm = money(c)
        if rate is not None and mm:
            pairs.append((rate, mm[0]))
            rate = None
    return pairs


def _to_brackets(pairs):
    """[(rate%, lower)] -> [[rate, upper|None]], merging equal adjacent rates."""
    pairs = sorted(pairs, key=lambda p: p[1])
    merged = []
    for rate, lower in pairs:
        if merged and abs(merged[-1][0] - rate) < 1e-9:
            continue
        merged.append((rate, lower))
    out = []
    for i, (rate, lower) in enumerate(merged):
        upper = merged[i + 1][1] if i + 1 < len(merged) else None
        out.append([_int_or_float(round(rate / 100, 8)), _int_or_float(upper) if upper is not None else None])
    if merged and merged[0][1] > 0:
        out.insert(0, [0, _int_or_float(merged[0][1])])
    return out


def parse_states(html, year):
    """Return {abbr: {"rate": top%, "brackets": {single, marriedFilingJointly}}}."""
    tables, text = parse_tables(html)
    _require_year(text, year)
    best = {}
    for table in tables:
        found, current = {}, None
        header = next((r for r in table if any("single" in c.lower() for c in r)
                       and any(("married" in c.lower() or "joint" in c.lower()) for c in r)), None)
        single_cols = [i for i, c in enumerate(header or []) if "single" in c.lower()]
        joint_cols = [i for i, c in enumerate(header or []) if "married" in c.lower() or "joint" in c.lower()]
        for row in table:
            if not row or row is header:
                continue
            abbr = _state_from_cell(row[0]) if row[0].strip() else None
            if abbr:
                current = abbr
                found[current] = {"single": [], "joint": []}
            elif row[0].strip():
                current = None   # footnote / header row
                continue
            if current is None:
                continue
            if single_cols and joint_cols:
                s_pairs = _rate_bound_pairs([row[i] for i in single_cols if i < len(row)])
                j_pairs = _rate_bound_pairs([row[i] for i in joint_cols if i < len(row)])
                found[current]["single"].extend(s_pairs[:1])
                found[current]["joint"].extend(j_pairs[:1])
            else:
                pairs = _rate_bound_pairs(row[1:])
                if len(pairs) >= 1:
                    found[current]["single"].append(pairs[0])
                if len(pairs) >= 2:
                    found[current]["joint"].append(pairs[1])
        if len(found) > len(best):
            best = found
    if len(best) < 51:
        raise ParseError(f"state table has {len(best)} states, expected 51")
    out = {}
    for abbr, d in best.items():
        if not d["single"]:
            raise ParseError(f"{abbr}: no rates found")
        single = _to_brackets(d["single"])
        joint = _to_brackets(d["joint"] or d["single"])
        top = single[-1][0] * 100
        if abs(joint[-1][0] * 100 - top) > 1e-6:
            raise ParseError(f"{abbr}: single and joint top rates differ")
        out[abbr] = {"rate": _int_or_float(round(top, 4)), "brackets": {"single": single, "marriedFilingJointly": joint}}
    return out

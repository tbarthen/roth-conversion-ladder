"""Canonical JSON formatting for data/rates.json.

Mirrors formatRatesJson() in js/tax-engine.js exactly so the Node sync
script and this fetcher write byte-identical files.
"""
import json
import math

FORMAT_WIDTH = 100


def _scalar(v):
    if isinstance(v, bool) or v is None:
        return json.dumps(v)
    if isinstance(v, (int, float)):
        if isinstance(v, float):
            if not math.isfinite(v):
                raise ValueError("non-finite number in rates")
            if v.is_integer():
                return str(int(v))
            return repr(v)
        return str(v)
    return json.dumps(v, ensure_ascii=False)


def _is_scalar(v):
    return v is None or not isinstance(v, (list, dict))


def _fmt(v, indent):
    if _is_scalar(v):
        return _scalar(v)
    inner = indent + "  "
    if isinstance(v, list):
        if not v:
            return "[]"
        if all(_is_scalar(x) for x in v):
            items = [_scalar(x) for x in v]
            inline = "[" + ", ".join(items) + "]"
            if len(indent) + len(inline) <= FORMAT_WIDTH:
                return inline
            lines, cur = [], ""
            for item in items:
                if cur == "":
                    cur = item
                elif len(inner) + len(cur) + 2 + len(item) + 1 <= FORMAT_WIDTH:
                    cur += ", " + item
                else:
                    lines.append(cur)
                    cur = item
            lines.append(cur)
            return "[\n" + ",\n".join(inner + l for l in lines) + "\n" + indent + "]"
        return "[\n" + ",\n".join(inner + _fmt(x, inner) for x in v) + "\n" + indent + "]"
    keys = list(v.keys())
    if not keys:
        return "{}"
    if all(_is_scalar(v[k]) for k in keys):
        inline = "{" + ", ".join(json.dumps(k, ensure_ascii=False) + ": " + _scalar(v[k]) for k in keys) + "}"
        if len(indent) + len(inline) <= FORMAT_WIDTH:
            return inline
    return "{\n" + ",\n".join(inner + json.dumps(k, ensure_ascii=False) + ": " + _fmt(v[k], inner) for k in keys) + "\n" + indent + "}"


def format_rates_json(value):
    """Return the canonical text for a rates document (ends with a newline)."""
    return _fmt(value, "") + "\n"


EMBED_OPEN = '<script type="application/json" id="embedded-rates">'


def embed_in_index(html, formatted):
    """Replace the embedded fallback block in index.html."""
    start = html.find(EMBED_OPEN)
    if start < 0:
        raise ValueError("embedded-rates block not found in index.html")
    body_start = start + len(EMBED_OPEN)
    end = html.find("</script>", body_start)
    if end < 0:
        raise ValueError("embedded-rates block is not closed")
    return html[:body_start] + "\n" + formatted + html[end:]

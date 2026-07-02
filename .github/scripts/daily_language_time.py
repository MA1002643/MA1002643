#!/usr/bin/env python3
"""Daily Coding Time card generator.

Pulls a rolling 7-day window from the WakaTime API, renders the data as a
branded SVG card (dark + light variants, matching the profile's design
tokens), writes both to /assets, and swaps the <picture> element between the
LANG-TIME markers in README.md.

Run by .github/workflows/daily-language-time.yml.
"""

import base64
import datetime
import json
import os
import re
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from xml.sax.saxutils import escape
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
README = ROOT / "README.md"
ASSETS = ROOT / "assets"

START_TAG = "<!-- LANG-TIME:START -->"
END_TAG = "<!-- LANG-TIME:END -->"

# ── Card geometry (intrinsic px, rendered 1:1 in the README) ──
CARD_W, CARD_H = 460, 192
PAD_X = 22
RIGHT = CARD_W - PAD_X
MAX_ROWS = 7
ROW_START_Y = 55
ROW_STEP = 18
BAR_X, BAR_W, BAR_H = 160, 140, 6

# Profile brand tokens (mirrors the hand-built SVGs in /assets)
THEMES = {
    "dark": {
        "bg": "#0D1117", "border": "#243042", "title": "#FF652F",
        "text": "#E5E7EB", "muted": "#9CA3AF", "track": "#21262D",
        "accent": "#FFC857", "grad_from": "#FF652F", "grad_to": "#FFC857",
    },
    "light": {
        "bg": "#FFFFFF", "border": "#D0D7DE", "title": "#FF652F",
        "text": "#0C1A25", "muted": "#6B7280", "track": "#EAEEF2",
        "accent": "#D98324", "grad_from": "#FF652F", "grad_to": "#D98324",
    },
}

# Dot colours per language (linguist-inspired, tweaked for contrast on both themes)
LANG_COLORS = {
    "JavaScript": "#F1E05A", "TypeScript": "#3178C6", "C#": "#178600",
    "Python": "#3572A5", "HTML": "#E34C26", "CSS": "#663399",
    "SCSS": "#C6538C", "Markdown": "#4A93E8", "MDX": "#FCB32C",
    "JSON": "#CBCB41", "YAML": "#CB4B4B", "XML": "#0060AC",
    "XAML": "#512BD4", "Vue.js": "#41B883", "Vue": "#41B883",
    "Shell": "#89E051", "Bash": "#89E051", "SQL": "#E38C00",
    "Docker": "#2496ED", "Dockerfile": "#2496ED", "Git Config": "#F44D27",
    "Git": "#F44D27", "PHP": "#777BB4", "Java": "#B07219", "Go": "#00ADD8",
    "Rust": "#DEA584", "Swift": "#F05138", "Kotlin": "#A97BFF",
    "C++": "#F34B7D", "C": "#A8B9CC", "Dart": "#00B4AB", "Ruby": "#CC342D",
    "Svelte": "#FF3E00", "Astro": "#FF5A03", "PowerShell": "#5391FE",
    "Image (svg)": "#FFB13B", "Lua": "#51A0CF",
}
FALLBACK_DOT = "#8B949E"

FONT_UI = "'Segoe UI', Ubuntu, Sans-Serif"
FONT_MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"


def hhmm_words(total_seconds: int) -> str:
    m = total_seconds // 60
    h, mm = m // 60, m % 60
    if h and mm:
        return f"{h} hrs {mm} mins"
    if h:
        return f"{h} hrs"
    return f"{mm} mins"


def hm_compact(total_seconds: int) -> str:
    m = total_seconds // 60
    h, mm = m // 60, m % 60
    return f"{h}h {mm:02d}m" if h else f"{mm}m"


def fetch_summaries(user: str, api_key: str, start_dt, end_dt):
    params = {
        "start": start_dt.isoformat(),
        "end": end_dt.isoformat(),
        "timezone": "Europe/London",
    }
    url = f"https://wakatime.com/api/v1/users/{user}/summaries?{urlencode(params)}"
    headers = {"Authorization": "Basic " + base64.b64encode(api_key.encode()).decode()}
    with urlopen(Request(url, headers=headers)) as resp:
        return json.load(resp)


def aggregate_langs(summary) -> dict:
    languages = {}
    for day in summary.get("data", []):
        for lang in day.get("languages", []):
            secs = int(lang.get("total_seconds", 0))
            if secs > 0:
                name = lang.get("name", "Unknown")
                languages[name] = languages.get(name, 0) + secs
    return languages


def _style() -> str:
    return (
        "<style>"
        ".t{font:600 14.5px " + FONT_UI + ";}"
        ".m{font:400 10px " + FONT_UI + ";}"
        ".n{font:600 11.5px " + FONT_UI + ";}"
        ".v{font:500 11px " + FONT_MONO + ";}"
        ".p{font:400 10px " + FONT_MONO + ";}"
        ".tt{font:600 11px " + FONT_MONO + ";}"
        ".fade{opacity:0;animation:fd .6s ease-out forwards;}"
        ".row{opacity:0;animation:fd .5s ease-out forwards;}"
        ".fill{transform:scaleX(0);transform-origin:left center;transform-box:fill-box;"
        "animation:gr .8s cubic-bezier(.2,.6,.2,1) forwards;}"
        "@keyframes fd{to{opacity:1}}"
        "@keyframes gr{to{transform:scaleX(1)}}"
        "@media (prefers-reduced-motion:reduce){"
        ".fade,.row{animation:none;opacity:1}"
        ".fill{animation:none;transform:none}}"
        "</style>"
    )


def build_svg(items, theme_name: str, updated: str) -> str:
    """items: list of (language, seconds), already sorted descending."""
    c = THEMES[theme_name]
    total = sum(s for _, s in items)
    shown = items[:MAX_ROWS]
    hidden = len(items) - len(shown)

    p = []
    p.append(
        f'<svg width="{CARD_W}" height="{CARD_H}" viewBox="0 0 {CARD_W} {CARD_H}" '
        f'fill="none" xmlns="http://www.w3.org/2000/svg" role="img" '
        f'aria-label="Daily coding time by language, past 7 days">'
    )
    p.append(_style())
    p.append(
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">'
        f'<stop offset="0" stop-color="{c["grad_from"]}"/>'
        f'<stop offset="1" stop-color="{c["grad_to"]}"/>'
        "</linearGradient></defs>"
    )
    p.append(
        f'<rect x="0.5" y="0.5" width="{CARD_W - 1}" height="{CARD_H - 1}" '
        f'rx="4.5" fill="{c["bg"]}" stroke="{c["border"]}"/>'
    )

    # Header: clock glyph, title, window meta
    p.append('<g class="fade">')
    p.append(
        f'<g stroke="{c["title"]}" stroke-width="1.6" stroke-linecap="round">'
        f'<circle cx="29" cy="22" r="7"/><path d="M29 18v4h3.2"/></g>'
    )
    p.append(f'<text x="44" y="27" class="t" fill="{c["title"]}">Daily Coding Time</text>')
    p.append(
        f'<text x="{RIGHT}" y="27" text-anchor="end" class="m" '
        f'fill="{c["muted"]}">last 7 days &#183; WakaTime</text>'
    )
    p.append("</g>")

    if not shown:
        p.append(
            f'<text x="{CARD_W // 2}" y="{CARD_H // 2 + 8}" text-anchor="middle" '
            f'class="n" fill="{c["muted"]}">No editor activity recorded in this window</text>'
        )
    for i, (name, secs) in enumerate(shown):
        pct = (secs / total * 100.0) if total else 0.0
        y = ROW_START_Y + i * ROW_STEP
        dot = LANG_COLORS.get(name, FALLBACK_DOT)
        fill_w = max(6.0, pct / 100.0 * BAR_W)
        delay = 0.15 + i * 0.08
        p.append(f'<g class="row" style="animation-delay:{delay:.2f}s">')
        p.append(f'<circle cx="27" cy="{y - 3.5}" r="3.5" fill="{dot}"/>')
        p.append(f'<text x="38" y="{y}" class="n" fill="{c["text"]}">{escape(name)}</text>')
        p.append(
            f'<rect x="{BAR_X}" y="{y - 8}" width="{BAR_W}" height="{BAR_H}" '
            f'rx="3" fill="{c["track"]}"/>'
        )
        p.append(
            f'<rect class="fill" style="animation-delay:{delay + 0.1:.2f}s" '
            f'x="{BAR_X}" y="{y - 8}" width="{fill_w:.1f}" height="{BAR_H}" '
            f'rx="3" fill="url(#g)"/>'
        )
        p.append(
            f'<text x="{RIGHT - 46}" y="{y}" text-anchor="end" class="v" '
            f'fill="{c["text"]}">{hm_compact(secs)}</text>'
        )
        p.append(
            f'<text x="{RIGHT}" y="{y}" text-anchor="end" class="p" '
            f'fill="{c["muted"]}">{pct:.1f}%</text>'
        )
        p.append("</g>")

    # Footer: overflow count + freshness on the left, weekly total on the right
    left_bits = [f"+{hidden} more" if hidden > 0 else None, f"updated {updated}"]
    left_txt = " &#183; ".join(b for b in left_bits if b)
    p.append(f'<g class="fade" style="animation-delay:.7s">')
    p.append(
        f'<line x1="{PAD_X}" y1="171.5" x2="{RIGHT}" y2="171.5" stroke="{c["track"]}"/>'
    )
    p.append(f'<text x="{PAD_X}" y="184" class="m" fill="{c["muted"]}">{left_txt}</text>')
    if total:
        p.append(
            f'<text x="{RIGHT}" y="184" text-anchor="end" class="tt" '
            f'fill="{c["accent"]}">Total {hm_compact(total)}</text>'
        )
    p.append("</g>")
    p.append("</svg>")
    return "".join(p)


def build_alt(items, updated: str) -> str:
    total = sum(s for _, s in items)
    if not items:
        return f"Daily coding time — no editor activity recorded in the past 7 days (updated {updated})"
    top = ", ".join(
        f"{name} {hhmm_words(secs)} ({(secs / total * 100.0):.1f}%)"
        for name, secs in items[:MAX_ROWS]
    )
    return (
        f"Daily coding time by language over the past 7 days — {top}. "
        f"Total {hhmm_words(total)}. Updated {updated}."
    )


def picture_block(alt: str) -> str:
    alt_attr = escape(alt, {'"': "&quot;"})
    return (
        '<picture><source media="(prefers-color-scheme: dark)" '
        'srcset="./assets/lang-time-dark.svg">'
        f'<img src="./assets/lang-time-light.svg" alt="{alt_attr}" '
        f'width="{CARD_W}" height="{CARD_H}"></picture>'
    )


def update_readme(picture_html: str) -> None:
    readme = README.read_text(encoding="utf-8")
    if START_TAG not in readme or END_TAG not in readme:
        print("::error::Markers not found in README.md. Add the LANG-TIME markers.")
        sys.exit(1)
    # Single newlines only: the block lives inside an inline <div> row, and a
    # blank line would split it into separate markdown paragraphs (stacking
    # the cards instead of letting them sit side by side).
    replacement = f"{START_TAG}\n  {picture_html}\n  {END_TAG}"
    new_readme = re.sub(
        rf"{re.escape(START_TAG)}.*?{re.escape(END_TAG)}",
        replacement,
        readme,
        flags=re.DOTALL,
    )
    README.write_text(new_readme, encoding="utf-8")


def render_and_update(items, updated: str) -> None:
    """items: list of (language, seconds), sorted descending by seconds."""
    ASSETS.mkdir(exist_ok=True)
    for theme in THEMES:
        svg = build_svg(items, theme, updated)
        (ASSETS / f"lang-time-{theme}.svg").write_text(svg, encoding="utf-8")
    update_readme(picture_block(build_alt(items, updated)))
    print(f"Rendered lang-time cards ({len(items)} languages) and updated README.")


def main() -> None:
    api_key = os.getenv("WAKATIME_API_KEY")
    if not api_key:
        print("::error::WAKATIME_API_KEY secret missing. Add it in repo settings.")
        sys.exit(1)
    user = os.getenv("WAKATIME_USER") or "current"

    # Strict rolling last 7 days ending "now" (run time) in Europe/London
    tz = ZoneInfo("Europe/London")
    now = datetime.datetime.now(tz)
    used_start = now - datetime.timedelta(days=7)

    try:
        data = fetch_summaries(user, api_key, used_start, now)
    except HTTPError as e:
        print(f"::error::WakaTime API error {e.code} at /api/v1/users/{user}/summaries")
        print(e.read().decode(errors="ignore")[:500])
        sys.exit(1)

    languages = aggregate_langs(data)
    items = sorted(languages.items(), key=lambda kv: kv[1], reverse=True)
    render_and_update(items, updated=now.date().isoformat())


if __name__ == "__main__":
    main()

"""Regenerate the palette half of dark mode.

Usage:  python scripts/gen-dark-theme.py out.css
Then paste the result under "--- The palette, colour by colour ---" at the end
of src/renderer/globals.css, keeping the hand-written rules that follow it
(the glass, the rings, the shadows, the call to action). The colours here are
a starting point, not a verdict: edit them in globals.css once they are there.

Read the dashboard's colour vocabulary out of the source and write the dark
half of it. Roles, not colours, decide the answer: ink gets light, a faint
label gets darker, a near-white fill becomes a dark surface, every hairline
becomes the same faint white edge."""
import colorsys
import io
import os
import re
import sys
from collections import Counter

ROOT = r"C:\Users\zelqd\Desktop\falcon\apps\desktop\src\renderer"
PAT = re.compile(r"\b(bg|text|border|divide|ring)-\[#([0-9a-fA-F]{6})\](/(?:\[[0-9.]+\]|[0-9]+))?")

# Colours whose answer is not a rule. Empty string = leave it alone.
BY_HAND = {
    ("bg", "1d1b1b"): "#ededed",   # the one solid CTA surface, inverted whole
    ("bg", "2a2a2a"): "",          # already dark
    ("bg", "189e9a"): "",          # the teal the app measures with
    ("bg", "dc2626"): "",
    ("bg", "16a34a"): "",
    ("bg", "9ca3af"): "",
    ("bg", "ffffff"): "#141413",
    ("text", "ffffff"): "",
    ("border", "189e9a"): "",
}


def hex_to_hls(h):
    r, g, b = (int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))
    hu, li, sa = colorsys.rgb_to_hls(r, g, b)
    return hu, li, sa, (0.2126 * r + 0.7152 * g + 0.0722 * b)


def to_hex(hu, li, sa):
    r, g, b = colorsys.hls_to_rgb(hu, max(0.0, min(1.0, li)), sa)
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))


def chroma(h):
    """How much colour is actually in it. HLS saturation runs high for
    near-white and near-black, which would call a cream tile yellow."""
    v = [int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return max(v) - min(v)


def map_text(h):
    hu, li, sa, lum = hex_to_hls(h)
    if chroma(h) > 0.12:  # it means something — gain, loss, caution, the teal
        return to_hex(hu, max(0.58, min(0.72, 1 - li)), min(0.8, sa))
    # A neutral keeps its place in the order by swapping ends: ink becomes
    # near-white, a faint label a faint dark grey. The floor is where a label
    # stops being legible on black, so nothing is sent below it.
    return to_hex(hu, max(0.46, min(0.93, 1 - li)), sa)


def map_bg(h):
    hu, li, sa, lum = hex_to_hls(h)
    if chroma(h) > 0.08 and li > 0.7:  # a tinted chip: the same hue, held low
        r, g, b = colorsys.hls_to_rgb(hu, 0.45, min(0.8, max(0.45, sa)))
        return "rgba(%d, %d, %d, 0.2)" % (round(r * 255), round(g * 255), round(b * 255))
    if li > 0.9:
        return "#161615"
    if li > 0.8:
        return "#1f1f1d"
    if li > 0.55:
        return "#262624"
    return ""  # already dark enough to leave alone


def map_border(h):
    _, li, _, _ = hex_to_hls(h)
    return "#ededed" if li < 0.3 else "rgba(255, 255, 255, 0.09)"


def sel(prop, h, alpha):
    """Case-insensitive, and anchored to the start of a class name so a
    `hover:` or `group-hover:` variant is not mistaken for the resting one."""
    cls = "%s-[#%s]%s" % (prop, h, alpha)
    return '[data-theme="dark"] [class^="%s" i],\n[data-theme="dark"] [class*=" %s" i]' % (cls, cls)


def main():
    seen = Counter()
    for base, _, files in os.walk(ROOT):
        if "__preview__" in base or "node_modules" in base:
            continue
        for f in files:
            if not f.endswith((".tsx", ".ts")):
                continue
            text = io.open(os.path.join(base, f), encoding="utf-8").read()
            for prop, h, alpha in PAT.findall(text):
                seen[(prop, h.lower(), alpha or "")] += 1

    out, table = [], []
    # Base colours first, then the alpha variants: a substring match means the
    # base rule also catches `.../30`, and the later rule has to win.
    for alpha_pass in (False, True):
        for (prop, h, alpha), n in sorted(seen.items(), key=lambda kv: -kv[1]):
            if bool(alpha) != alpha_pass:
                continue
            key = (prop, h)
            if key in BY_HAND and not alpha:
                value = BY_HAND[key]
            elif prop == "text":
                value = map_text(h)
            elif prop in ("border", "divide", "ring"):
                value = map_border(h)
            else:
                value = map_bg(h)
            if not value:
                continue
            if alpha:
                # Keep the alpha, swap the colour underneath it.
                if value.startswith("#"):
                    r, g, b = (int(value[i : i + 2], 16) for i in (1, 3, 5))
                    a = alpha.strip("/[]")
                    value = "rgba(%d, %d, %d, %s)" % (r, g, b, a if "." in a else "0.%s" % a.zfill(2))
                else:
                    continue
            prop_css = {
                "bg": "background-color",
                "text": "color",
                "border": "border-color",
                "divide": "border-color",
                "ring": "--tw-ring-color",
            }[prop]
            if prop == "divide":
                s = '[data-theme="dark"] [class*="divide-[#%s]" i] > :not([hidden]) ~ :not([hidden])' % h
            else:
                s = sel(prop, h, alpha)
            out.append("%s { %s: %s; }" % (s, prop_css, value))
            table.append("%s-[#%s]%s (%d) -> %s" % (prop, h, alpha, n, value))

    io.open(sys.argv[1], "w", encoding="utf-8", newline="\n").write("\n".join(out) + "\n")
    print("\n".join(table))
    print("\n%d rules" % len(out))


main()

"""Regenerate the palette half of dark mode.

Usage:  python scripts/gen-dark-theme.py          (rewrites globals.css in place)
        python scripts/gen-dark-theme.py --print  (prints the block instead)

Colours in the renderer are the Apple-palette token utilities
(`text-content-secondary`, `bg-surface-2`, `border-edge-subtle`,
`text-tone-positive`; tailwind.config.ts), which are right in both themes on
their own. What is still written as a literal light class is the glass
(`bg-white/55`, `border-black/[0.06]`) and the odd hex that slips in
(`text-[#6b7280]`). Dark mode reads that vocabulary back out of the renderer
source and maps every entry onto a semantic token defined at the top of
src/renderer/globals.css (`--surface-1`, `--text-secondary`,
`--border-subtle`, `--positive`...).

Roles, not colours, decide the answer: a near-black text colour is ink and
becomes `--text-primary`; a cream fill becomes a surface step; any light
hairline becomes one of three border weights; a tinted chip becomes the
tone's soft fill. The colours themselves live only in the tokens, so a dark
value is tuned once, in globals.css, and every class that maps to it follows.

The output replaces whatever sits between the two `@generated dark-palette`
markers in globals.css. Hand-written rules (the glass, the call to action,
the charts) live after the markers and are never touched by this script.
Run it again whenever a component brings in a light colour the block does
not know yet; it is idempotent.
"""
import colorsys
import io
import os
import re
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
RENDERER = os.path.join(HERE, "..", "src", "renderer")
CSS = os.path.join(RENDERER, "globals.css")
START = "/* @generated dark-palette:start (scripts/gen-dark-theme.py) */"
END = "/* @generated dark-palette:end */"

PROPS = r"bg|text|border(?:-[trblxy])?|divide|ring|outline|decoration|placeholder"
COLOR = r"\[#[0-9a-fA-F]{6}\]|white|black|(?:red|emerald|amber)-\d{2,3}"
VARIANTS = ("hover:", "focus:", "focus-visible:", "focus-within:", "active:", "disabled:", "group-hover:", "placeholder:")
PAT = re.compile(
    r"(?<![\w\-\[:/])((?:hover:|focus:|focus-visible:|focus-within:|active:|disabled:|group-hover:|placeholder:)?)"
    r"(" + PROPS + r")-(" + COLOR + r")((?:/\[[0-9.]+\]|/\d+)?)(?![\w\-\[])"
)

# The glass vocabulary components are still written in. Rules for these are
# emitted even when no file uses them yet, so a component written today in
# the house classes is dark the moment it lands. Colours (text, edges, tones)
# belong in the token utilities instead and need no rule here.
CORE = [
    "bg-white", "bg-white/40", "bg-white/45", "bg-white/50", "bg-white/55", "bg-white/60",
    "bg-white/70", "bg-white/75", "bg-white/80", "bg-white/90",
    "hover:bg-white/55", "hover:bg-white/60", "hover:bg-white/70", "hover:bg-white/75", "hover:bg-white/80",
    "hover:bg-white/90", "hover:bg-white", "focus:bg-white/75", "focus-within:bg-white/70",
    "border-white/40", "border-white/60", "border-white/70",
    "border-black/[0.06]", "border-black/[0.08]", "border-black/[0.1]", "border-black/[0.12]",
    "divide-black/[0.06]", "ring-black/[0.04]", "ring-black/[0.06]", "ring-black/[0.08]", "ring-black/[0.1]",
    "bg-black/[0.03]", "bg-black/[0.04]", "bg-black/[0.05]", "bg-black/[0.06]", "bg-black/[0.08]",
    "hover:bg-black/[0.03]", "hover:bg-black/[0.04]", "hover:bg-black/[0.05]", "hover:bg-black/[0.06]",
    "hover:bg-black/[0.08]",
]

# Colours whose answer is not a rule. None = leave it alone (already right
# on dark, or handled by the hand-written rules after the block).
BY_HAND = {
    ("bg", "eaeae6"): "var(--surface-0)",    # the canvas itself
    ("bg", "f4f4f0"): "var(--surface-1)",    # a panel's own ground
    ("bg", "1d1b1b"): None,                  # ink as a surface: CTA, tile or mark, see below
    ("text", "ffffff"): None,
    ("bg", "ffffff"): "var(--surface-3)",
}

TONES = [  # (name, hue from, hue to) in degrees
    ("negative", 345, 360), ("negative", 0, 15), ("warning", 15, 65), ("positive", 65, 165),
    ("teal", 165, 200), ("info", 200, 235), ("violet", 235, 300), ("pink", 300, 345),
]
TAILWIND = {"red-50": "fef2f2", "red-200": "fecaca", "red-600": "dc2626", "red-700": "b91c1c",
            "emerald-500": "10b981", "amber-600": "d97706"}
DARK_NATIVE_TW = {"red-300", "red-400"}


def hls(h):
    r, g, b = (int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))
    hu, li, sa = colorsys.rgb_to_hls(r, g, b)
    return hu * 360, li, max(r, g, b) - min(r, g, b)


def tone(h):
    hu, _, _ = hls(h)
    for name, lo, hi in TONES:
        if lo <= hu < hi:
            return name
    return "negative"


def text_token(h):
    hu, li, ch = hls(h)
    if ch > 0.12:
        # A colour that means something. A dull one (a brown caption) keeps
        # its hue but sits back at secondary weight.
        return "var(--%s%s)" % (tone(h), "-muted" if ch < 0.3 else "")
    if li < 0.2:
        return "var(--text-primary)"
    if li < 0.4:
        return "var(--text-body)"
    if li < 0.5:
        return "var(--text-secondary)"
    if li < 0.665:
        return "var(--text-tertiary)"
    return "var(--text-disabled)"


def bg_token(h):
    hu, li, ch = hls(h)
    if ch > 0.08:
        return "var(--%s-soft)" % tone(h) if li > 0.7 else None  # solid swatches stay
    if li > 0.925:
        return "var(--surface-2)"
    if li > 0.86:
        return "var(--surface-3)"
    if li > 0.7:
        return "var(--fill-strong)"
    return None


def border_token(h):
    hu, li, ch = hls(h)
    if li < 0.3:
        return "var(--text-primary)"
    if ch > 0.08 and li < 0.8:
        return "var(--%s-line)" % tone(h)
    if li > 0.915:
        return "var(--border-subtle)"
    if li > 0.85:
        return "var(--border-default)"
    return "var(--border-strong)"


def alpha_of(a):
    a = a.strip("/[]")
    return float(a) if "." in a else int(a) / 100


def white_black(prop, col, a):
    """The white and black alphas the glass is drawn with."""
    x = alpha_of(a) if a else 1.0
    if col == "white":
        if prop == "bg":
            if not a:
                return "var(--surface-3)"
            if x < 0.3:
                return None  # already a dark-mode veil
            if x <= 0.42:
                return "var(--surface-1)"
            if x <= 0.62:
                return "var(--surface-2)"
            return "var(--surface-3)"
        if prop in ("border", "ring", "divide"):
            # A glass edge. Solid white is a deliberate ring (a selected
            # swatch, an avatar) and the low alphas are already dark values.
            return "var(--border-default)" if a and x >= 0.3 else None
        return None  # white text and marks are already right
    # black
    if prop == "text":
        return "var(--text-primary)" if not a else "rgb(var(--ink-rgb) / %s)" % x
    if prop == "decoration":
        return "rgb(var(--ink-rgb) / %s)" % x
    if prop in ("border", "divide"):
        if x <= 0.07:
            return "var(--border-subtle)"
        if x <= 0.15:
            return "var(--border-default)"
        return "var(--border-strong)"
    if prop == "ring":
        if x <= 0.045:
            return "transparent"  # one hairline per surface, not two
        if x <= 0.08:
            return "var(--border-subtle)"
        return "var(--border-default)"
    if prop == "outline":
        return "var(--focus-ring)"
    if prop == "bg":
        if not a:
            return None  # solid black: the CTA's press, handled by hand
        if x < 0.03:
            return "var(--surface-sunken)"
        if x <= 0.045:
            return "var(--fill-hover)"
        if x <= 0.055:
            return "var(--fill-press)"
        if x <= 0.09:
            return "var(--fill-selected)"
        if x <= 0.3:
            return "var(--backdrop)"  # a panel's scrim: darker on dark, never lighter
        return None
    return None


def value_for(variant, prop, col, a):
    base = prop.split("-")[0] if prop.startswith("border") else prop
    if col in ("white", "black"):
        v = white_black(base, col, a)
        if v and variant in ("hover:", "group-hover:", "focus:", "focus-within:") and base == "bg" and col == "white":
            # A hover on glass is one step up from where it rests.
            v = {"var(--surface-1)": "var(--surface-2)", "var(--surface-2)": "var(--surface-3)",
                 "var(--surface-3)": "var(--surface-4)"}.get(v, v)
        if v and variant == "hover:" and base == "bg" and col == "black":
            v = {"var(--fill-hover)": "var(--fill-press)", "var(--fill-press)": "var(--fill-selected)"}.get(v, v)
        return v
    if col in DARK_NATIVE_TW:
        return None
    if "-" in col and not col.startswith("["):
        h = TAILWIND.get(col)
        if not h:
            return None
    else:
        h = col.strip("[]#").lower()
    if base == "outline":
        return "var(--focus-ring)"  # outlines in this app are focus rings
    if (base, h) in BY_HAND and not a:
        return BY_HAND[(base, h)]
    if base == "bg" and h == "1d1b1b":
        return None
    if a and base != "text" and hls(h)[2] > 0.08 and hls(h)[1] <= 0.7:
        # A saturated colour laid thin, as a wash or an edge: the tone itself
        # at the same strength, not its already-faint soft or line value.
        return "color-mix(in srgb, var(--%s) %s%%, transparent)" % (tone(h), round(alpha_of(a) * 100))
    if base in ("text", "placeholder", "decoration"):
        v = text_token(h)
    elif base in ("border", "divide", "ring", "outline"):
        v = border_token(h)
    else:
        v = bg_token(h)
    if v and a:
        x = alpha_of(a)
        if v.startswith("var(--surface") or v.startswith("var(--border") or v.startswith("var(--fill"):
            return v if x >= 0.5 else None
        return "color-mix(in srgb, %s %s%%, transparent)" % (v, round(x * 100))
    return v


CSS_PROP = {"bg": "background-color", "text": "color", "placeholder": "color", "border": "border-color",
            "divide": "border-color", "ring": "--tw-ring-color", "outline": "outline-color",
            "decoration": "text-decoration-color"}
SIDE = {"t": "border-top-color", "b": "border-bottom-color", "l": "border-left-color", "r": "border-right-color",
        "x": "border-left-color: {v}; border-right-color", "y": "border-top-color: {v}; border-bottom-color"}
PSEUDO = {"": "", "hover:": ":hover", "focus:": ":focus", "focus-visible:": ":focus-visible",
          "focus-within:": ":focus-within", "active:": ":active", "disabled:": ":disabled", "placeholder:": "::placeholder"}


def css_class(name):
    """`.name` with every character CSS treats as syntax escaped."""
    return "." + "".join(c if c.isalnum() or c in "_-" else "\\" + c for c in name)


def selector(variant, cls, spellings, as_attr=False):
    """The selector list for one rule.

    Class selectors, one per spelling the source uses (hex is written both
    `#9ca3af` and `#9CA3AF`; both cases are always listed). An attribute
    selector (`[class~="..." i]`) would match every spelling at once, but
    Blink cannot index it: it is tested against every element with a class
    on every style recalc, and two hundred of them made a full recalc (a
    dialog opening, a theme switch) five times slower. A class selector is
    only ever tested against elements that carry the class.

    `as_attr` keeps the attribute form for a utility that globals.css also
    `@apply`s: Tailwind folds every user rule naming an applied class into
    the rule doing the applying, so a class selector here would leak the
    dark colour into `.glass-cta` or `.markdown-body`.
    """
    if as_attr:
        targets = ['[class~="%s" i]' % (variant + cls)]
    else:
        targets = [css_class(variant + sp) for sp in spellings]
    out = []
    for t in targets:
        if variant == "group-hover:":
            out.append('[data-theme="dark"] .group:hover %s' % t)
        elif cls.startswith("divide-"):
            out.append('[data-theme="dark"] %s > :not([hidden]) ~ :not([hidden])' % t)
        elif cls.startswith("placeholder-"):
            out.append('[data-theme="dark"] %s::placeholder' % t)
        else:
            out.append('[data-theme="dark"] %s%s' % (t, PSEUDO[variant]))
    return ", ".join(out)


def applied_classes():
    """Every utility globals.css `@apply`s, lower-cased."""
    css = io.open(CSS, encoding="utf-8").read()
    names = set()
    for line in re.findall(r"@apply([^;]*);", css):
        names.update(w.lower() for w in line.split())
    return names


def collect():
    seen = Counter()
    for base, _, files in os.walk(RENDERER):
        if "node_modules" in base:
            continue
        for f in files:
            if f.endswith((".tsx", ".ts")):
                text = io.open(os.path.join(base, f), encoding="utf-8").read()
                for m in PAT.finditer(text):
                    seen[m.groups()] += 1
    for c in CORE:
        m = PAT.fullmatch(c)
        if m:
            seen[m.groups()] += 0
    return seen


def build():
    seen = collect()
    applied = applied_classes()
    spellings = {}
    for (variant, prop, col, a) in seen:
        key = (variant, prop, col.lower(), a)
        spellings.setdefault(key, set()).update(
            {"%s-%s%s" % (prop, c, a) for c in (col, col.lower(), col.upper() if col.startswith("[") else col)}
        )
    rules = {}
    for (variant, prop, col, a), n in seen.items():
        key = (variant, prop, col.lower(), a)
        if key in rules:
            continue
        v = value_for(variant, prop, col.lower(), a)
        if not v:
            continue
        cls = "%s-%s%s" % (prop, col.lower(), a)
        base = prop.split("-")[0] if prop.startswith("border") else prop
        if prop.startswith("border-") and prop[-1] in SIDE:
            decl = "%s: %s;" % (SIDE[prop[-1]].format(v=v), v)
        else:
            decl = "%s: %s;" % (CSS_PROP[base], v)
        if variant == "placeholder:":
            decl = "color: %s;" % v
        rules[key] = (selector(variant, cls, sorted(spellings[key]), (variant + cls).lower() in applied), decl)
    # Resting states first, then the states that must beat them.
    order = {"": 0, "placeholder:": 1, "disabled:": 2, "focus-within:": 3, "focus:": 4,
             "focus-visible:": 5, "hover:": 6, "group-hover:": 7, "active:": 8}
    keys = sorted(rules, key=lambda k: (order[k[0]], k[1], k[2], k[3]))
    lines = ["%s { %s }" % rules[k] for k in keys]
    return "\n".join(lines)


def main():
    block = build()
    if "--print" in sys.argv:
        print(block)
        return
    css = io.open(CSS, encoding="utf-8").read()
    i, j = css.index(START), css.index(END)
    css = css[: i + len(START)] + "\n" + block + "\n" + css[j:]
    io.open(CSS, "w", encoding="utf-8", newline="\n").write(css)
    print("%d rules written to globals.css" % block.count("\n"))


main()

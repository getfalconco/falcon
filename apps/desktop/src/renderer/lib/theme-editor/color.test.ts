import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  composite,
  contrastRatio,
  formatColor,
  formatHslChannels,
  formatRgbChannels,
  parseColor,
  parseHslChannels,
  parseRgbChannels,
  toPickerHex,
  withPicker,
} from "./color";
import { acceptTyped, colorExpression, fromPicked } from "./edit";

describe("parseColor", () => {
  it("reads hex in every length", () => {
    assert.deepEqual(parseColor("#131312"), { r: 19, g: 19, b: 18, a: 1 });
    assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
    assert.deepEqual(parseColor("#0000"), { r: 0, g: 0, b: 0, a: 0 });
    assert.deepEqual(parseColor("#FFFFFF80"), { r: 255, g: 255, b: 255, a: 0.502 });
    assert.equal(parseColor("#12345"), null);
    assert.equal(parseColor("#ggg"), null);
  });

  it("reads rgb() and rgba(), comma and space syntax, percentages", () => {
    assert.deepEqual(parseColor("rgba(255, 255, 255, 0.055)"), { r: 255, g: 255, b: 255, a: 0.055 });
    assert.deepEqual(parseColor("rgb(0 0 0 / 22%)"), { r: 0, g: 0, b: 0, a: 0.22 });
    assert.deepEqual(parseColor("rgb(100%, 0%, 50%)"), { r: 255, g: 0, b: 128, a: 1 });
    assert.deepEqual(parseColor("RGB(1, 2, 3)"), { r: 1, g: 2, b: 3, a: 1 });
  });

  it("reads hsl() and hsla() the way globals.css writes them", () => {
    assert.deepEqual(parseColor("hsla(0, 0%, 14%, 1)"), { r: 36, g: 36, b: 36, a: 1 });
    assert.deepEqual(parseColor("hsl(0 0% 3.5%)"), { r: 9, g: 9, b: 9, a: 1 });
    assert.deepEqual(parseColor("hsl(120deg 100% 50% / 0.5)"), { r: 0, g: 255, b: 0, a: 0.5 });
  });

  it("reads what getComputedStyle hands back for a color-mix", () => {
    assert.deepEqual(parseColor("color(srgb 1 0 0.5 / 0.14)"), { r: 255, g: 0, b: 128, a: 0.14 });
    assert.deepEqual(parseColor("color(srgb 0 0 0)"), { r: 0, g: 0, b: 0, a: 1 });
  });

  it("reads transparent, and refuses what it cannot resolve alone", () => {
    assert.deepEqual(parseColor("transparent"), { r: 0, g: 0, b: 0, a: 0 });
    assert.equal(parseColor("var(--positive)"), null);
    assert.equal(parseColor("color-mix(in srgb, red 10%, transparent)"), null);
    assert.equal(parseColor("rgb(1, 2)"), null);
    assert.equal(parseColor(""), null);
  });
});

describe("picker and text round trips", () => {
  it("gives the picker #rrggbb and keeps alpha apart", () => {
    const c = parseColor("rgba(255, 255, 255, 0.08)")!;
    assert.equal(toPickerHex(c), "#ffffff");
    assert.deepEqual(withPicker("#123456", c.a), { r: 18, g: 52, b: 86, a: 0.08 });
    assert.equal(formatColor(withPicker("#123456", c.a)!), "rgba(18, 52, 86, 0.08)");
  });

  it("writes hex when opaque and rgba() when not, so the export reads like the file", () => {
    assert.equal(formatColor({ r: 19, g: 19, b: 18, a: 1 }), "#131312");
    assert.equal(formatColor({ r: 0, g: 0, b: 0, a: 0.6 }), "rgba(0, 0, 0, 0.6)");
    assert.equal(formatColor({ r: 255, g: 255, b: 255, a: 0.0551234 }), "rgba(255, 255, 255, 0.055)");
  });

  it("survives text to picker to text", () => {
    for (const text of ["#e8e7e3", "#4fbf87", "rgba(255, 255, 255, 0.13)", "rgba(0, 0, 0, 0.22)"]) {
      const c = parseColor(text)!;
      assert.equal(formatColor(withPicker(toPickerHex(c), c.a)!), text);
    }
    // hsl() comes back as the hex it is.
    assert.equal(formatColor(parseColor("hsl(0 0% 100%)")!), "#ffffff");
  });

  it("round-trips the channel tokens", () => {
    const bg = parseHslChannels("60 5% 4%")!;
    // The 8-bit colour quantises the channels a little; the colour itself survives.
    assert.equal(formatHslChannels(bg), "60 4.8% 4.1%");
    assert.deepEqual(parseHslChannels(formatHslChannels(bg)), bg);
    assert.deepEqual(parseRgbChannels("232 231 227"), { r: 232, g: 231, b: 227, a: 1 });
    assert.equal(formatRgbChannels({ r: 232, g: 231, b: 227, a: 1 }), "232 231 227");
    assert.equal(parseRgbChannels("300 0 0"), null);
  });
});

describe("contrast", () => {
  it("is 21 for white on black and 1 for a colour on itself", () => {
    const white = parseColor("#ffffff")!;
    const black = parseColor("#000000")!;
    assert.equal(contrastRatio(white, black), 21);
    assert.equal(contrastRatio(black, black), 1);
  });

  it("composites a translucent foreground first", () => {
    const half = parseColor("rgba(255, 255, 255, 0.5)")!;
    const black = parseColor("#000")!;
    assert.deepEqual(composite(half, black), { r: 127.5, g: 127.5, b: 127.5, a: 1 });
    assert.ok(contrastRatio(half, black) < 21 && contrastRatio(half, black) > 4);
  });

  it("reads the shipped body text on a card above AA", () => {
    assert.ok(contrastRatio(parseColor("#c2c1bc")!, parseColor("#0b0b0a")!) >= 4.5);
  });
});

describe("row edits", () => {
  const supports = (property: string, value: string) =>
    property === "color" ? /^(color-mix|var)\(|^red$/.test(value) : property === "box-shadow" && /px/.test(value);

  it("keeps a typed colour as typed and refuses nonsense", () => {
    assert.equal(acceptTyped("color", " #ABCDEF ", supports), "#ABCDEF");
    assert.equal(acceptTyped("color", "hsl(0 0% 50%)", supports), "hsl(0 0% 50%)");
    assert.equal(acceptTyped("color", "red", supports), "red");
    assert.equal(acceptTyped("color", "not a colour", supports), null);
    assert.equal(acceptTyped("color", "#fff; } body { color: red", supports), null);
  });

  it("takes any colour for a channel token, in the token's own form", () => {
    assert.equal(acceptTyped("hsl-channels", "0 0% 90%", supports), "0 0% 90%");
    assert.equal(acceptTyped("hsl-channels", "#ffffff", supports), "0 0% 100%");
    assert.equal(acceptTyped("rgb-channels", "rgb(1, 2, 3)", supports), "1 2 3");
  });

  it("lets a derived token go back to a mix, and a shadow stay text", () => {
    assert.equal(
      acceptTyped("derived", "color-mix(in srgb, var(--positive) 20%, transparent)", supports),
      "color-mix(in srgb, var(--positive) 20%, transparent)",
    );
    assert.equal(acceptTyped("shadow", "0 1px 2px rgba(0, 0, 0, 0.4)", supports), "0 1px 2px rgba(0, 0, 0, 0.4)");
    assert.equal(acceptTyped("shadow", "nope", supports), null);
  });

  it("writes a picked colour in the token's form, and knows how to read each back", () => {
    const c = { r: 255, g: 0, b: 0, a: 0.5 };
    assert.equal(fromPicked("color", c), "rgba(255, 0, 0, 0.5)");
    assert.equal(fromPicked("derived", { ...c, a: 1 }), "#ff0000");
    assert.equal(fromPicked("hsl-channels", c), "0 100% 50%");
    assert.equal(fromPicked("rgb-channels", c), "255 0 0");
    assert.equal(fromPicked("shadow", c), null);
    assert.equal(colorExpression("--background", "hsl-channels"), "hsl(var(--background))");
    assert.equal(colorExpression("--ink-rgb", "rgb-channels"), "rgb(var(--ink-rgb))");
    assert.equal(colorExpression("--shadow-card", "shadow"), null);
  });
});

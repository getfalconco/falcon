// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/workspace/greeting.test.ts
// Pure checks of the Dashboard greeting; nothing leaves the machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dayPart, firstName, greeting, greetingName } from "./greeting";

test("hour boundaries", () => {
  const expect: Array<[number, string]> = [
    [0, "Evening"],
    [4, "Evening"],
    [5, "Morning"],
    [11, "Morning"],
    [12, "Afternoon"],
    [17, "Afternoon"],
    [18, "Evening"],
    [23, "Evening"],
  ];
  for (const [hour, part] of expect) assert.equal(dayPart(hour), part, `hour ${hour}`);
});

test("first word of the name", () => {
  assert.equal(firstName("Kuzey Kovalak"), "Kuzey");
  assert.equal(firstName("  Kuzey  "), "Kuzey");
  assert.equal(firstName(""), null);
  assert.equal(firstName("   "), null);
  assert.equal(firstName(undefined), null);
  assert.equal(firstName(42), null);
});

test("greeting with and without a name", () => {
  assert.equal(greeting(8, "Kuzey Kovalak"), "Morning, Kuzey");
  assert.equal(greeting(14, "Kuzey"), "Afternoon, Kuzey");
  assert.equal(greeting(20, "Kuzey"), "Evening, Kuzey");
  assert.equal(greeting(8, null), "Morning");
  assert.equal(greeting(3), "Evening");
});

test("the preferred name comes first, then the first word of the full name", () => {
  assert.equal(greetingName("Kuz", "Kuzey Kovalak"), "Kuz");
  assert.equal(greetingName("  Dr.   K  ", "Kuzey Kovalak"), "Dr. K");
  assert.equal(greetingName("", "Kuzey Kovalak"), "Kuzey");
  assert.equal(greetingName("   ", "Kuzey Kovalak"), "Kuzey");
  assert.equal(greetingName(undefined, "Kuzey Kovalak"), "Kuzey");
  assert.equal(greetingName(7, "Kuzey"), "Kuzey");
  assert.equal(greetingName(null, null), null);
  assert.equal(greetingName("Mary Ann", ""), "Mary Ann");
  assert.equal(greeting(20, "Kuzey Kovalak", "Kuz"), "Evening, Kuz");
  assert.equal(greeting(9, "Kuzey Kovalak", ""), "Morning, Kuzey");
  assert.equal(greeting(9, null, null), "Morning");
});

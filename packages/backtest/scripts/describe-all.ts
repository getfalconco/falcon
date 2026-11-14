/** Prints describe() for the blank spec and the 12 audit strategies (a quick read of the rules text). */
import { blankSpec, describeSpec, validateSpec } from "../src/index";
import { EXPRESSIVENESS } from "../test/expressiveness";

for (const e of [{ id: "blank", spec: blankSpec() }, ...EXPRESSIVENESS]) {
  const c = validateSpec(e.spec);
  if (!c.ok) {
    console.log(`${e.id}: ${c.issues.map((i) => i.message).join("; ")}`);
    continue;
  }
  console.log(`[${e.id}]\n${describeSpec(c.spec, c.uses).rules.join("\n")}\n`);
}

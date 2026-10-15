import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  chooseDataRoot,
  copyDataFolder,
  DATA_FOLDER_NAME,
  DataMoveError,
  dataLocationFile,
  isInside,
  planDataMove,
  readDataLocation,
  samePath,
  writeDataLocation,
} from "./data-location";

function temp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "falcon-datamove-"));
}

/** A small data folder shaped like the real one: nested stores, a binary file, an empty folder. */
function seed(root: string): void {
  fs.mkdirSync(path.join(root, "system"), { recursive: true });
  fs.mkdirSync(path.join(root, "research", "sec"), { recursive: true });
  fs.mkdirSync(path.join(root, "events"), { recursive: true });
  fs.mkdirSync(path.join(root, "empty-store"), { recursive: true });
  fs.writeFileSync(path.join(root, "graph.json"), JSON.stringify({ nodes: [1, 2, 3] }));
  fs.writeFileSync(path.join(root, "system", "settings.json"), JSON.stringify({ trayEnabled: true }));
  fs.writeFileSync(path.join(root, "research", "sec", "aapl.json"), "x".repeat(50_000));
  fs.writeFileSync(path.join(root, "events", "photo.bin"), Buffer.from([0, 1, 2, 255, 254]));
}

describe("data location file", () => {
  it("reads nothing until a folder is written, then the folder, and back to nothing", () => {
    const userData = temp();
    assert.equal(readDataLocation(userData), null);
    const chosen = path.join(temp(), "Falcon");
    writeDataLocation(userData, chosen);
    assert.equal(readDataLocation(userData), path.resolve(chosen));
    writeDataLocation(userData, null);
    assert.equal(readDataLocation(userData), null);
    assert.equal(fs.existsSync(dataLocationFile(userData)), false);
  });

  it("ignores a corrupt file, a relative path and a wrong type", () => {
    const userData = temp();
    for (const body of ["{", JSON.stringify({ root: "relative/dir" }), JSON.stringify({ root: 3 }), "null"]) {
      fs.writeFileSync(dataLocationFile(userData), body);
      assert.equal(readDataLocation(userData), null, body);
    }
  });
});

describe("chooseDataRoot", () => {
  const exists = (set: string[]) => (p: string) => set.includes(p);

  it("lets FALCON_DATA_ROOT win over a chosen folder and the default", () => {
    assert.deepEqual(
      chooseDataRoot({ envRoot: " /env ", customRoot: "/custom", defaultRoot: "/default", exists: exists(["/custom"]) }),
      { root: "/env", source: "env", missing: null },
    );
  });

  it("uses the chosen folder over the default when it is there", () => {
    assert.deepEqual(
      chooseDataRoot({ envRoot: "", customRoot: "/custom", defaultRoot: "/default", exists: exists(["/custom"]) }),
      { root: "/custom", source: "custom", missing: null },
    );
  });

  it("falls back to the default, and says so, when the chosen folder is gone", () => {
    assert.deepEqual(
      chooseDataRoot({ envRoot: undefined, customRoot: "/custom", defaultRoot: "/default", exists: exists([]) }),
      { root: "/default", source: "default", missing: "/custom" },
    );
    assert.deepEqual(chooseDataRoot({ envRoot: null, customRoot: null, defaultRoot: "/default" }), {
      root: "/default",
      source: "default",
      missing: null,
    });
  });
});

describe("paths", () => {
  it("compares Windows paths without case and finds what is inside what", () => {
    assert.ok(samePath("C:\\Users\\A\\Data", "c:\\users\\a\\data\\", "win32"));
    assert.ok(isInside(path.join(os.tmpdir(), "a", "b"), path.join(os.tmpdir(), "a")));
    assert.ok(!isInside(path.join(os.tmpdir(), "ab"), path.join(os.tmpdir(), "a")));
    assert.ok(!isInside(path.join(os.tmpdir(), "a"), path.join(os.tmpdir(), "a", "b")));
  });
});

describe("planDataMove", () => {
  it("uses an empty or new folder as it is, and a Falcon folder inside one that has files", () => {
    const current = temp();
    seed(current);
    const empty = temp();
    assert.deepEqual(planDataMove(current, empty), { ok: true, target: path.resolve(empty) });
    const fresh = path.join(temp(), "new-place");
    assert.deepEqual(planDataMove(current, fresh), { ok: true, target: path.resolve(fresh) });
    const busy = temp();
    fs.writeFileSync(path.join(busy, "notes.txt"), "mine");
    assert.deepEqual(planDataMove(current, busy), { ok: true, target: path.join(path.resolve(busy), DATA_FOLDER_NAME) });
  });

  it("refuses the folder in use, a folder inside it, and a Falcon folder that already has files", () => {
    const current = temp();
    seed(current);
    assert.deepEqual(planDataMove(current, current), { ok: false, problem: "same-folder" });
    assert.deepEqual(planDataMove(current, path.join(current, "research")), { ok: false, problem: "inside-current" });
    const busy = temp();
    fs.writeFileSync(path.join(busy, "notes.txt"), "mine");
    fs.mkdirSync(path.join(busy, DATA_FOLDER_NAME));
    fs.writeFileSync(path.join(busy, DATA_FOLDER_NAME, "graph.json"), "{}");
    assert.deepEqual(planDataMove(current, busy), { ok: false, problem: "not-empty" });
    // Picking the parent of a folder already called Falcon is the same folder.
    const parent = temp();
    const inUse = path.join(parent, DATA_FOLDER_NAME);
    seed(inUse);
    assert.deepEqual(planDataMove(inUse, parent), { ok: false, problem: "same-folder" });
  });
});

describe("copyDataFolder", () => {
  it("copies every file and folder intact and leaves the source untouched", async () => {
    const from = temp();
    seed(from);
    const before = fs.readFileSync(path.join(from, "research", "sec", "aapl.json"), "utf8");
    const to = path.join(temp(), "moved");
    const result = await copyDataFolder(from, to);
    assert.equal(result.files, 4);
    assert.equal(fs.readFileSync(path.join(to, "research", "sec", "aapl.json"), "utf8"), before);
    assert.deepEqual([...fs.readFileSync(path.join(to, "events", "photo.bin"))], [0, 1, 2, 255, 254]);
    assert.ok(fs.statSync(path.join(to, "empty-store")).isDirectory());
    assert.equal(fs.readFileSync(path.join(from, "research", "sec", "aapl.json"), "utf8"), before);
    assert.ok(!fs.readdirSync(to).some((name) => name.startsWith(".falcon-write-test")));
  });

  it("copies into an empty folder that already exists", async () => {
    const from = temp();
    seed(from);
    const to = temp();
    await copyDataFolder(from, to);
    assert.ok(fs.existsSync(path.join(to, "graph.json")));
  });

  it("refuses a folder with files in it and leaves it alone", async () => {
    const from = temp();
    seed(from);
    const to = temp();
    fs.writeFileSync(path.join(to, "keep.txt"), "mine");
    await assert.rejects(
      copyDataFolder(from, to),
      (err: unknown) => err instanceof DataMoveError && err.problem === "not-empty",
    );
    assert.deepEqual(fs.readdirSync(to), ["keep.txt"]);
  });

  it("removes what it made when the copy fails, and the source stays as it was", async () => {
    const from = temp();
    seed(from);
    const to = path.join(temp(), "moved");
    // A source that is a file, not a folder: listing it fails.
    const broken = path.join(temp(), "not-a-folder");
    fs.writeFileSync(broken, "x");
    await assert.rejects(
      copyDataFolder(broken, to),
      (err: unknown) => err instanceof DataMoveError && err.problem === "copy-failed",
    );
    assert.equal(fs.existsSync(to), false);
    assert.ok(fs.existsSync(path.join(from, "graph.json")));
  });

  it("empties a folder it was given back to how it was found when the copy fails", async () => {
    const to = temp();
    const broken = path.join(temp(), "not-a-folder");
    fs.writeFileSync(broken, "x");
    await assert.rejects(copyDataFolder(broken, to));
    assert.ok(fs.existsSync(to));
    assert.deepEqual(fs.readdirSync(to), []);
  });
});

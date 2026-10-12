import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const fixturesDir = join(process.cwd(), "test", "fixtures", "omo-tools");

test("OmO tool fixtures are parseable and retain tool-result fields", () => {
  assert.ok(existsSync(fixturesDir), "run contrib/omo-fixtures.ts before the fixture test");
  const files = readdirSync(fixturesDir).filter((file) => file.endsWith(".json"));
  assert.ok(files.length > 0, "expected generated fixture files");

  for (const file of files) {
    const data = JSON.parse(readFileSync(join(fixturesDir, file), "utf8")) as Record<string, unknown>;
    if (file === "todo-state.json") {
      assert.ok(Array.isArray(data.entries));
      continue;
    }
    assert.equal(typeof data.tool, "string");
    assert.ok(Array.isArray(data.samples));
    for (const sample of data.samples as Array<Record<string, unknown>>) {
      assert.ok("arguments" in sample);
      assert.ok("content" in sample);
      assert.ok("details" in sample);
      assert.equal(typeof sample.isError, "boolean");
    }
  }
});

for (const tool of ["read", "write", "edit", "todo", "task"]) {
  test(`${tool} fixture has expected wrapper keys`, () => {
    const data = JSON.parse(readFileSync(join(fixturesDir, `${tool}.json`), "utf8")) as Record<string, unknown>;
    assert.equal(data.tool, tool);
    assert.ok(Array.isArray(data.samples) && data.samples.length > 0);
    for (const sample of data.samples as Array<Record<string, unknown>>) {
      assert.ok("arguments" in sample);
      assert.ok("content" in sample);
      assert.ok("details" in sample);
      assert.equal(typeof sample.isError, "boolean");
    }
  });
}

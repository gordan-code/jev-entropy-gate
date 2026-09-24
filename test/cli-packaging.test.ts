import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const testDir = dirname(fileURLToPath(import.meta.url));
const wrapperPath = join(testDir, "..", "bin", "jevg.mjs");

test("CLI wrapper imports the built ESM entry and forwards its exit code", () => {
  const wrapper = readFileSync(wrapperPath, "utf8");

  assert.match(wrapper, /import\s*\{\s*main\s*\}\s*from\s*["']\.\.\/dist\/index\.js["']/);
  assert.match(wrapper, /main\(process\.argv\.slice\(2\)\)/);
  assert.match(wrapper, /process\.exitCode\s*=\s*code/);
  assert.doesNotMatch(wrapper, /src\/index\.ts/);
  assert.doesNotMatch(wrapper, /--experimental-strip-types/);
});

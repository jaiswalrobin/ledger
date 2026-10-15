import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import * as prettier from "prettier";

const root = fileURLToPath(new URL("..", import.meta.url));

// Enforced through `npm test` so CI checks it without a workflow change. Fix with `npm run format`.
it("tracked files are formatted with Prettier", async () => {
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const unformatted: string[] = [];
  for (const file of files) {
    const filepath = `${root}${file}`;
    const info = await prettier.getFileInfo(filepath, {
      ignorePath: `${root}.prettierignore`,
    });
    if (info.ignored || !info.inferredParser) continue;
    const options = { ...(await prettier.resolveConfig(filepath)), filepath };
    if (!(await prettier.check(await readFile(filepath, "utf8"), options)))
      unformatted.push(file);
  }
  assert.deepEqual(unformatted, [], "run `npm run format`");
});

import { execFileSync } from "node:child_process";
import { readFile, mkdtemp, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEml } from "../src/ingestion/eml.ts";
import { previewExtraction } from "../src/ingestion/preview.ts";
import type {
  ExtractedSignal,
  ParsedMessage,
} from "../src/ingestion/source.ts";

const [file, flag, ref] = process.argv.slice(2);
if (
  !file ||
  (flag && flag !== "--baseline-ref") ||
  (flag && !ref) ||
  process.argv.length > 5
) {
  console.error(
    "Usage: npm run preview:parser -- original.eml [--baseline-ref COMMIT]",
  );
  process.exitCode = 1;
} else {
  let worktree: string | null = null;
  try {
    let baseline:
      | { version: string; extract(message: ParsedMessage): ExtractedSignal }
      | undefined;
    if (ref) {
      const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf8",
      }).trim();
      const commit = execFileSync(
        "git",
        ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
        { encoding: "utf8" },
      ).trim();
      worktree = await mkdtemp(join(tmpdir(), "ledger-parser-preview-"));
      execFileSync("git", ["worktree", "add", "--detach", worktree, commit], {
        cwd: root,
        stdio: "ignore",
      });
      await symlink(
        join(root, "node_modules"),
        join(worktree, "node_modules"),
        "dir",
      );
      const module = await import(
        pathToFileURL(join(worktree, "src/ingestion/extract.ts")).href
      );
      baseline = {
        version: module.EXTRACTOR_VERSION,
        extract: module.extractSignal,
      };
    }
    const originals = await parseEml(await readFile(file));
    console.log(
      JSON.stringify(
        originals.map((original) =>
          previewExtraction(original.message, baseline),
        ),
        null,
        2,
      ),
    );
  } catch {
    console.error(
      "PREVIEW_FAILED: check the original file and baseline commit.",
    );
    process.exitCode = 1;
  } finally {
    if (worktree) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", worktree], {
          stdio: "ignore",
        });
      } catch {
        await rm(worktree, { recursive: true, force: true });
      }
    }
  }
}

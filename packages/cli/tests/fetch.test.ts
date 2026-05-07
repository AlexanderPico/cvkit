import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "packages/cli/dist/cli.js");
const tempDirs: string[] = [];

function makeTempCvDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cvkit-cli-test-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "cv.json"), JSON.stringify({ basics: { name: "Test User" } }, null, 2));
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

beforeAll(() => {
  execFileSync("pnpm", ["build"], { cwd: repoRoot, stdio: "pipe" });
});

describe("cvkit fetch", () => {
  it("exits non-zero when a selected source fails", () => {
    const dir = makeTempCvDir();
    const missingPdf = join(dir, "missing-linkedin.pdf");

    const result = spawnSync("node", [cliEntry, "--dir", dir, "fetch", "--linkedin-pdf", missingPdf], {
      cwd: repoRoot,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("File not found");
    expect(result.stdout).not.toContain("Done. cv.json written");
  });
});

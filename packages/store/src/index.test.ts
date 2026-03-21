/**
 * Tests for @cvkit/store
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CVStore, deepMerge, createStore } from "./index.js";
import type { CVData } from "@cvkit/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cvkit-test-"));
}

// ---------------------------------------------------------------------------
// deepMerge
// ---------------------------------------------------------------------------

describe("deepMerge", () => {
  it("merges scalar fields — source wins", () => {
    const result = deepMerge(
      { basics: { name: "Old Name" } } as Record<string, unknown>,
      { basics: { name: "New Name" } } as Record<string, unknown>,
    );
    expect((result as CVData).basics?.name).toBe("New Name");
  });

  it("merges nested objects without losing target keys", () => {
    const result = deepMerge(
      { basics: { name: "Alex", email: "alex@example.com" } } as Record<string, unknown>,
      { basics: { name: "Alexander" } } as Record<string, unknown>,
    );
    const cv = result as CVData;
    expect(cv.basics?.name).toBe("Alexander");
    expect(cv.basics?.email).toBe("alex@example.com");
  });

  it("appends new array items without duplicating by title", () => {
    const result = deepMerge(
      {
        publications: [{ title: "Paper A", year: 2020 }],
      } as Record<string, unknown>,
      {
        publications: [{ title: "Paper B", year: 2021 }, { title: "Paper A", year: 2020 }],
      } as Record<string, unknown>,
    );
    const cv = result as CVData;
    expect(cv.publications).toHaveLength(2);
  });

  it("appends new array items when no duplicates exist", () => {
    const result = deepMerge(
      { publications: [{ title: "Paper A" }] } as Record<string, unknown>,
      { publications: [{ title: "Paper B" }] } as Record<string, unknown>,
    );
    const cv = result as CVData;
    expect(cv.publications).toHaveLength(2);
  });

  it("deduplicates by DOI", () => {
    const result = deepMerge(
      { publications: [{ title: "Paper A", doi: "10.1000/xyz" }] } as Record<string, unknown>,
      { publications: [{ title: "Paper A (updated)", doi: "10.1000/xyz" }] } as Record<string, unknown>,
    );
    const cv = result as CVData;
    // DOI match = not appended (target item preserved)
    expect(cv.publications).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// CVStore
// ---------------------------------------------------------------------------

describe("CVStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("init creates a cv.json with empty basics", async () => {
    const store = new CVStore({ dir });
    const cv = await store.init();
    expect(fs.existsSync(store.cvPath)).toBe(true);
    expect(cv.basics).toBeDefined();
    expect(cv.$schema).toBeDefined();
  });

  it("init does not overwrite existing cv.json by default", async () => {
    const store = new CVStore({ dir });
    await store.init();
    // Manually write name
    const saved = await store.loadRaw();
    if (saved.basics) saved.basics.name = "Custom Name";
    await store.save(saved);
    // Re-init without overwrite
    await store.init(false);
    const reloaded = await store.loadRaw();
    expect(reloaded.basics?.name).toBe("Custom Name");
  });

  it("init overwrites when overwrite=true", async () => {
    const store = new CVStore({ dir });
    await store.init();
    const saved = await store.loadRaw();
    if (saved.basics) saved.basics.name = "Custom Name";
    await store.save(saved);
    await store.init(true);
    const reloaded = await store.loadRaw();
    expect(reloaded.basics?.name).toBe("");
  });

  it("save and loadRaw round-trips JSON correctly", async () => {
    const store = new CVStore({ dir });
    const data: CVData = {
      basics: { name: "Alex Pico", orcidId: "0000-0001-5944-9960" },
      publications: [{ title: "Paper 1", year: 2023, doi: "10.1000/test" }],
    };
    await store.save(data);
    const loaded = await store.loadRaw();
    expect(loaded.basics?.name).toBe("Alex Pico");
    expect(loaded.publications).toHaveLength(1);
    expect(loaded.publications?.[0]?.doi).toBe("10.1000/test");
  });

  it("load applies overrides on top of cv.json", async () => {
    const store = new CVStore({ dir });
    await store.save({ basics: { name: "Generated Name" }, publications: [] });
    // Write overrides file
    fs.writeFileSync(
      store.overridesPath,
      JSON.stringify({ basics: { name: "Override Name", label: "Professor" } }),
    );
    const loaded = await store.load();
    expect(loaded.basics?.name).toBe("Override Name");
    expect(loaded.basics?.label).toBe("Professor");
  });

  it("merge writes merged data to disk and returns it", async () => {
    const store = new CVStore({ dir });
    await store.init();
    const merged = await store.merge({
      basics: { name: "Alex Pico" },
      publications: [{ title: "First Paper", year: 2024 }],
    });
    expect(merged.basics?.name).toBe("Alex Pico");
    expect(merged.publications).toHaveLength(1);

    // Disk should be updated
    const onDisk = await store.loadRaw();
    expect(onDisk.basics?.name).toBe("Alex Pico");
  });

  it("diff detects array length changes", () => {
    const store = new CVStore({ dir });
    const before: CVData = { basics: { name: "Alex" }, publications: [{ title: "A" }] };
    const after: CVData = { basics: { name: "Alex" }, publications: [{ title: "A" }, { title: "B" }] };
    const summary = store.diff(before, after);
    expect(summary.hasChanges).toBe(true);
    const pubChange = summary.changes.find((c) => c.field === "publications");
    expect(pubChange?.delta).toBe(1);
  });

  it("diff detects scalar changes", () => {
    const store = new CVStore({ dir });
    const before: CVData = { basics: { name: "Alex" } };
    const after: CVData = { basics: { name: "Alexander" } };
    const summary = store.diff(before, after);
    expect(summary.hasChanges).toBe(true);
  });

  it("diff returns no changes when identical", () => {
    const store = new CVStore({ dir });
    const cv: CVData = { basics: { name: "Alex" }, publications: [] };
    const summary = store.diff(cv, { ...cv });
    expect(summary.hasChanges).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createStore factory
// ---------------------------------------------------------------------------

describe("createStore", () => {
  it("creates a CVStore with the given directory", () => {
    const dir = tmpDir();
    const store = createStore(dir);
    expect(store.cvPath).toContain(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("uses cwd when no directory given", () => {
    const store = createStore();
    expect(store.cvPath).toBeTruthy();
  });
});

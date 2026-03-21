/**
 * @cvkit/store
 *
 * Versioned cv.json store with a manual override layer.
 *
 * Architecture:
 *   - `cv.json`          — the canonical, auto-generated document (written by `cvkit fetch`)
 *   - `cv.overrides.json` — manual edits that survive re-ingestion (never overwritten by fetchers)
 *
 * On load, overrides are deep-merged on top of the generated data so hand-crafted entries
 * (e.g. a corrected publication title, a grant that isn't in ORCID) are always preserved.
 *
 * On save, only the generated portion is written back to `cv.json`; overrides stay untouched.
 */

import fs from "node:fs";
import path from "node:path";
import type { CVData, IngestResult } from "@cvkit/schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current schema version written into new cv.json files */
export const SCHEMA_VERSION = "0.1.0";

/** Default filenames */
export const CV_FILENAME = "cv.json";
export const OVERRIDES_FILENAME = "cv.overrides.json";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deep-merge `source` into `target`, returning a new object.
 * Arrays are concatenated and de-duplicated by a `title` or `name` key when present.
 * Scalar values from `source` overwrite `target`.
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target } as Record<string, unknown>;

  for (const key of Object.keys(source) as Array<keyof T>) {
    const srcVal = source[key];
    const tgtVal = target[key];

    if (srcVal === undefined) continue;

    if (Array.isArray(srcVal) && Array.isArray(tgtVal)) {
      // Merge arrays: start with target items, then append source items that
      // don't already appear (matched by title/name/doi).
      const merged = [...tgtVal];
      for (const srcItem of srcVal) {
        const isDuplicate = merged.some((tgtItem) => {
          if (typeof tgtItem !== "object" || typeof srcItem !== "object") return false;
          const t = tgtItem as Record<string, unknown>;
          const s = srcItem as Record<string, unknown>;
          return (
            (s["doi"] && t["doi"] === s["doi"]) ||
            (s["title"] && t["title"] === s["title"]) ||
            (s["name"] && t["name"] === s["name"])
          );
        });
        if (!isDuplicate) merged.push(srcItem);
      }
      result[key as string] = merged;
    } else if (
      typeof srcVal === "object" &&
      srcVal !== null &&
      typeof tgtVal === "object" &&
      tgtVal !== null &&
      !Array.isArray(srcVal)
    ) {
      result[key as string] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      result[key as string] = srcVal;
    }
  }

  return result as T;
}

// ---------------------------------------------------------------------------
// Store class
// ---------------------------------------------------------------------------

/**
 * Options for constructing a Store instance.
 */
export interface StoreOptions {
  /**
   * Directory where `cv.json` and `cv.overrides.json` live.
   * Defaults to `process.cwd()`.
   */
  dir?: string;
}

/**
 * CVStore — manages reading, merging, and writing cv.json.
 *
 * @example
 * ```ts
 * const store = new CVStore({ dir: "~/.cvkit" });
 * const cv = await store.load();
 * cv.citationMetrics = { hIndex: 25 };
 * await store.save(cv);
 * ```
 */
export class CVStore {
  private readonly dir: string;

  constructor(options: StoreOptions = {}) {
    this.dir = path.resolve(options.dir ?? process.cwd());
  }

  /** Absolute path to the generated cv.json file */
  get cvPath(): string {
    return path.join(this.dir, CV_FILENAME);
  }

  /** Absolute path to the manual overrides file */
  get overridesPath(): string {
    return path.join(this.dir, OVERRIDES_FILENAME);
  }

  /**
   * Load cv.json from disk and apply overrides on top.
   * Returns an empty CVData if cv.json does not exist yet.
   */
  async load(): Promise<CVData> {
    const base = await this.loadRaw();
    const overrides = await this.loadOverrides();
    if (Object.keys(overrides).length === 0) return base;
    return deepMerge(base as Record<string, unknown>, overrides as Record<string, unknown>) as CVData;
  }

  /**
   * Load only the raw cv.json, without merging overrides.
   * Useful for diffing what would change after a fetch.
   */
  async loadRaw(): Promise<CVData> {
    if (!fs.existsSync(this.cvPath)) {
      return this.empty();
    }
    const text = await fs.promises.readFile(this.cvPath, "utf-8");
    return JSON.parse(text) as CVData;
  }

  /**
   * Load the overrides file, or return an empty object if it doesn't exist.
   */
  async loadOverrides(): Promise<Partial<CVData>> {
    if (!fs.existsSync(this.overridesPath)) return {};
    const text = await fs.promises.readFile(this.overridesPath, "utf-8");
    return JSON.parse(text) as Partial<CVData>;
  }

  /**
   * Write cv.json to disk (pretty-printed, sorted keys for stable diffs).
   * The overrides file is never touched.
   */
  async save(data: CVData): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const json = JSON.stringify(data, null, 2) + "\n";
    await fs.promises.writeFile(this.cvPath, json, "utf-8");
  }

  /**
   * Merge an ingester result into the current cv.json and save.
   *
   * The merge order is: existing cv.json ← ingested data ← overrides.
   * This ensures:
   *   1. New ingested fields are applied on top of what's on disk.
   *   2. Manual overrides always win.
   *
   * @param ingested - Partial CVData from an ingester
   * @returns The merged CVData that was written to disk
   */
  async merge(ingested: IngestResult): Promise<CVData> {
    const raw = await this.loadRaw();
    const merged = deepMerge(raw as Record<string, unknown>, ingested as Record<string, unknown>) as CVData;
    await this.save(merged);
    return merged;
  }

  /**
   * Initialize a fresh cv.json if one does not already exist.
   *
   * @param overwrite - If true, overwrite even if a file exists.
   */
  async init(overwrite = false): Promise<CVData> {
    if (!overwrite && fs.existsSync(this.cvPath)) {
      return this.load();
    }
    const empty = this.empty();
    await this.save(empty);
    return empty;
  }

  /**
   * Compare two CVData objects and return a shallow diff summary.
   * Useful for the `cvkit diff` command.
   */
  diff(before: CVData, after: CVData): DiffSummary {
    const changes: DiffEntry[] = [];

    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof CVData>) {
      const bVal = before[key];
      const aVal = after[key];

      if (JSON.stringify(bVal) === JSON.stringify(aVal)) continue;

      if (Array.isArray(bVal) && Array.isArray(aVal)) {
        changes.push({
          field: key as string,
          type: "array",
          before: bVal.length,
          after: aVal.length,
          delta: aVal.length - bVal.length,
        });
      } else if (typeof bVal === "object" || typeof aVal === "object") {
        changes.push({ field: key as string, type: "object" });
      } else {
        changes.push({ field: key as string, type: "scalar", before: bVal, after: aVal });
      }
    }

    return { changes, hasChanges: changes.length > 0 };
  }

  /** Return an empty CVData skeleton */
  private empty(): CVData {
    return {
      $schema: `https://github.com/AlexanderPico/cvkit/blob/main/packages/schema/src/index.ts@${SCHEMA_VERSION}`,
      basics: { name: "" },
      publications: [],
      grants: [],
      software: [],
      fetchMeta: {},
    };
  }
}

// ---------------------------------------------------------------------------
// Diff types
// ---------------------------------------------------------------------------

/** A single field-level difference between two CVData snapshots */
export interface DiffEntry {
  field: string;
  type: "scalar" | "array" | "object";
  before?: unknown;
  after?: unknown;
  /** Only for arrays: after.length - before.length */
  delta?: number;
}

/** Summary returned by CVStore.diff() */
export interface DiffSummary {
  changes: DiffEntry[];
  hasChanges: boolean;
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

/**
 * Create a CVStore instance for the given directory.
 * Alias for `new CVStore({ dir })`.
 */
export function createStore(dir?: string): CVStore {
  return dir !== undefined ? new CVStore({ dir }) : new CVStore();
}

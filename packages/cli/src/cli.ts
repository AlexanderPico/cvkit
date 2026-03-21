/**
 * cvkit — Academic CV management CLI
 *
 * Commands:
 *   fetch    Pull data from one or all sources into cv.json
 *   validate Check cv.json against the CVData schema
 *   diff     Show what changed since the last fetch
 *   build    Render cv.json to a target format (JSON, markdown summary)
 *   serve    Start a local dev server previewing the CV
 *   init     Initialize a new cv.json in the current directory
 *
 * @example
 * ```sh
 * cvkit fetch --orcid 0000-0001-5944-9960
 * cvkit fetch --all --github AlexanderPico
 * cvkit validate
 * cvkit diff
 * cvkit build --format markdown
 * ```
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import {
  GitHubIngester,
  LinkedInPdfIngester,
  OrcidIngester,
  SemanticScholarIngester,
} from "@cvkit/ingesters";
import type { CVData } from "@cvkit/schema";
import { CVStore, createStore } from "@cvkit/store";

// ---------------------------------------------------------------------------
// Version — read from package.json
// ---------------------------------------------------------------------------

const pkgPath = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };

// ---------------------------------------------------------------------------
// Program setup
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("cvkit")
  .version(pkg.version)
  .description("Academic CV management CLI — fetch from ORCID, GitHub, Semantic Scholar")
  .option("-d, --dir <path>", "Directory containing cv.json (default: cwd)", process.cwd());

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

program
  .command("init")
  .description("Initialize a new cv.json in the target directory")
  .option("--overwrite", "Overwrite existing cv.json", false)
  .action(async (opts: { overwrite: boolean }) => {
    const dir = program.opts<{ dir: string }>().dir;
    const store = createStore(dir);
    const cv = await store.init(opts.overwrite);
    console.log(`✓ Initialized cv.json at ${store.cvPath}`);
    console.log(`  Name: ${cv.basics?.name || "(empty — edit cv.json to fill in your details)"}`);
  });

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

program
  .command("fetch")
  .description("Pull data from one or more sources into cv.json")
  .option("--orcid <id>", "ORCID iD to fetch (e.g. 0000-0001-5944-9960)")
  .option("--s2-orcid <id>", "Look up Semantic Scholar by ORCID iD")
  .option("--s2-author <id>", "Semantic Scholar author ID (precise)")
  .option("--s2-name <name>", "Semantic Scholar author name search")
  .option("--s2-key <key>", "Semantic Scholar API key (or set S2_API_KEY env var)")
  .option("--github <username>", "GitHub username to fetch repos from")
  .option("--github-token <token>", "GitHub PAT (or set GITHUB_TOKEN env var)")
  .option("--linkedin-pdf <path>", "Path to LinkedIn profile PDF export")
  .option("--all", "Run all configured sources (reads source config from cv.json)", false)
  .action(async (opts: {
    orcid?: string;
    s2Orcid?: string;
    s2Author?: string;
    s2Name?: string;
    s2Key?: string;
    github?: string;
    githubToken?: string;
    linkedinPdf?: string;
    all: boolean;
  }) => {
    const dir = program.opts<{ dir: string }>().dir;
    const store = createStore(dir);
    let cv = await store.load();

    // Determine which sources to run
    const runs: Array<() => Promise<void>> = [];

    // ORCID
    const orcidId = opts.orcid ?? (opts.all ? cv.basics?.orcidId : undefined);
    if (orcidId) {
      runs.push(async () => {
        process.stdout.write(`→ Fetching ORCID ${orcidId}... `);
        const ingester = new OrcidIngester();
        const resp = await ingester.ingest(orcidId);
        if (resp.ok && resp.data) {
          cv = await store.merge(resp.data);
          console.log(`✓ (${resp.data.publications?.length ?? 0} publications, ${resp.data.work?.length ?? 0} positions)`);
        } else {
          console.error(`✗ ${resp.error}`);
        }
      });
    }

    // Semantic Scholar
    const s2Key = opts.s2Key ?? process.env["S2_API_KEY"];
    if (opts.s2Orcid ?? opts.s2Author ?? opts.s2Name) {
      runs.push(async () => {
        const ingester = new SemanticScholarIngester(s2Key ? { apiKey: s2Key } : {});
        if (opts.s2Author) {
          process.stdout.write(`→ Fetching Semantic Scholar author ${opts.s2Author}... `);
          const resp = await ingester.ingestByAuthorId(opts.s2Author);
          handleS2Response(resp, cv, store);
          cv = await store.load();
        } else if (opts.s2Orcid) {
          process.stdout.write(`→ Fetching Semantic Scholar by ORCID ${opts.s2Orcid}... `);
          const resp = await ingester.ingestByOrcid(opts.s2Orcid);
          await handleS2Response(resp, cv, store);
          cv = await store.load();
        } else if (opts.s2Name) {
          process.stdout.write(`→ Fetching Semantic Scholar for "${opts.s2Name}"... `);
          const resp = await ingester.ingestByName(opts.s2Name);
          await handleS2Response(resp, cv, store);
          cv = await store.load();
        }
      });
    }

    // GitHub
    const ghToken = opts.githubToken ?? process.env["GITHUB_TOKEN"];
    const ghUser = opts.github ?? (opts.all ? extractGitHubUsername(cv) : undefined);
    if (ghUser) {
      runs.push(async () => {
        process.stdout.write(`→ Fetching GitHub repos for ${ghUser}... `);
        const ingester = new GitHubIngester(ghToken ? { token: ghToken } : {});
        const resp = await ingester.ingest(ghUser);
        if (resp.ok && resp.data) {
          cv = await store.merge(resp.data);
          console.log(`✓ (${resp.data.software?.length ?? 0} repos)`);
        } else {
          console.error(`✗ ${resp.error}`);
        }
      });
    }

    // LinkedIn PDF
    if (opts.linkedinPdf) {
      runs.push(async () => {
        const absPath = resolve(opts.linkedinPdf as string);
        process.stdout.write(`→ Parsing LinkedIn PDF ${absPath}... `);
        const ingester = new LinkedInPdfIngester();
        const resp = await ingester.ingest(absPath);
        if (resp.ok && resp.data) {
          cv = await store.merge(resp.data);
          console.log(`✓ (${resp.data.work?.length ?? 0} positions, ${resp.data.education?.length ?? 0} education)`);
        } else {
          console.error(`✗ ${resp.error}`);
        }
      });
    }

    if (runs.length === 0) {
      console.error("No sources specified. Use --orcid, --github, --s2-*, --linkedin-pdf, or --all.");
      console.error("Run `cvkit fetch --help` for usage.");
      process.exit(1);
    }

    for (const run of runs) {
      await run();
    }

    console.log(`\nDone. cv.json written to ${store.cvPath}`);
  });

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

program
  .command("validate")
  .description("Validate cv.json against the CVData schema")
  .action(async () => {
    const dir = program.opts<{ dir: string }>().dir;
    const store = createStore(dir);

    try {
      const cv = await store.load();
      const errors = validateCVData(cv);
      if (errors.length === 0) {
        console.log(`✓ cv.json is valid`);
        console.log(`  Name: ${cv.basics?.name || "(no name)"}`);
        console.log(`  Publications: ${cv.publications?.length ?? 0}`);
        console.log(`  Software: ${cv.software?.length ?? 0}`);
        console.log(`  Grants: ${cv.grants?.length ?? 0}`);
        if (cv.citationMetrics?.hIndex !== undefined) {
          console.log(`  h-index: ${cv.citationMetrics.hIndex}`);
        }
      } else {
        console.error(`✗ Validation errors in ${store.cvPath}:`);
        for (const err of errors) {
          console.error(`  - ${err}`);
        }
        process.exit(1);
      }
    } catch (err) {
      console.error(`✗ Failed to load cv.json: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

program
  .command("diff")
  .description("Show what has changed between the stored cv.json and a fresh fetch (dry-run)")
  .option("--orcid <id>", "ORCID iD to compare against")
  .action(async (opts: { orcid?: string }) => {
    const dir = program.opts<{ dir: string }>().dir;
    const store = createStore(dir);
    const before = await store.loadRaw();

    if (!opts.orcid && !before.basics?.orcidId) {
      console.error("Provide --orcid <id> or set orcidId in cv.json basics.");
      process.exit(1);
    }

    const orcidId = opts.orcid ?? before.basics?.orcidId as string;
    process.stdout.write(`→ Fetching ORCID ${orcidId} for comparison... `);
    const ingester = new OrcidIngester();
    const resp = await ingester.ingest(orcidId);
    if (!resp.ok || !resp.data) {
      console.error(`✗ ${resp.error}`);
      process.exit(1);
    }
    console.log("done");

    // Simulate merge without writing to disk
    const { deepMerge } = await import("@cvkit/store");
    const after = deepMerge(before as Record<string, unknown>, resp.data as Record<string, unknown>) as CVData;
    const summary = store.diff(before, after);

    if (!summary.hasChanges) {
      console.log("No changes detected.");
      return;
    }

    console.log("\nChanges:");
    for (const change of summary.changes) {
      if (change.type === "array") {
        const delta = change.delta ?? 0;
        const sign = delta >= 0 ? "+" : "";
        console.log(`  ${change.field}: ${change.before} → ${change.after} items (${sign}${delta})`);
      } else if (change.type === "scalar") {
        console.log(`  ${change.field}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`);
      } else {
        console.log(`  ${change.field}: (object changed)`);
      }
    }
  });

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

program
  .command("build")
  .description("Render cv.json to a target format")
  .option("--format <fmt>", "Output format: json | markdown | text", "json")
  .option("-o, --output <file>", "Output file path (default: stdout)")
  .action(async (opts: { format: string; output?: string }) => {
    const dir = program.opts<{ dir: string }>().dir;
    const store = createStore(dir);
    const cv = await store.load();

    let output: string;
    switch (opts.format) {
      case "json":
        output = JSON.stringify(cv, null, 2);
        break;
      case "markdown":
        output = renderMarkdown(cv);
        break;
      case "text":
        output = renderText(cv);
        break;
      default:
        console.error(`Unknown format: ${opts.format}. Choose json, markdown, or text.`);
        process.exit(1);
    }

    if (opts.output) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(opts.output, output, "utf-8");
      console.log(`✓ Written to ${opts.output}`);
    } else {
      process.stdout.write(output + "\n");
    }
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function handleS2Response(
  resp: Awaited<ReturnType<SemanticScholarIngester["ingestByAuthorId"]>>,
  _cv: CVData,
  store: CVStore,
): Promise<void> {
  if (resp.ok && resp.data) {
    await store.merge(resp.data);
    const m = resp.data.citationMetrics;
    console.log(`✓ (h-index: ${m?.hIndex ?? "?"}, ${resp.data.publications?.length ?? 0} papers)`);
  } else {
    console.error(`✗ ${resp.error}`);
  }
}

/** Extract GitHub username from cv.json basics.profiles */
function extractGitHubUsername(cv: CVData): string | undefined {
  return cv.basics?.profiles?.find(
    (p) => p.network?.toLowerCase() === "github",
  )?.username;
}

/**
 * Basic structural validation of a CVData object.
 * Returns an array of error messages; empty = valid.
 */
function validateCVData(cv: CVData): string[] {
  const errors: string[] = [];
  if (!cv.basics?.name) errors.push("basics.name is required");
  if (cv.publications) {
    for (let i = 0; i < cv.publications.length; i++) {
      if (!cv.publications[i]?.title) {
        errors.push(`publications[${i}] is missing a title`);
      }
    }
  }
  if (cv.grants) {
    for (let i = 0; i < cv.grants.length; i++) {
      if (!cv.grants[i]?.title) {
        errors.push(`grants[${i}] is missing a title`);
      }
    }
  }
  return errors;
}

/** Render cv.json as a Markdown summary */
function renderMarkdown(cv: CVData): string {
  const lines: string[] = [];
  const b = cv.basics;

  lines.push(`# ${b?.name ?? "CV"}`);
  if (b?.label) lines.push(`\n_${b.label}_`);
  if (b?.email) lines.push(`\n**Email:** ${b.email}`);
  if (b?.url) lines.push(`**Web:** ${b.url}`);
  if (b?.orcidId) lines.push(`**ORCID:** https://orcid.org/${b.orcidId}`);

  if (b?.summary) {
    lines.push(`\n## Summary\n\n${b.summary}`);
  }

  if (cv.citationMetrics) {
    const m = cv.citationMetrics;
    lines.push("\n## Citation Metrics");
    if (m.hIndex !== undefined) lines.push(`- **h-index:** ${m.hIndex}`);
    if (m.totalCitations !== undefined) lines.push(`- **Total citations:** ${m.totalCitations}`);
    if (m.i10Index !== undefined) lines.push(`- **i10-index:** ${m.i10Index}`);
    if (m.publicationCount !== undefined) lines.push(`- **Publications indexed:** ${m.publicationCount}`);
  }

  if (cv.work?.length) {
    lines.push("\n## Experience");
    for (const w of cv.work) {
      const dates = [w.startDate, w.endDate ?? "Present"].filter(Boolean).join(" – ");
      lines.push(`\n### ${w.position ?? "Role"} at ${w.name}`);
      lines.push(`_${dates}_`);
      if (w.highlights?.length) {
        for (const h of w.highlights) lines.push(`- ${h}`);
      }
    }
  }

  if (cv.education?.length) {
    lines.push("\n## Education");
    for (const e of cv.education) {
      const dates = [e.startDate, e.endDate].filter(Boolean).join(" – ");
      lines.push(`\n### ${e.studyType ?? "Degree"} — ${e.institution}`);
      if (e.area) lines.push(`_${e.area}_`);
      if (dates) lines.push(`_${dates}_`);
    }
  }

  if (cv.publications?.length) {
    lines.push(`\n## Publications (${cv.publications.length})`);
    const sorted = [...cv.publications].sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    for (const p of sorted.slice(0, 20)) {
      const cite = p.citationCount !== undefined ? ` (cited ${p.citationCount}×)` : "";
      const doi = p.doi ? ` https://doi.org/${p.doi}` : "";
      lines.push(`\n- **${p.title}** (${p.year ?? "?"})${cite}${doi}`);
      if (p.publisher) lines.push(`  _${p.publisher}_`);
    }
    if (cv.publications.length > 20) {
      lines.push(`\n_(${cv.publications.length - 20} more not shown)_`);
    }
  }

  if (cv.software?.length) {
    lines.push(`\n## Software (${cv.software.length})`);
    const sorted = [...cv.software].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
    for (const s of sorted.slice(0, 10)) {
      const stars = s.stars !== undefined ? ` ★${s.stars}` : "";
      lines.push(`\n- **[${s.name}](${s.url ?? "#"})** — ${s.description ?? ""}${stars}`);
    }
  }

  if (cv.grants?.length) {
    lines.push(`\n## Grants (${cv.grants.length})`);
    for (const g of cv.grants) {
      lines.push(`\n- **${g.title}** (${g.funder ?? "Funder unknown"})`);
      if (g.awardNumber) lines.push(`  Award: ${g.awardNumber}`);
      const dates = [g.startDate, g.endDate].filter(Boolean).join(" – ");
      if (dates) lines.push(`  ${dates}`);
    }
  }

  return lines.join("\n");
}

/** Render a plain-text summary (for terminals) */
function renderText(cv: CVData): string {
  const b = cv.basics;
  const lines: string[] = [];
  lines.push(`=== ${b?.name ?? "CV"} ===`);
  if (b?.label) lines.push(b.label);
  if (b?.email) lines.push(`Email: ${b.email}`);
  if (b?.orcidId) lines.push(`ORCID: ${b.orcidId}`);
  lines.push("");
  if (cv.citationMetrics?.hIndex !== undefined) {
    lines.push(`h-index: ${cv.citationMetrics.hIndex}   Total citations: ${cv.citationMetrics.totalCitations ?? "?"}`);
    lines.push("");
  }
  lines.push(`Publications: ${cv.publications?.length ?? 0}`);
  lines.push(`Software: ${cv.software?.length ?? 0}`);
  lines.push(`Grants: ${cv.grants?.length ?? 0}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Parse & run
// ---------------------------------------------------------------------------

program.parse(process.argv);

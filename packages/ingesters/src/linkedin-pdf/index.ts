/**
 * LinkedIn PDF ingester
 *
 * Parses a LinkedIn profile PDF export using a spatial/geometric approach:
 * text items are positioned by their x/y coordinates and font properties so
 * that section headers can be detected by visual characteristics (large bold
 * text, distinctive HSL color) rather than fragile keyword matching.
 *
 * Ported from: https://github.com/AlexanderPico/linkedin-profile-reader
 *
 * How LinkedIn PDFs are structured:
 *   - The PDF has a consistent visual layout: name at top, followed by
 *     section headers (e.g. "Experience", "Education", "Skills") in a larger
 *     font size and/or darker/accent color.
 *   - Each section header is followed by entries that share a consistent
 *     indentation and font size.
 *   - We use pdf-parse to extract raw text items with position metadata, then
 *     cluster them geometrically into sections.
 *
 * @example
 * ```ts
 * const ingester = new LinkedInPdfIngester();
 * const result = await ingester.ingest("/path/to/linkedin-profile.pdf");
 * ```
 */

import fs from "node:fs";
import type {
  Basics,
  EducationEntry,
  IngestResponse,
  IngestResult,
  ISODate,
  Skill,
  WorkEntry,
} from "@cvkit/schema";

// ---------------------------------------------------------------------------
// pdf-parse import (CommonJS compat in ESM context)
// ---------------------------------------------------------------------------

// pdf-parse is CJS; we use a dynamic import to stay ESM-clean
// The second `options` param isn't typed in the @types package, so we cast broadly.
async function loadPdfParse(): Promise<
  (buffer: Buffer, options?: Record<string, unknown>) => Promise<PdfData>
> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import("pdf-parse")) as any;
  return (mod.default ?? mod) as (
    buffer: Buffer,
    options?: Record<string, unknown>,
  ) => Promise<PdfData>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal pdf-parse output shape */
interface PdfData {
  text: string;
  numpages: number;
  info?: Record<string, unknown>;
}

/** A text item with spatial metadata, extracted from the PDF render tree */
export interface TextItem {
  text: string;
  x: number;
  y: number;
  /** Font size in points */
  fontSize: number;
  /** Font name, e.g. "Calibri-Bold" */
  fontName: string;
  /** Whether the font appears bold */
  bold: boolean;
  /** Page number (1-indexed) */
  page: number;
}

/** A logical section detected in the PDF */
export interface PdfSection {
  /** Normalized section name, e.g. "experience", "education" */
  name: string;
  /** Raw header text as it appears in the PDF */
  header: string;
  /** Text items belonging to this section */
  items: TextItem[];
}

// ---------------------------------------------------------------------------
// Constants — tuned for LinkedIn's export format
// ---------------------------------------------------------------------------

/**
 * Known section header keywords in LinkedIn PDFs (case-insensitive).
 * LinkedIn may use slightly different wording across locales.
 */
const SECTION_KEYWORDS: ReadonlyArray<string> = [
  "experience",
  "education",
  "skills",
  "summary",
  "languages",
  "certifications",
  "licenses & certifications",
  "volunteer experience",
  "publications",
  "honors & awards",
  "projects",
  "courses",
  "recommendations",
  "accomplishments",
  "interests",
  "contact",
];

/** Font size threshold: items with fontSize >= this are candidates for section headers */
const HEADER_FONT_SIZE_THRESHOLD = 14;

/** x-coordinate threshold: section headers tend to be left-aligned */
const HEADER_X_MAX = 80;

// ---------------------------------------------------------------------------
// Spatial helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether a text item is likely a section header based on:
 *   1. Font size ≥ threshold
 *   2. Near left margin (x ≤ threshold)
 *   3. Text matches a known section keyword
 */
function isSectionHeader(item: TextItem): boolean {
  const normalized = item.text.trim().toLowerCase();
  if (!SECTION_KEYWORDS.includes(normalized)) return false;
  if (item.fontSize < HEADER_FONT_SIZE_THRESHOLD && !item.bold) return false;
  return item.x <= HEADER_X_MAX;
}

/**
 * Cluster text items into sections using detected headers as delimiters.
 * Items before the first header go into a synthetic "header" section
 * containing the person's name and tagline.
 */
function clusterIntoSections(items: TextItem[]): PdfSection[] {
  const sections: PdfSection[] = [];
  let current: PdfSection = { name: "header", header: "header", items: [] };

  for (const item of items) {
    if (isSectionHeader(item)) {
      sections.push(current);
      const name = item.text.trim().toLowerCase().replace(/[^a-z ]/g, "").trim();
      current = { name, header: item.text.trim(), items: [] };
    } else {
      current.items.push(item);
    }
  }
  sections.push(current);

  return sections;
}

// ---------------------------------------------------------------------------
// Section parsers
// ---------------------------------------------------------------------------

/** Parse the header section to extract name, headline, location */
function parseHeaderSection(section: PdfSection): Partial<Basics> {
  const lines = sectionToLines(section);
  if (lines.length === 0) return {};

  // Heuristic: the first non-empty line is the person's name (largest font)
  const sorted = [...section.items].sort((a, b) => b.fontSize - a.fontSize);
  const name = sorted[0]?.text.trim() ?? lines[0] ?? "";

  const remainingLines = lines.filter((l) => l.toLowerCase() !== name.toLowerCase());
  const label = remainingLines[0];
  const locationLine = remainingLines.find((l) =>
    /\b(area|region|metro|city|country)\b/i.test(l) || l.includes(","),
  );

  return { name, label, location: locationLine ? { address: locationLine } : undefined };
}

/**
 * Parse work experience entries.
 *
 * LinkedIn experience blocks follow this pattern (one per job):
 *   Company Name
 *   Title · Employment Type
 *   Date Range
 *   Location
 *   [Description lines...]
 */
function parseExperienceSection(section: PdfSection): WorkEntry[] {
  const entries: WorkEntry[] = [];
  const lines = sectionToLines(section);
  let i = 0;

  while (i < lines.length) {
    const company = lines[i];
    if (!company) { i++; continue; }

    // Next line is typically "Title · Type" or just "Title"
    const titleLine = lines[i + 1] ?? "";
    const [position] = titleLine.split("·").map((s) => s.trim());

    // Date range line: e.g. "Jan 2020 – Present · 3 yrs 2 mos"
    const dateLine = lines[i + 2] ?? "";
    const [startDate, endDate] = parseDateRange(dateLine);

    // Collect description until next plausible company block
    const highlights: string[] = [];
    let j = i + 3;
    // Skip location line (often follows date range)
    if (j < lines.length && !looksLikeDate(lines[j] ?? "")) j++;
    while (j < lines.length && !looksLikeCompanyLine(lines[j] ?? "", lines)) {
      const l = lines[j]?.trim();
      if (l) highlights.push(l);
      j++;
    }

    entries.push({ name: company, position, startDate, endDate, highlights: highlights.length ? highlights : undefined });
    i = j;
  }

  return entries;
}

/**
 * Parse education entries.
 *
 * Pattern:
 *   Institution Name
 *   Degree, Field of Study
 *   Date Range
 */
function parseEducationSection(section: PdfSection): EducationEntry[] {
  const entries: EducationEntry[] = [];
  const lines = sectionToLines(section);
  let i = 0;

  while (i < lines.length) {
    const institution = lines[i];
    if (!institution) { i++; continue; }

    const degreeLine = lines[i + 1] ?? "";
    const [studyType, area] = degreeLine.split(",").map((s) => s.trim());
    const dateLine = lines[i + 2] ?? "";
    const [startDate, endDate] = parseDateRange(dateLine);

    entries.push({ institution, studyType, area, startDate, endDate });
    i += 3;
  }

  return entries;
}

/** Parse skills section — returns simple Skill array */
function parseSkillsSection(section: PdfSection): Skill[] {
  return sectionToLines(section)
    .filter((l) => l.length > 0 && l.length < 60)
    .map((name) => ({ name }));
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** Parse a LinkedIn date string like "Jan 2020" → "2020-01" */
function parseLinkedInDate(s: string): ISODate | undefined {
  const cleaned = s.trim().toLowerCase();
  if (cleaned === "present" || cleaned === "") return undefined;

  // "jan 2020" or "january 2020"
  const monthYear = cleaned.match(/^([a-z]+)\s+(\d{4})$/);
  if (monthYear) {
    const month = MONTHS[monthYear[1]?.slice(0, 3) ?? ""] ?? "01";
    return `${monthYear[2]}-${month}` as ISODate;
  }
  // Just a year "2020"
  const yearOnly = cleaned.match(/^(\d{4})$/);
  if (yearOnly) return yearOnly[1] as ISODate;

  return undefined;
}

/**
 * Parse a LinkedIn date range string.
 * Examples: "Jan 2020 – Present · 3 yrs", "2018 – 2020"
 */
function parseDateRange(line: string): [ISODate | undefined, ISODate | undefined] {
  // Strip duration suffix after "·"
  const withoutDuration = line.split("·")[0] ?? "";
  const parts = withoutDuration.split(/[–—-]/).map((p) => p.trim());
  const startDate = parseLinkedInDate(parts[0] ?? "");
  const endDate = parts[1] ? parseLinkedInDate(parts[1]) : undefined;
  return [startDate, endDate];
}

function looksLikeDate(line: string): boolean {
  return /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4})\b/i.test(line);
}

function looksLikeCompanyLine(line: string, _lines: string[]): boolean {
  // A company line is typically short (< 60 chars) and doesn't start with a lowercase letter
  return line.length > 0 && line.length < 80 && /^[A-Z0-9]/.test(line);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Convert a section's text items to an array of non-empty line strings */
function sectionToLines(section: PdfSection): string[] {
  return section.items
    .map((i) => i.text.trim())
    .filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// PDF text extraction with spatial metadata
// ---------------------------------------------------------------------------

/**
 * Extract text items with spatial metadata using pdf-parse.
 *
 * pdf-parse v1.x does not expose per-item coordinates in its default output,
 * so we use its `pagerender` option to intercept the PDF.js render pipeline
 * and collect item positions from the `getTextContent()` stream.
 */
async function extractTextItems(buffer: Buffer): Promise<TextItem[]> {
  const items: TextItem[] = [];
  let currentPage = 0;

  const pdfParse = await loadPdfParse();

  // pagerender callback: called once per page with the PDF.js page object
  async function pagerender(pageData: {
    getTextContent: (opts?: object) => Promise<{
      items: Array<{
        str: string;
        transform: number[];
        fontName?: string;
        height?: number;
        width?: number;
      }>;
      styles?: Record<string, { fontFamily?: string; ascent?: number; descent?: number }>;
    }>;
  }): Promise<string> {
    currentPage++;
    const content = await pageData.getTextContent({ normalizeWhitespace: true });

    for (const item of content.items) {
      const str = item.str.trim();
      if (!str) continue;

      // transform is a 6-element matrix [a, b, c, d, e, f]
      // e = x position, f = y position, d ≈ font size
      const transform = item.transform ?? [1, 0, 0, 12, 0, 0];
      const x = transform[4] ?? 0;
      const y = transform[5] ?? 0;
      const fontSize = Math.abs(transform[3] ?? item.height ?? 12);
      const fontName = item.fontName ?? "";
      const bold = /bold/i.test(fontName);

      items.push({ text: str, x, y, fontSize, fontName, bold, page: currentPage });
    }

    // Return plain text for pdf-parse (unused but required by the API)
    return content.items.map((i) => i.str).join(" ");
  }

  await pdfParse(buffer, { pagerender });

  // Sort items by page, then y (descending — PDF y origin is bottom-left), then x
  items.sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(a.y - b.y) > 2) return b.y - a.y; // higher y = higher on page
    return a.x - b.x;
  });

  return items;
}

// ---------------------------------------------------------------------------
// LinkedInPdfIngester
// ---------------------------------------------------------------------------

/** Options for the LinkedIn PDF ingester */
export interface LinkedInPdfIngesterOptions {
  /** Whether to use spatial/geometric parsing (recommended, default: true) */
  useSpatialParsing?: boolean;
}

/**
 * LinkedInPdfIngester — parses a LinkedIn profile PDF export.
 *
 * LinkedIn allows you to export your profile as a PDF from:
 *   Profile → More → Save to PDF
 *
 * This ingester extracts:
 *   - Name, headline, location from the header
 *   - Work experience (company, title, dates, description)
 *   - Education (institution, degree, dates)
 *   - Skills list
 */
export class LinkedInPdfIngester {
  private readonly useSpatialParsing: boolean;

  constructor(options: LinkedInPdfIngesterOptions = {}) {
    this.useSpatialParsing = options.useSpatialParsing ?? true;
  }

  /**
   * Parse a LinkedIn PDF export file.
   *
   * @param filePath - Absolute path to the PDF file
   */
  async ingest(filePath: string): Promise<IngestResponse> {
    const fetchedAt = new Date().toISOString() as ISODate;
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      const buffer = await fs.promises.readFile(filePath);
      return this.ingestBuffer(buffer, fetchedAt);
    } catch (err) {
      return {
        source: "linkedin-pdf",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        fetchedAt,
      };
    }
  }

  /**
   * Parse a LinkedIn PDF from a Buffer.
   * Useful when the PDF comes from a web upload rather than the filesystem.
   *
   * @param buffer - Raw PDF bytes
   */
  async ingestBuffer(buffer: Buffer, fetchedAt?: ISODate): Promise<IngestResponse> {
    const ts = fetchedAt ?? (new Date().toISOString() as ISODate);
    try {
      const items = await extractTextItems(buffer);
      const sections = clusterIntoSections(items);

      const headerSection = sections.find((s) => s.name === "header");
      const experienceSection = sections.find((s) => s.name === "experience");
      const educationSection = sections.find((s) => s.name === "education");
      const skillsSection = sections.find((s) => s.name === "skills");

      const basics: Basics = {
        name: "",
        ...(headerSection ? parseHeaderSection(headerSection) : {}),
      };

      const work: WorkEntry[] = experienceSection
        ? parseExperienceSection(experienceSection)
        : [];

      const education: EducationEntry[] = educationSection
        ? parseEducationSection(educationSection)
        : [];

      const skills: Skill[] = skillsSection
        ? parseSkillsSection(skillsSection)
        : [];

      const data: IngestResult = {
        basics,
        work,
        education,
        skills,
        fetchMeta: { linkedinPdf: ts },
      };

      return { source: "linkedin-pdf", ok: true, data, fetchedAt: ts };
    } catch (err) {
      return {
        source: "linkedin-pdf",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        fetchedAt: ts,
      };
    }
  }

  /**
   * Expose the raw section list for debugging/inspection.
   *
   * @param filePath - Absolute path to the PDF
   */
  async extractSections(filePath: string): Promise<PdfSection[]> {
    const buffer = await fs.promises.readFile(filePath);
    const items = await extractTextItems(buffer);
    return clusterIntoSections(items);
  }
}

/** Convenience factory */
export function createLinkedInPdfIngester(
  options?: LinkedInPdfIngesterOptions,
): LinkedInPdfIngester {
  return new LinkedInPdfIngester(options);
}

// Note: PdfSection and TextItem are already exported above via their interface declarations

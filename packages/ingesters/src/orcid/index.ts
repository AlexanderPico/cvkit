/**
 * ORCID ingester
 *
 * Fetches works, employment, and education from the ORCID public API (v3.0).
 * No authentication is required — only public profile data is read.
 *
 * API docs: https://pub.orcid.org/v3.0/
 *
 * @example
 * ```ts
 * const ingester = new OrcidIngester();
 * const result = await ingester.ingest("0000-0001-5944-9960");
 * ```
 */

import type {
  Author,
  Basics,
  EducationEntry,
  IngestResponse,
  IngestResult,
  ISODate,
  Publication,
  WorkEntry,
} from "@cvkit/schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORCID_API_BASE = "https://pub.orcid.org/v3.0";
const DEFAULT_HEADERS = {
  Accept: "application/json",
  "User-Agent": "cvkit/0.1 (https://github.com/AlexanderPico/cvkit)",
};

// ---------------------------------------------------------------------------
// Raw ORCID API shapes (partial — only fields we consume)
// ---------------------------------------------------------------------------

interface OrcidDate {
  year?: { value?: string };
  month?: { value?: string };
  day?: { value?: string };
}

interface OrcidOrg {
  name?: string;
  address?: { city?: string; region?: string; country?: string };
}

interface OrcidAffiliation {
  "start-date"?: OrcidDate;
  "end-date"?: OrcidDate;
  organization?: OrcidOrg;
  "role-title"?: string;
  "department-name"?: string;
  url?: { value?: string };
}

interface OrcidAffiliationGroup {
  summaries?: Array<{
    "employment-summary"?: OrcidAffiliation;
    "education-summary"?: OrcidAffiliation;
  }>;
}

interface OrcidExternalId {
  "external-id-type"?: string;
  "external-id-value"?: string;
  "external-id-url"?: { value?: string };
}

interface OrcidWorkSummary {
  "put-code"?: number;
  title?: { title?: { value?: string } };
  "publication-date"?: OrcidDate;
  type?: string;
  "journal-title"?: { value?: string };
  "external-ids"?: { "external-id"?: OrcidExternalId[] };
  url?: { value?: string };
}

interface OrcidWorkGroup {
  "work-summary"?: OrcidWorkSummary[];
}

interface OrcidWorksResponse {
  group?: OrcidWorkGroup[];
}

interface OrcidAffiliationsResponse {
  "affiliation-group"?: OrcidAffiliationGroup[];
}

interface OrcidPerson {
  name?: {
    "given-names"?: { value?: string };
    "family-name"?: { value?: string };
  };
  biography?: { content?: string };
  emails?: { email?: Array<{ email?: string; primary?: boolean }> };
  "researcher-urls"?: { "researcher-url"?: Array<{ url?: { value?: string }; "url-name"?: { value?: string } }> };
}

interface OrcidRecord {
  person?: OrcidPerson;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert an OrcidDate to a partial ISO 8601 string */
function orcidDateToISO(d?: OrcidDate): ISODate | undefined {
  if (!d?.year?.value) return undefined;
  const parts = [d.year.value];
  if (d.month?.value) parts.push(d.month.value.padStart(2, "0"));
  if (d.day?.value) parts.push(d.day.value.padStart(2, "0"));
  return parts.join("-");
}

/** Map an ORCID work type string to our Publication type enum */
function mapWorkType(orcidType?: string): Publication["type"] {
  const map: Record<string, Publication["type"]> = {
    "journal-article": "journal-article",
    "preprint": "preprint",
    "book-chapter": "book-chapter",
    "conference-paper": "conference-paper",
    dataset: "dataset",
    software: "software",
  };
  return (orcidType && map[orcidType]) || "other";
}

// ---------------------------------------------------------------------------
// OrcidIngester
// ---------------------------------------------------------------------------

/** Options for the ORCID ingester */
export interface OrcidIngesterOptions {
  /** Base URL for the ORCID API (override for testing) */
  apiBase?: string;
}

/**
 * OrcidIngester — fetches CV data from the ORCID public API.
 *
 * Retrieves:
 *   - Name and biography from person record
 *   - Employment history
 *   - Education history
 *   - Works (publications) with DOI/PMID external IDs
 */
export class OrcidIngester {
  private readonly apiBase: string;

  constructor(options: OrcidIngesterOptions = {}) {
    this.apiBase = options.apiBase ?? ORCID_API_BASE;
  }

  /**
   * Ingest all available public data for the given ORCID iD.
   *
   * @param orcidId - ORCID iD, e.g. "0000-0001-5944-9960"
   * @returns Normalized IngestResponse with partial CVData
   */
  async ingest(orcidId: string): Promise<IngestResponse> {
    const fetchedAt = new Date().toISOString() as ISODate;
    try {
      const [person, works, employment, education] = await Promise.all([
        this.fetchJson<OrcidRecord>(`${this.apiBase}/${orcidId}`),
        this.fetchJson<OrcidWorksResponse>(`${this.apiBase}/${orcidId}/works`),
        this.fetchJson<OrcidAffiliationsResponse>(`${this.apiBase}/${orcidId}/employments`),
        this.fetchJson<OrcidAffiliationsResponse>(`${this.apiBase}/${orcidId}/educations`),
      ]);

      const data: IngestResult = {
        basics: this.parsePerson(person, orcidId),
        work: this.parseEmployment(employment),
        education: this.parseEducation(education),
        publications: this.parseWorks(works),
        fetchMeta: { orcid: fetchedAt },
      };

      return { source: "orcid", ok: true, data, fetchedAt };
    } catch (err) {
      return {
        source: "orcid",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        fetchedAt,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Parsers
  // -------------------------------------------------------------------------

  private parsePerson(record: OrcidRecord, orcidId: string): Basics {
    const p = record.person;
    const givenName = p?.name?.["given-names"]?.value ?? "";
    const familyName = p?.name?.["family-name"]?.value ?? "";
    const name = [givenName, familyName].filter(Boolean).join(" ");
    const primaryEmail = p?.emails?.email?.find((e) => e.primary)?.email ?? p?.emails?.email?.[0]?.email;

    return {
      name: name || orcidId,
      summary: p?.biography?.content,
      email: primaryEmail,
      orcidId,
      profiles: [
        { network: "ORCID", username: orcidId, url: `https://orcid.org/${orcidId}` },
        ...(p?.["researcher-urls"]?.["researcher-url"]?.map((u) => ({
          network: u["url-name"]?.value ?? "Web",
          url: u.url?.value,
        })) ?? []),
      ],
    };
  }

  private parseEmployment(resp: OrcidAffiliationsResponse): WorkEntry[] {
    const entries: WorkEntry[] = [];
    for (const group of resp["affiliation-group"] ?? []) {
      for (const summary of group.summaries ?? []) {
        const s = summary["employment-summary"];
        if (!s) continue;
        entries.push({
          name: s.organization?.name ?? "Unknown",
          position: s["role-title"],
          startDate: orcidDateToISO(s["start-date"]),
          endDate: orcidDateToISO(s["end-date"]),
          url: s.url?.value,
          highlights: s["department-name"] ? [s["department-name"]] : undefined,
        });
      }
    }
    return entries;
  }

  private parseEducation(resp: OrcidAffiliationsResponse): EducationEntry[] {
    const entries: EducationEntry[] = [];
    for (const group of resp["affiliation-group"] ?? []) {
      for (const summary of group.summaries ?? []) {
        const s = summary["education-summary"];
        if (!s) continue;
        entries.push({
          institution: s.organization?.name ?? "Unknown",
          studyType: s["role-title"],
          area: s["department-name"],
          startDate: orcidDateToISO(s["start-date"]),
          endDate: orcidDateToISO(s["end-date"]),
          url: s.url?.value,
        });
      }
    }
    return entries;
  }

  private parseWorks(resp: OrcidWorksResponse): Publication[] {
    const pubs: Publication[] = [];

    for (const group of resp.group ?? []) {
      // Use the first (most recent / highest source) summary in each group
      const summary = group["work-summary"]?.[0];
      if (!summary) continue;

      const title = summary.title?.title?.value;
      if (!title) continue;

      const externalIds = summary["external-ids"]?.["external-id"] ?? [];
      const doi = externalIds.find((e) => e["external-id-type"] === "doi")?.["external-id-value"];
      const pmid = externalIds.find((e) => e["external-id-type"] === "pmid")?.["external-id-value"];

      const releaseDate = orcidDateToISO(summary["publication-date"]);
      const year = releaseDate ? Number(releaseDate.slice(0, 4)) : undefined;

      // Authors are not in the summary endpoint; a separate /work/{put-code} call
      // would be needed. We leave authors empty and let Semantic Scholar fill them.
      const authors: Author[] = [];

      pubs.push({
        title,
        type: mapWorkType(summary.type),
        authors,
        publisher: summary["journal-title"]?.value,
        releaseDate,
        year,
        doi: doi?.toLowerCase().replace(/^https?:\/\/doi\.org\//i, ""),
        pmid,
        url: summary.url?.value ?? (doi ? `https://doi.org/${doi}` : undefined),
      });
    }

    return pubs;
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private async fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: DEFAULT_HEADERS });
    if (!res.ok) {
      throw new Error(`ORCID API error ${res.status} for ${url}`);
    }
    return res.json() as Promise<T>;
  }
}

/** Convenience factory */
export function createOrcidIngester(options?: OrcidIngesterOptions): OrcidIngester {
  return new OrcidIngester(options);
}

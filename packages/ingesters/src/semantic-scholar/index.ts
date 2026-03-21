/**
 * Semantic Scholar ingester
 *
 * Fetches citation metrics (h-index, total citations) and enriches existing
 * publications with citation counts using the Semantic Scholar Academic Graph API.
 *
 * API docs: https://api.semanticscholar.org/graph/v1
 *
 * No API key is required for basic usage, but requests are rate-limited to 100/min.
 * Set the `S2_API_KEY` environment variable to raise the limit.
 *
 * @example
 * ```ts
 * const ingester = new SemanticScholarIngester();
 * const result = await ingester.ingestByOrcid("0000-0001-5944-9960");
 * ```
 */

import type {
  Author,
  CitationMetrics,
  IngestResponse,
  IngestResult,
  ISODate,
  Publication,
} from "@cvkit/schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const S2_API_BASE = "https://api.semanticscholar.org/graph/v1";
const DEFAULT_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent": "cvkit/0.1 (https://github.com/AlexanderPico/cvkit)",
};

// ---------------------------------------------------------------------------
// Raw S2 API shapes (partial)
// ---------------------------------------------------------------------------

interface S2Author {
  authorId?: string;
  name?: string;
}

interface S2Paper {
  paperId?: string;
  title?: string;
  year?: number;
  publicationDate?: string;
  externalIds?: {
    DOI?: string;
    PubMed?: string;
    ArXiv?: string;
  };
  publicationTypes?: string[];
  journal?: { name?: string; volume?: string; pages?: string };
  venue?: string;
  authors?: S2Author[];
  citationCount?: number;
  influentialCitationCount?: number;
  isOpenAccess?: boolean;
  openAccessPdf?: { url?: string };
  abstract?: string;
  url?: string;
}

interface S2AuthorDetail {
  authorId?: string;
  name?: string;
  hIndex?: number;
  citationCount?: number;
  paperCount?: number;
  papers?: S2Paper[];
}

interface S2AuthorSearchResponse {
  data?: Array<{
    authorId?: string;
    name?: string;
    hIndex?: number;
    citationCount?: number;
    paperCount?: number;
  }>;
}

interface S2PaperSearchResponse {
  data?: S2Paper[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map S2 publicationTypes array to our Publication type */
function mapS2Type(types?: string[]): Publication["type"] {
  if (!types?.length) return "other";
  const t = types[0]?.toLowerCase() ?? "";
  if (t.includes("journal")) return "journal-article";
  if (t.includes("conference")) return "conference-paper";
  if (t.includes("book")) return "book-chapter";
  if (t.includes("preprint") || t.includes("arxiv")) return "preprint";
  if (t.includes("dataset")) return "dataset";
  return "other";
}

/** Normalize a DOI string — strip prefix, lowercase */
function normalizeDoi(doi?: string): string | undefined {
  if (!doi) return undefined;
  return doi.toLowerCase().replace(/^https?:\/\/doi\.org\//i, "");
}

/** Convert an S2Paper to a CVData Publication */
function s2PaperToPublication(paper: S2Paper): Publication {
  const authors: Author[] = (paper.authors ?? []).map((a) => ({
    name: a.name ?? "",
    s2AuthorId: a.authorId,
  }));

  return {
    title: paper.title ?? "Untitled",
    type: mapS2Type(paper.publicationTypes),
    authors,
    authorsStr: authors.map((a) => a.name).join(", "),
    publisher: paper.journal?.name ?? paper.venue,
    releaseDate: paper.publicationDate ?? (paper.year ? String(paper.year) : undefined),
    year: paper.year,
    doi: normalizeDoi(paper.externalIds?.DOI),
    pmid: paper.externalIds?.PubMed,
    arxivId: paper.externalIds?.ArXiv,
    s2PaperId: paper.paperId,
    citationCount: paper.citationCount,
    influentialCitationCount: paper.influentialCitationCount,
    openAccess: paper.isOpenAccess,
    url: paper.openAccessPdf?.url ?? paper.url,
    abstract: paper.abstract,
    volume: paper.journal?.volume,
    pages: paper.journal?.pages,
  };
}

// ---------------------------------------------------------------------------
// SemanticScholarIngester
// ---------------------------------------------------------------------------

/** Options for the Semantic Scholar ingester */
export interface SemanticScholarIngesterOptions {
  /** API key from https://www.semanticscholar.org/product/api (optional, increases rate limit) */
  apiKey?: string;
  /** Base URL override for testing */
  apiBase?: string;
}

/**
 * SemanticScholarIngester — fetches citation metrics and paper details.
 *
 * Retrieves:
 *   - Author-level h-index, total citations, paper count
 *   - Full paper list with per-paper citation counts
 *
 * Can look up by ORCID iD or by author name.
 */
export class SemanticScholarIngester {
  private readonly apiBase: string;
  private readonly headers: Record<string, string>;

  constructor(options: SemanticScholarIngesterOptions = {}) {
    this.apiBase = options.apiBase ?? S2_API_BASE;
    this.headers = { ...DEFAULT_HEADERS };
    if (options.apiKey) {
      this.headers["x-api-key"] = options.apiKey;
    }
  }

  /**
   * Ingest by ORCID iD.
   * Searches Semantic Scholar for an author matching the given ORCID.
   *
   * @param orcidId - ORCID iD, e.g. "0000-0001-5944-9960"
   */
  async ingestByOrcid(orcidId: string): Promise<IngestResponse> {
    const fetchedAt = new Date().toISOString() as ISODate;
    try {
      // S2 supports author search by externalIds
      const searchUrl = `${this.apiBase}/author/search?query=${encodeURIComponent(orcidId)}&fields=authorId,name,hIndex,citationCount,paperCount`;
      const searchResp = await this.fetchJson<S2AuthorSearchResponse>(searchUrl);
      const authorEntry = searchResp.data?.[0];
      if (!authorEntry?.authorId) {
        throw new Error(`No Semantic Scholar author found for ORCID ${orcidId}`);
      }
      return this.ingestByAuthorId(authorEntry.authorId);
    } catch (err) {
      return {
        source: "semantic-scholar",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        fetchedAt,
      };
    }
  }

  /**
   * Ingest by author name.
   * Picks the first search result — use `ingestByAuthorId` for precision.
   *
   * @param name - Author full name, e.g. "Alexander Pico"
   */
  async ingestByName(name: string): Promise<IngestResponse> {
    const fetchedAt = new Date().toISOString() as ISODate;
    try {
      const url = `${this.apiBase}/author/search?query=${encodeURIComponent(name)}&fields=authorId,name,hIndex,citationCount,paperCount`;
      const resp = await this.fetchJson<S2AuthorSearchResponse>(url);
      const entry = resp.data?.[0];
      if (!entry?.authorId) {
        throw new Error(`No Semantic Scholar author found for name "${name}"`);
      }
      return this.ingestByAuthorId(entry.authorId);
    } catch (err) {
      return {
        source: "semantic-scholar",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        fetchedAt,
      };
    }
  }

  /**
   * Ingest by Semantic Scholar author ID.
   * This is the most precise lookup method.
   *
   * @param s2AuthorId - Semantic Scholar author ID, e.g. "2109124"
   */
  async ingestByAuthorId(s2AuthorId: string): Promise<IngestResponse> {
    const fetchedAt = new Date().toISOString() as ISODate;
    try {
      // Fetch author details + their papers in one call
      const fields = "authorId,name,hIndex,citationCount,paperCount,papers.paperId,papers.title,papers.year,papers.publicationDate,papers.externalIds,papers.publicationTypes,papers.journal,papers.venue,papers.authors,papers.citationCount,papers.influentialCitationCount,papers.isOpenAccess,papers.openAccessPdf,papers.abstract,papers.url";
      const url = `${this.apiBase}/author/${s2AuthorId}?fields=${fields}`;
      const detail = await this.fetchJson<S2AuthorDetail>(url);

      const metrics: CitationMetrics = {
        hIndex: detail.hIndex,
        totalCitations: detail.citationCount,
        publicationCount: detail.paperCount,
        s2AuthorId,
        fetchedAt,
      };

      // Compute i10 index from paper list
      const papers = detail.papers ?? [];
      metrics.i10Index = papers.filter((p) => (p.citationCount ?? 0) >= 10).length;

      const publications: Publication[] = papers.map(s2PaperToPublication);

      const data: IngestResult = {
        citationMetrics: metrics,
        publications,
        fetchMeta: { semanticScholar: fetchedAt },
      };

      return { source: "semantic-scholar", ok: true, data, fetchedAt };
    } catch (err) {
      return {
        source: "semantic-scholar",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        fetchedAt,
      };
    }
  }

  /**
   * Enrich existing publications with citation counts from Semantic Scholar.
   * Matches by DOI. Returns a new array with citationCount populated.
   *
   * @param publications - Existing publications (must have doi fields)
   */
  async enrichPublications(publications: Publication[]): Promise<Publication[]> {
    const withDoi = publications.filter((p) => p.doi);
    if (withDoi.length === 0) return publications;

    // Batch lookup by DOI — S2 supports up to 500 per request
    const batchSize = 100;
    const enriched = new Map<string, Partial<Publication>>();

    for (let i = 0; i < withDoi.length; i += batchSize) {
      const batch = withDoi.slice(i, i + batchSize);
      const ids = batch.map((p) => `DOI:${p.doi}`);
      try {
        const url = `${this.apiBase}/paper/batch`;
        const body = JSON.stringify({ ids, fields: "paperId,citationCount,influentialCitationCount,isOpenAccess,openAccessPdf" });
        const res = await fetch(url, {
          method: "POST",
          headers: { ...this.headers, "Content-Type": "application/json" },
          body,
        });
        if (!res.ok) continue;
        const papers = (await res.json()) as Array<S2Paper | null>;
        for (let j = 0; j < batch.length; j++) {
          const paper = papers[j];
          const pub = batch[j];
          if (paper && pub?.doi) {
            enriched.set(pub.doi, {
              s2PaperId: paper.paperId,
              citationCount: paper.citationCount,
              influentialCitationCount: paper.influentialCitationCount,
              openAccess: paper.isOpenAccess,
              url: paper.openAccessPdf?.url,
            });
          }
        }
      } catch {
        // Non-fatal: continue with remaining batches
      }
    }

    return publications.map((pub) => {
      const updates = pub.doi ? enriched.get(pub.doi) : undefined;
      return updates ? { ...pub, ...updates } : pub;
    });
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private async fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: this.headers });
    if (res.status === 429) {
      throw new Error("Semantic Scholar rate limit exceeded. Set S2_API_KEY or wait before retrying.");
    }
    if (!res.ok) {
      throw new Error(`Semantic Scholar API error ${res.status} for ${url}`);
    }
    return res.json() as Promise<T>;
  }
}

/** Convenience factory */
export function createSemanticScholarIngester(
  options?: SemanticScholarIngesterOptions,
): SemanticScholarIngester {
  return new SemanticScholarIngester(options);
}

/** Look up an S2 paper by DOI and return its citation count */
export async function getCitationCountByDoi(
  doi: string,
  options?: SemanticScholarIngesterOptions,
): Promise<number | undefined> {
  const ingester = createSemanticScholarIngester(options);
  const normalized = doi.toLowerCase().replace(/^https?:\/\/doi\.org\//i, "");
  try {
    const url = `${ingester["apiBase"]}/paper/DOI:${encodeURIComponent(normalized)}?fields=citationCount`;
    const paper = await ingester["fetchJson"]<S2Paper>(url);
    return paper.citationCount;
  } catch {
    return undefined;
  }
}

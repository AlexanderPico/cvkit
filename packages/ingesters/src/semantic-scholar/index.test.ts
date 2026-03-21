/**
 * Tests for the Semantic Scholar ingester
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { SemanticScholarIngester } from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AUTHOR_ID = "2109124";

const mockAuthorDetail = {
  authorId: AUTHOR_ID,
  name: "Alexander Pico",
  hIndex: 22,
  citationCount: 5800,
  paperCount: 80,
  papers: [
    {
      paperId: "abc123",
      title: "WikiPathways 2024",
      year: 2024,
      publicationDate: "2024-01-05",
      externalIds: { DOI: "10.1093/nar/gkad960", PubMed: "37941144" },
      publicationTypes: ["JournalArticle"],
      journal: { name: "Nucleic Acids Research", volume: "52", pages: "D835-D842" },
      authors: [
        { authorId: AUTHOR_ID, name: "Alexander Pico" },
        { authorId: "999", name: "Martina Summer-Kutmon" },
      ],
      citationCount: 48,
      influentialCitationCount: 5,
      isOpenAccess: true,
      openAccessPdf: { url: "https://academic.oup.com/nar/article-pdf/52/D1/D835/55040682/gkad960.pdf" },
    },
    {
      paperId: "def456",
      title: "Cytoscape 3.0",
      year: 2019,
      publicationDate: "2019-03-01",
      externalIds: { DOI: "10.1038/s41592-019-0506-3" },
      publicationTypes: ["JournalArticle"],
      journal: { name: "Nature Methods" },
      authors: [{ authorId: AUTHOR_ID, name: "Alexander Pico" }],
      citationCount: 340,
      influentialCitationCount: 42,
      isOpenAccess: false,
    },
  ],
};

const mockAuthorSearch = {
  data: [{ authorId: AUTHOR_ID, name: "Alexander Pico", hIndex: 22, citationCount: 5800, paperCount: 80 }],
};

function makeMockFetch(apiBase: string) {
  return vi.fn((url: string) => {
    const urlStr = String(url);
    let body: unknown = {};

    if (urlStr.includes("/author/search")) {
      body = mockAuthorSearch;
    } else if (urlStr.includes(`/author/${AUTHOR_ID}`)) {
      body = mockAuthorDetail;
    }

    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(body),
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SemanticScholarIngester", () => {
  const apiBase = "https://mock.s2.test/graph/v1";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("ingestByAuthorId", () => {
    it("returns ok=true with citation metrics and publications", async () => {
      vi.stubGlobal("fetch", makeMockFetch(apiBase));
      const ingester = new SemanticScholarIngester({ apiBase });
      const resp = await ingester.ingestByAuthorId(AUTHOR_ID);

      expect(resp.ok).toBe(true);
      expect(resp.source).toBe("semantic-scholar");
      expect(resp.data?.citationMetrics?.hIndex).toBe(22);
      expect(resp.data?.citationMetrics?.totalCitations).toBe(5800);
      expect(resp.data?.citationMetrics?.publicationCount).toBe(80);
      expect(resp.data?.citationMetrics?.s2AuthorId).toBe(AUTHOR_ID);
    });

    it("computes i10-index from papers with ≥10 citations", async () => {
      vi.stubGlobal("fetch", makeMockFetch(apiBase));
      const ingester = new SemanticScholarIngester({ apiBase });
      const resp = await ingester.ingestByAuthorId(AUTHOR_ID);
      // Both papers have >10 citations (48, 340)
      expect(resp.data?.citationMetrics?.i10Index).toBe(2);
    });

    it("maps papers to publications with DOI, PMID, citation counts", async () => {
      vi.stubGlobal("fetch", makeMockFetch(apiBase));
      const ingester = new SemanticScholarIngester({ apiBase });
      const resp = await ingester.ingestByAuthorId(AUTHOR_ID);

      const pubs = resp.data?.publications ?? [];
      expect(pubs).toHaveLength(2);

      const wiki = pubs.find((p) => p.doi === "10.1093/nar/gkad960");
      expect(wiki).toBeDefined();
      expect(wiki?.citationCount).toBe(48);
      expect(wiki?.pmid).toBe("37941144");
      expect(wiki?.openAccess).toBe(true);
      expect(wiki?.type).toBe("journal-article");
      expect(wiki?.authors).toHaveLength(2);
    });

    it("normalizes DOI to lowercase without prefix", async () => {
      vi.stubGlobal("fetch", makeMockFetch(apiBase));
      const ingester = new SemanticScholarIngester({ apiBase });
      const resp = await ingester.ingestByAuthorId(AUTHOR_ID);
      const pubs = resp.data?.publications ?? [];
      for (const p of pubs) {
        if (p.doi) {
          expect(p.doi).toBe(p.doi.toLowerCase());
          expect(p.doi).not.toMatch(/^https?:\/\//);
        }
      }
    });
  });

  describe("ingestByName", () => {
    it("searches by name and delegates to ingestByAuthorId", async () => {
      vi.stubGlobal("fetch", makeMockFetch(apiBase));
      const ingester = new SemanticScholarIngester({ apiBase });
      const resp = await ingester.ingestByName("Alexander Pico");
      expect(resp.ok).toBe(true);
      expect(resp.data?.citationMetrics?.hIndex).toBe(22);
    });

    it("returns ok=false when no author found", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true, status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve({ data: [] }),
      }));
      const ingester = new SemanticScholarIngester({ apiBase });
      const resp = await ingester.ingestByName("Nonexistent Person XYZ");
      expect(resp.ok).toBe(false);
    });
  });

  describe("rate limiting", () => {
    it("returns ok=false with helpful message on 429", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false, status: 429,
        headers: { get: () => null },
        json: () => Promise.resolve({}),
      }));
      const ingester = new SemanticScholarIngester({ apiBase });
      const resp = await ingester.ingestByAuthorId(AUTHOR_ID);
      expect(resp.ok).toBe(false);
      expect(resp.error).toContain("rate limit");
    });
  });
});

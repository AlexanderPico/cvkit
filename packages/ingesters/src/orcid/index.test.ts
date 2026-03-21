/**
 * Tests for the ORCID ingester
 * Uses a mock HTTP server to avoid hitting the real ORCID API.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { OrcidIngester } from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORCID_ID = "0000-0001-5944-9960";

const mockPersonResponse = {
  person: {
    name: { "given-names": { value: "Alexander" }, "family-name": { value: "Pico" } },
    biography: { content: "Bioinformatics researcher at Gladstone Institutes." },
    emails: { email: [{ email: "apico@gladstone.ucsf.edu", primary: true }] },
    "researcher-urls": {
      "researcher-url": [{ "url-name": { value: "Lab" }, url: { value: "https://picoapico.com" } }],
    },
  },
};

const mockWorksResponse = {
  group: [
    {
      "work-summary": [
        {
          "put-code": 123,
          title: { title: { value: "WikiPathways 2024" } },
          type: "journal-article",
          "journal-title": { value: "Nucleic Acids Research" },
          "publication-date": { year: { value: "2024" }, month: { value: "01" }, day: { value: "05" } },
          "external-ids": {
            "external-id": [
              { "external-id-type": "doi", "external-id-value": "10.1093/nar/gkad960" },
              { "external-id-type": "pmid", "external-id-value": "37941144" },
            ],
          },
          url: { value: "https://doi.org/10.1093/nar/gkad960" },
        },
      ],
    },
  ],
};

const mockEmploymentResponse = {
  "affiliation-group": [
    {
      summaries: [
        {
          "employment-summary": {
            organization: { name: "Gladstone Institutes" },
            "role-title": "Senior Scientist",
            "department-name": "Data Science",
            "start-date": { year: { value: "2010" }, month: { value: "06" } },
            url: { value: "https://gladstone.org" },
          },
        },
      ],
    },
  ],
};

const mockEducationResponse = {
  "affiliation-group": [
    {
      summaries: [
        {
          "education-summary": {
            organization: { name: "University of California, San Diego" },
            "role-title": "PhD",
            "department-name": "Bioinformatics",
            "start-date": { year: { value: "2000" } },
            "end-date": { year: { value: "2006" } },
          },
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

function makeMockFetch(apiBase: string) {
  return vi.fn((url: string) => {
    const urlStr = String(url);
    let body: unknown;

    if (urlStr === `${apiBase}/${ORCID_ID}`) body = mockPersonResponse;
    else if (urlStr === `${apiBase}/${ORCID_ID}/works`) body = mockWorksResponse;
    else if (urlStr === `${apiBase}/${ORCID_ID}/employments`) body = mockEmploymentResponse;
    else if (urlStr === `${apiBase}/${ORCID_ID}/educations`) body = mockEducationResponse;
    else body = {};

    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OrcidIngester", () => {
  const apiBase = "https://mock.orcid.test/v3.0";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok=true and parses basics, works, employment, education", async () => {
    const mockFetch = makeMockFetch(apiBase);
    vi.stubGlobal("fetch", mockFetch);

    const ingester = new OrcidIngester({ apiBase });
    const resp = await ingester.ingest(ORCID_ID);

    expect(resp.ok).toBe(true);
    expect(resp.source).toBe("orcid");
    expect(resp.data?.basics?.name).toBe("Alexander Pico");
    expect(resp.data?.basics?.email).toBe("apico@gladstone.ucsf.edu");
    expect(resp.data?.basics?.orcidId).toBe(ORCID_ID);
  });

  it("parses publications with DOI and PMID", async () => {
    vi.stubGlobal("fetch", makeMockFetch(apiBase));
    const ingester = new OrcidIngester({ apiBase });
    const resp = await ingester.ingest(ORCID_ID);

    expect(resp.data?.publications).toHaveLength(1);
    const pub = resp.data?.publications?.[0];
    expect(pub?.title).toBe("WikiPathways 2024");
    expect(pub?.doi).toBe("10.1093/nar/gkad960");
    expect(pub?.pmid).toBe("37941144");
    expect(pub?.publisher).toBe("Nucleic Acids Research");
    expect(pub?.year).toBe(2024);
    expect(pub?.releaseDate).toBe("2024-01-05");
  });

  it("parses employment history", async () => {
    vi.stubGlobal("fetch", makeMockFetch(apiBase));
    const ingester = new OrcidIngester({ apiBase });
    const resp = await ingester.ingest(ORCID_ID);

    expect(resp.data?.work).toHaveLength(1);
    expect(resp.data?.work?.[0]?.name).toBe("Gladstone Institutes");
    expect(resp.data?.work?.[0]?.position).toBe("Senior Scientist");
    expect(resp.data?.work?.[0]?.startDate).toBe("2010-06");
  });

  it("parses education history", async () => {
    vi.stubGlobal("fetch", makeMockFetch(apiBase));
    const ingester = new OrcidIngester({ apiBase });
    const resp = await ingester.ingest(ORCID_ID);

    expect(resp.data?.education).toHaveLength(1);
    expect(resp.data?.education?.[0]?.institution).toBe("University of California, San Diego");
    expect(resp.data?.education?.[0]?.studyType).toBe("PhD");
    expect(resp.data?.education?.[0]?.startDate).toBe("2000");
    expect(resp.data?.education?.[0]?.endDate).toBe("2006");
  });

  it("sets fetchMeta.orcid timestamp", async () => {
    vi.stubGlobal("fetch", makeMockFetch(apiBase));
    const ingester = new OrcidIngester({ apiBase });
    const resp = await ingester.ingest(ORCID_ID);
    expect(resp.data?.fetchMeta?.orcid).toBeTruthy();
  });

  it("returns ok=false on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const ingester = new OrcidIngester({ apiBase });
    const resp = await ingester.ingest(ORCID_ID);
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("Network error");
  });

  it("returns ok=false on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) }));
    const ingester = new OrcidIngester({ apiBase });
    const resp = await ingester.ingest(ORCID_ID);
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("404");
  });
});

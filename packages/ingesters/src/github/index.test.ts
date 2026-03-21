/**
 * Tests for the GitHub ingester
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubIngester } from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockRepos = [
  {
    name: "cytoscape-automation",
    full_name: "AlexanderPico/cytoscape-automation",
    description: "Cytoscape automation scripts and notebooks",
    html_url: "https://github.com/AlexanderPico/cytoscape-automation",
    homepage: null,
    language: "Python",
    stargazers_count: 45,
    forks_count: 12,
    open_issues_count: 3,
    topics: ["cytoscape", "bioinformatics", "automation"],
    license: { spdx_id: "MIT" },
    created_at: "2018-03-15T00:00:00Z",
    pushed_at: "2024-01-01T00:00:00Z",
    fork: false,
    archived: false,
    private: false,
  },
  {
    name: "forked-repo",
    full_name: "AlexanderPico/forked-repo",
    description: "A fork",
    html_url: "https://github.com/AlexanderPico/forked-repo",
    homepage: null,
    language: "JavaScript",
    stargazers_count: 5,
    forks_count: 0,
    open_issues_count: 0,
    topics: [],
    license: null,
    created_at: "2020-01-01T00:00:00Z",
    pushed_at: "2020-01-01T00:00:00Z",
    fork: true,
    archived: false,
    private: false,
  },
];

const mockLanguages = { Python: 18000, Jupyter: 4200, Shell: 300 };

function makeMockFetch(apiBase: string) {
  return vi.fn((url: string) => {
    const urlStr = String(url);
    let body: unknown = [];

    if (urlStr.includes("/users/AlexanderPico/repos")) {
      body = mockRepos;
    } else if (urlStr.includes("/languages")) {
      body = mockLanguages;
    }

    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => "10" },
      json: () => Promise.resolve(body),
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitHubIngester", () => {
  const apiBase = "https://mock.github.test";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok=true with software array", async () => {
    vi.stubGlobal("fetch", makeMockFetch(apiBase));
    const ingester = new GitHubIngester({ apiBase });
    const resp = await ingester.ingest("AlexanderPico");

    expect(resp.ok).toBe(true);
    expect(resp.source).toBe("github");
    expect(resp.data?.software).toBeDefined();
  });

  it("excludes forked repos by default", async () => {
    vi.stubGlobal("fetch", makeMockFetch(apiBase));
    const ingester = new GitHubIngester({ apiBase });
    const resp = await ingester.ingest("AlexanderPico");

    const names = resp.data?.software?.map((s) => s.name) ?? [];
    expect(names).not.toContain("forked-repo");
    expect(names).toContain("cytoscape-automation");
  });

  it("includes forked repos when includeForks=true", async () => {
    vi.stubGlobal("fetch", makeMockFetch(apiBase));
    const ingester = new GitHubIngester({ apiBase, includeForks: true });
    const resp = await ingester.ingest("AlexanderPico");

    const names = resp.data?.software?.map((s) => s.name) ?? [];
    expect(names).toContain("forked-repo");
  });

  it("maps repo fields correctly", async () => {
    vi.stubGlobal("fetch", makeMockFetch(apiBase));
    const ingester = new GitHubIngester({ apiBase });
    const resp = await ingester.ingest("AlexanderPico");

    const repo = resp.data?.software?.find((s) => s.name === "cytoscape-automation");
    expect(repo).toBeDefined();
    expect(repo?.stars).toBe(45);
    expect(repo?.forks).toBe(12);
    expect(repo?.language).toBe("Python");
    expect(repo?.githubRepo).toBe("AlexanderPico/cytoscape-automation");
    expect(repo?.license).toBe("MIT");
    expect(repo?.topics).toContain("bioinformatics");
  });

  it("populates language list from languages endpoint", async () => {
    vi.stubGlobal("fetch", makeMockFetch(apiBase));
    const ingester = new GitHubIngester({ apiBase });
    const resp = await ingester.ingest("AlexanderPico");
    const repo = resp.data?.software?.find((s) => s.name === "cytoscape-automation");
    expect(repo?.languages).toContain("Python");
    expect(repo?.languages?.[0]).toBe("Python"); // sorted by bytes descending
  });

  it("sorts software by stars descending", async () => {
    vi.stubGlobal("fetch", makeMockFetch(apiBase));
    const ingester = new GitHubIngester({ apiBase, includeForks: true });
    const resp = await ingester.ingest("AlexanderPico");
    const stars = resp.data?.software?.map((s) => s.stars ?? 0) ?? [];
    expect(stars).toEqual([...stars].sort((a, b) => b - a));
  });

  it("sets fetchMeta.github timestamp", async () => {
    vi.stubGlobal("fetch", makeMockFetch(apiBase));
    const ingester = new GitHubIngester({ apiBase });
    const resp = await ingester.ingest("AlexanderPico");
    expect(resp.data?.fetchMeta?.github).toBeTruthy();
  });

  it("returns ok=false on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const ingester = new GitHubIngester({ apiBase });
    const resp = await ingester.ingest("AlexanderPico");
    expect(resp.ok).toBe(false);
    expect(resp.error).toBeTruthy();
  });

  it("reports rate limit error clearly on 403 with remaining=0", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 403,
      headers: { get: (h: string) => h === "x-ratelimit-remaining" ? "0" : "1735000000" },
      json: () => Promise.resolve({}),
    }));
    const ingester = new GitHubIngester({ apiBase });
    const resp = await ingester.ingest("AlexanderPico");
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("rate limit");
  });
});

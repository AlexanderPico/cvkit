/**
 * GitHub ingester
 *
 * Fetches repository data, language stats, and star counts from the GitHub REST API.
 * Uses the public API (no auth needed for public repos) or a personal access token
 * for higher rate limits and access to private repos.
 *
 * API docs: https://docs.github.com/en/rest
 *
 * @example
 * ```ts
 * const ingester = new GitHubIngester({ token: process.env.GITHUB_TOKEN });
 * const result = await ingester.ingest("AlexanderPico");
 * ```
 */

import type { IngestResponse, IngestResult, ISODate, Software } from "@cvkit/schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GH_API_BASE = "https://api.github.com";
const DEFAULT_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "cvkit/0.1 (https://github.com/AlexanderPico/cvkit)",
};

// ---------------------------------------------------------------------------
// Raw GitHub API shapes (partial)
// ---------------------------------------------------------------------------

interface GHRepo {
  name: string;
  full_name: string;
  description?: string | null;
  html_url: string;
  homepage?: string | null;
  language?: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  topics?: string[];
  license?: { spdx_id?: string } | null;
  created_at: string;
  pushed_at: string;
  fork: boolean;
  archived: boolean;
  private: boolean;
}

interface GHLanguages {
  [language: string]: number;
}

// ---------------------------------------------------------------------------
// GitHubIngester
// ---------------------------------------------------------------------------

/** Options for the GitHub ingester */
export interface GitHubIngesterOptions {
  /**
   * GitHub personal access token (PAT).
   * Without a token, the API is limited to 60 requests/hour.
   * A token with `public_repo` scope raises the limit to 5,000/hour.
   */
  token?: string;
  /** Base URL override for GitHub API (for testing or GHE) */
  apiBase?: string;
  /**
   * Whether to include forked repositories.
   * @default false
   */
  includeForks?: boolean;
  /**
   * Whether to include archived repositories.
   * @default false
   */
  includeArchived?: boolean;
  /**
   * Maximum number of repos to fetch (sorted by stars desc).
   * @default 100
   */
  maxRepos?: number;
}

/**
 * GitHubIngester — fetches repository metadata for a GitHub user/org.
 *
 * Retrieves:
 *   - Repository name, description, URL
 *   - Primary language + full language breakdown
 *   - Star count, fork count, open issues
 *   - Topics and license
 */
export class GitHubIngester {
  private readonly apiBase: string;
  private readonly headers: Record<string, string>;
  private readonly includeForks: boolean;
  private readonly includeArchived: boolean;
  private readonly maxRepos: number;

  constructor(options: GitHubIngesterOptions = {}) {
    this.apiBase = options.apiBase ?? GH_API_BASE;
    this.headers = { ...DEFAULT_HEADERS };
    if (options.token) {
      this.headers["Authorization"] = `Bearer ${options.token}`;
    }
    this.includeForks = options.includeForks ?? false;
    this.includeArchived = options.includeArchived ?? false;
    this.maxRepos = options.maxRepos ?? 100;
  }

  /**
   * Ingest all public repositories for the given GitHub username.
   *
   * @param username - GitHub username or organization, e.g. "AlexanderPico"
   */
  async ingest(username: string): Promise<IngestResponse> {
    const fetchedAt = new Date().toISOString() as ISODate;
    try {
      const repos = await this.fetchAllRepos(username);

      // Fetch language details in parallel (capped to avoid rate limit hammering)
      const concurrency = 10;
      const software: Software[] = [];

      for (let i = 0; i < repos.length; i += concurrency) {
        const batch = repos.slice(i, i + concurrency);
        const results = await Promise.all(
          batch.map((repo) => this.repoToSoftware(repo)),
        );
        software.push(...results);
      }

      // Sort by stars descending
      software.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));

      const data: IngestResult = {
        software,
        fetchMeta: { github: fetchedAt },
      };

      return { source: "github", ok: true, data, fetchedAt };
    } catch (err) {
      return {
        source: "github",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        fetchedAt,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async fetchAllRepos(username: string): Promise<GHRepo[]> {
    const repos: GHRepo[] = [];
    let page = 1;
    const perPage = 100;

    while (repos.length < this.maxRepos) {
      const url = `${this.apiBase}/users/${username}/repos?type=owner&sort=stars&direction=desc&per_page=${perPage}&page=${page}`;
      const batch = await this.fetchJson<GHRepo[]>(url);
      if (batch.length === 0) break;

      for (const repo of batch) {
        if (repo.private) continue;
        if (repo.fork && !this.includeForks) continue;
        if (repo.archived && !this.includeArchived) continue;
        repos.push(repo);
        if (repos.length >= this.maxRepos) break;
      }

      if (batch.length < perPage) break;
      page++;
    }

    return repos;
  }

  private async repoToSoftware(repo: GHRepo): Promise<Software> {
    // Attempt to fetch language breakdown; fall back gracefully on error
    let languages: string[] = [];
    try {
      const langData = await this.fetchJson<GHLanguages>(
        `${this.apiBase}/repos/${repo.full_name}/languages`,
      );
      // Sort by bytes descending, return language names only
      languages = Object.entries(langData)
        .sort(([, a], [, b]) => b - a)
        .map(([lang]) => lang);
    } catch {
      if (repo.language) languages = [repo.language];
    }

    return {
      name: repo.name,
      description: repo.description ?? undefined,
      url: repo.homepage || repo.html_url,
      githubRepo: repo.full_name,
      language: repo.language ?? undefined,
      languages,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      openIssues: repo.open_issues_count,
      releaseDate: repo.created_at.slice(0, 10) as ISODate,
      topics: repo.topics,
      license: repo.license?.spdx_id ?? undefined,
      fetchedAt: new Date().toISOString() as ISODate,
    };
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private async fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: this.headers });
    if (res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining === "0") {
        const reset = res.headers.get("x-ratelimit-reset");
        const resetDate = reset ? new Date(Number(reset) * 1000).toISOString() : "unknown";
        throw new Error(`GitHub rate limit exceeded. Resets at ${resetDate}. Set GITHUB_TOKEN to increase limits.`);
      }
    }
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status} for ${url}`);
    }
    return res.json() as Promise<T>;
  }
}

/** Convenience factory */
export function createGitHubIngester(options?: GitHubIngesterOptions): GitHubIngester {
  return new GitHubIngester(options);
}

/**
 * @cvkit/ingesters
 *
 * Barrel export for all cvkit data ingesters.
 *
 * Each ingester fetches data from an external source and returns an
 * {@link IngestResponse} containing a partial {@link CVData} that can be
 * merged into the store with `CVStore.merge()`.
 *
 * Available ingesters:
 *   - {@link OrcidIngester} — ORCID public API (works, employment, education)
 *   - {@link SemanticScholarIngester} — citation metrics, h-index, paper list
 *   - {@link GitHubIngester} — repository metadata and language stats
 *   - {@link LinkedInPdfIngester} — spatial parser for LinkedIn PDF exports
 */

export {
  OrcidIngester,
  createOrcidIngester,
  type OrcidIngesterOptions,
} from "./orcid/index.js";

export {
  SemanticScholarIngester,
  createSemanticScholarIngester,
  getCitationCountByDoi,
  type SemanticScholarIngesterOptions,
} from "./semantic-scholar/index.js";

export {
  GitHubIngester,
  createGitHubIngester,
  type GitHubIngesterOptions,
} from "./github/index.js";

export {
  LinkedInPdfIngester,
  createLinkedInPdfIngester,
  type LinkedInPdfIngesterOptions,
  type PdfSection,
  type TextItem,
} from "./linkedin-pdf/index.js";

/**
 * @cvkit/schema
 *
 * Canonical CVData TypeScript types for cvkit.
 * Extends JSON Resume (https://jsonresume.org/schema/) with academic-specific
 * fields: publications with DOI/PMID/citation counts, grants, software repos,
 * and citation metrics sourced from Semantic Scholar.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** ISO 8601 date string, e.g. "2024-01-15" or partial "2024-01" */
export type ISODate = string;

/** ORCID identifier, e.g. "0000-0001-5944-9960" */
export type OrcidId = string;

/** Digital Object Identifier, e.g. "10.1038/s41587-023-01769-x" */
export type DOI = string;

/** PubMed identifier, e.g. "37217649" */
export type PMID = string;

/** Semantic Scholar paper ID */
export type S2PaperId = string;

// ---------------------------------------------------------------------------
// JSON Resume base types (extended)
// ---------------------------------------------------------------------------

/** Physical or virtual location */
export interface Location {
  /** Street address */
  address?: string;
  city?: string;
  region?: string;
  /** ISO 3166-1 alpha-2 country code */
  countryCode?: string;
  postalCode?: string;
}

/** Social or professional profile link */
export interface Profile {
  /** Platform name, e.g. "GitHub", "Twitter", "ORCID" */
  network: string;
  username?: string;
  url?: string;
}

/** Top-level personal information */
export interface Basics {
  name: string;
  label?: string;
  image?: string;
  email?: string;
  phone?: string;
  url?: string;
  summary?: string;
  location?: Location;
  profiles?: Profile[];
  /** ORCID iD for linking to ORCID profile */
  orcidId?: OrcidId;
}

/** Work or research position */
export interface WorkEntry {
  name: string;
  position?: string;
  url?: string;
  startDate?: ISODate;
  endDate?: ISODate;
  summary?: string;
  highlights?: string[];
}

/** Academic degree or certification */
export interface EducationEntry {
  institution: string;
  url?: string;
  area?: string;
  studyType?: string;
  startDate?: ISODate;
  endDate?: ISODate;
  score?: string;
  courses?: string[];
}

/** Award, honor, or recognition */
export interface Award {
  title: string;
  date?: ISODate;
  awarder?: string;
  summary?: string;
}

/** Peer-reviewed or book publication */
export interface Certificate {
  name: string;
  date?: ISODate;
  issuer?: string;
  url?: string;
}

/** Spoken or written language proficiency */
export interface Language {
  language: string;
  fluency?: string;
}

/** Professional interest or research area */
export interface Interest {
  name: string;
  keywords?: string[];
}

/** Reference contact */
export interface Reference {
  name: string;
  reference?: string;
}

/** Volunteering or service entry */
export interface Volunteer {
  organization?: string;
  position?: string;
  url?: string;
  startDate?: ISODate;
  endDate?: ISODate;
  summary?: string;
  highlights?: string[];
}

/** Professional skill */
export interface Skill {
  name: string;
  level?: string;
  keywords?: string[];
}

/** Speaking or conference presentation */
export interface Presentation {
  title: string;
  event?: string;
  url?: string;
  date?: ISODate;
  summary?: string;
}

// ---------------------------------------------------------------------------
// Academic extensions
// ---------------------------------------------------------------------------

/** Author on a publication */
export interface Author {
  name: string;
  orcidId?: OrcidId;
  s2AuthorId?: string;
}

/**
 * Academic publication — journal article, preprint, book chapter, etc.
 * Extends JSON Resume with DOI, PMID, citation counts, and Semantic Scholar linkage.
 */
export interface Publication {
  /** Full title of the work */
  title: string;
  /** Publication type */
  type?: "journal-article" | "preprint" | "book-chapter" | "conference-paper" | "dataset" | "software" | "other";
  /** Ordered author list */
  authors?: Author[];
  /** Abbreviated author string, e.g. "Smith J, Jones B, et al." */
  authorsStr?: string;
  /** Journal or venue name */
  publisher?: string;
  /** Publication date (ISO 8601) */
  releaseDate?: ISODate;
  /** Year as number for sorting/display */
  year?: number;
  /** DOI (without https://doi.org/ prefix) */
  doi?: DOI;
  /** PubMed ID */
  pmid?: PMID;
  /** Semantic Scholar paper ID */
  s2PaperId?: S2PaperId;
  /** arXiv ID, e.g. "2301.07041" */
  arxivId?: string;
  /** Total citation count from Semantic Scholar */
  citationCount?: number;
  /** Influential citation count from Semantic Scholar */
  influentialCitationCount?: number;
  /** Direct URL to the publication */
  url?: string;
  /** Abstract text */
  abstract?: string;
  /** Volume, issue, pages — free text */
  volume?: string;
  issue?: string;
  pages?: string;
  /** Open access status */
  openAccess?: boolean;
  /** When this record was last fetched/updated */
  fetchedAt?: ISODate;
}

/** Research funding grant */
export interface Grant {
  /** Grant title / project name */
  title: string;
  /** Funding agency, e.g. "NIH", "NSF", "HHMI" */
  funder?: string;
  /** Grant/award number */
  awardNumber?: string;
  /** PI or co-PI role */
  role?: "PI" | "co-PI" | "co-I" | string;
  startDate?: ISODate;
  endDate?: ISODate;
  /** Total award amount in USD */
  amountUsd?: number;
  summary?: string;
  url?: string;
}

/** Open-source software repository */
export interface Software {
  /** Repository / package name */
  name: string;
  /** Short description */
  description?: string;
  url?: string;
  /** GitHub full name, e.g. "owner/repo" */
  githubRepo?: string;
  /** Primary programming language */
  language?: string;
  /** List of languages used */
  languages?: string[];
  /** GitHub star count */
  stars?: number;
  /** GitHub fork count */
  forks?: number;
  /** Number of open issues */
  openIssues?: number;
  /** Total commit count (approximate) */
  commits?: number;
  /** Published package name, e.g. npm/PyPI name */
  packageName?: string;
  /** Download count (lifetime) */
  downloads?: number;
  releaseDate?: ISODate;
  /** When this record was last fetched */
  fetchedAt?: ISODate;
  topics?: string[];
  license?: string;
}

/**
 * Citation metrics for the CV holder, sourced from Semantic Scholar.
 * Stored at the top level alongside publications.
 */
export interface CitationMetrics {
  /** h-index value */
  hIndex?: number;
  /** Total citation count across all works */
  totalCitations?: number;
  /** i10-index (papers with ≥10 citations) */
  i10Index?: number;
  /** Total number of publications indexed */
  publicationCount?: number;
  /** Semantic Scholar author ID */
  s2AuthorId?: string;
  /** When these metrics were last fetched */
  fetchedAt?: ISODate;
}

// ---------------------------------------------------------------------------
// Fetch metadata — tracks when each source was last ingested
// ---------------------------------------------------------------------------

/** Timestamps recording the last successful fetch per source */
export interface FetchMeta {
  orcid?: ISODate;
  semanticScholar?: ISODate;
  github?: ISODate;
  linkedinPdf?: ISODate;
}

// ---------------------------------------------------------------------------
// Root CVData type
// ---------------------------------------------------------------------------

/**
 * CVData — the canonical CV document type for cvkit.
 *
 * Extends JSON Resume with academic fields (publications, grants, software,
 * citation metrics) and fetch provenance metadata.
 *
 * @example
 * ```ts
 * const cv: CVData = {
 *   basics: { name: "Alex Pico", orcidId: "0000-0001-5944-9960" },
 *   publications: [],
 *   citationMetrics: { hIndex: 22 },
 * };
 * ```
 */
export interface CVData {
  /** Schema version for forward compatibility */
  $schema?: string;
  /** Personal and contact information */
  basics?: Basics;
  /** Employment and research positions */
  work?: WorkEntry[];
  /** Academic degrees */
  education?: EducationEntry[];
  /** Volunteer / service activities */
  volunteer?: Volunteer[];
  /** Awards and honors */
  awards?: Award[];
  /** Certifications */
  certificates?: Certificate[];
  /** Conference talks, seminars, and presentations */
  presentations?: Presentation[];
  /** Professional skills */
  skills?: Skill[];
  /** Languages spoken/written */
  languages?: Language[];
  /** Research interests */
  interests?: Interest[];
  /** Professional references */
  references?: Reference[];

  // --- Academic extensions ---

  /** Publications (journal articles, preprints, chapters, etc.) */
  publications?: Publication[];
  /** Research grants received */
  grants?: Grant[];
  /** Open-source software projects */
  software?: Software[];
  /** Aggregated citation metrics from Semantic Scholar */
  citationMetrics?: CitationMetrics;

  // --- Provenance ---

  /** Timestamps of last successful fetch per source */
  fetchMeta?: FetchMeta;
  /** Human-readable notes about this CV document */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Ingester result types
// ---------------------------------------------------------------------------

/** Partial CVData returned by any ingester — all fields optional */
export type IngestResult = Partial<CVData>;

/** Standard response envelope from an ingester */
export interface IngestResponse {
  /** Source identifier, e.g. "orcid", "semantic-scholar" */
  source: string;
  /** Whether the fetch succeeded */
  ok: boolean;
  /** Ingested partial CV data (present when ok=true) */
  data?: IngestResult;
  /** Error message (present when ok=false) */
  error?: string;
  /** ISO timestamp of this fetch */
  fetchedAt: ISODate;
}

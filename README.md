# cvkit

Academic CV management CLI — fetch from ORCID, GitHub, and Semantic Scholar; output a canonical `cv.json`.

```
cvkit fetch --orcid 0000-0001-5944-9960 --github AlexanderPico --s2-orcid 0000-0001-5944-9960
cvkit validate
cvkit build --format markdown
```

## Overview

`cvkit` keeps your academic CV as a single versioned JSON file (`cv.json`) that aggregates data from multiple sources. You maintain a thin override layer (`cv.overrides.json`) for manual corrections that survive re-ingestion.

**Sources:**
| Source | What it fetches |
|---|---|
| ORCID | Works, employment, education |
| Semantic Scholar | h-index, total citations, per-paper citation counts |
| GitHub | Repository metadata, stars, language stats |
| LinkedIn PDF | Work, education, skills from a profile export |

## Install

Requires Node.js ≥ 18.

```bash
# From the repo (development)
git clone git@github.com:AlexanderPico/cvkit.git
cd cvkit
pnpm install
pnpm build
node packages/cli/dist/cli.js --help

# Global install (once published to npm)
npm install -g @cvkit/cli
```

## Quickstart

```bash
# 1. Initialize a cv.json in the current directory
cvkit init

# 2. Fetch your ORCID profile (works, employment, education)
cvkit fetch --orcid 0000-0001-5944-9960

# 3. Enrich with citation metrics from Semantic Scholar
cvkit fetch --s2-orcid 0000-0001-5944-9960

# 4. Add your GitHub repos
cvkit fetch --github AlexanderPico

# 5. Or run all configured sources at once
cvkit fetch --all

# 6. Validate the result
cvkit validate

# 7. Preview a Markdown summary
cvkit build --format markdown

# 8. See what would change on the next fetch (dry-run diff)
cvkit diff --orcid 0000-0001-5944-9960
```

## Commands

### `cvkit init`

Initialize a new `cv.json` in the working directory (or `--dir <path>`).

```bash
cvkit init
cvkit init --overwrite   # replace existing file
```

### `cvkit fetch`

Pull data from one or more sources and merge into `cv.json`.

```
Options:
  --orcid <id>           ORCID iD
  --s2-orcid <id>        Semantic Scholar lookup by ORCID iD
  --s2-author <id>       Semantic Scholar author ID (most precise)
  --s2-name <name>       Semantic Scholar author name search
  --s2-key <key>         Semantic Scholar API key (or set S2_API_KEY env var)
  --github <username>    GitHub username
  --github-token <tok>   GitHub PAT (or set GITHUB_TOKEN env var)
  --linkedin-pdf <path>  Path to LinkedIn profile PDF
  --all                  Run all sources configured in cv.json
  -d, --dir <path>       Directory for cv.json (default: cwd)
```

### `cvkit validate`

Check `cv.json` for structural validity and print a summary.

### `cvkit diff`

Compare the current `cv.json` against a fresh fetch and show what would change — without writing anything.

```bash
cvkit diff --orcid 0000-0001-5944-9960
```

### `cvkit build`

Render `cv.json` to a target format.

```bash
cvkit build --format json      # pretty-print cv.json (default)
cvkit build --format markdown  # Markdown summary
cvkit build --format text      # Plain-text terminal summary
cvkit build --format markdown -o cv.md
```

## Manual overrides

Any field in `cv.overrides.json` wins over auto-fetched data and is never overwritten by `cvkit fetch`. Use this for:

- Correcting a publication title or journal name
- Adding grants or software that aren't in ORCID
- Fixing date ranges from LinkedIn

```json
// cv.overrides.json
{
  "basics": {
    "label": "Senior Scientist, Gladstone Institutes"
  },
  "grants": [
    {
      "title": "NIH R01 — Network-based analysis of disease",
      "funder": "NIH/NIGMS",
      "awardNumber": "R01GM123456",
      "role": "PI",
      "startDate": "2022-09",
      "endDate": "2027-08"
    }
  ]
}
```

## Architecture

```
cvkit/
├── packages/
│   ├── schema/          @cvkit/schema — CVData TypeScript types
│   ├── store/           @cvkit/store  — cv.json load/save/merge/diff
│   ├── ingesters/       @cvkit/ingesters
│   │   ├── orcid/         ORCID public API ingester
│   │   ├── semantic-scholar/  Semantic Scholar ingester
│   │   ├── github/        GitHub REST API ingester
│   │   └── linkedin-pdf/  Spatial PDF parser for LinkedIn exports
│   └── cli/             @cvkit/cli — cvkit binary (Commander.js)
├── vitest.config.ts     Shared test config
├── biome.json           Linting / formatting
└── pnpm-workspace.yaml
```

## CVData schema

`cv.json` extends [JSON Resume](https://jsonresume.org/schema/) with academic fields:

| Field | Type | Description |
|---|---|---|
| `publications` | `Publication[]` | Articles with DOI, PMID, citation counts |
| `grants` | `Grant[]` | Research funding |
| `software` | `Software[]` | Open-source repos with star counts |
| `citationMetrics` | `CitationMetrics` | h-index, total citations, i10-index |
| `fetchMeta` | `FetchMeta` | Timestamps of last fetch per source |

See [`packages/schema/src/index.ts`](packages/schema/src/index.ts) for the full type definitions.

## Development

```bash
pnpm install          # install all deps
pnpm build            # build all packages
pnpm test             # run all tests (Vitest)
pnpm lint             # Biome lint
pnpm lint:fix         # auto-fix lint issues
pnpm typecheck        # TypeScript project references check
```

### Adding a changeset

```bash
pnpm changeset        # describe changes for the next release
pnpm changeset version  # bump versions
pnpm release          # publish to npm
```

## Environment variables

| Variable | Used by | Description |
|---|---|---|
| `S2_API_KEY` | Semantic Scholar ingester | API key for higher rate limits |
| `GITHUB_TOKEN` | GitHub ingester | PAT for 5,000 req/hr (vs 60 unauthenticated) |

## License

MIT

# Analysis Scripts

This directory contains both build/development scripts and research/analysis scripts.

## Analysis Scripts

### Ahrefs Comparison Tools

Used to compare SquirrelScan audit results against Ahrefs data to identify feature gaps and validate detection accuracy.

#### Prerequisites

1. Create a `data/` directory structure:

   ```
   app/data/
   ├── nikcub.me/
   │   ├── Error-404_page.csv
   │   ├── Missing-meta-description.csv
   │   └── ... (other Ahrefs CSV exports)
   ├── elegante.com.au/
   │   └── ... (Ahrefs CSV exports)
   └── ... (other domains)
   ```

2. Export Ahrefs data as CSV files (UTF-16LE encoding)

#### Usage

**Basic Comparison:**

```bash
bun run scripts/compare-ahrefs.ts
```

Outputs: High-level comparison showing issue type coverage and gaps

**Detailed Page-Level Analysis:**

```bash
bun run scripts/compare-ahrefs-detailed.ts
```

Outputs:

- `comparison_report_detailed.md` - Full analysis with specific page examples
- `COMPARISON_SUMMARY.txt` - Executive summary

#### What These Scripts Do

1. Parse Ahrefs CSV exports (handle UTF-16LE encoding)
2. Run SquirrelScan audits on the same domains
3. Map Ahrefs issue types to SquirrelScan rules
4. Identify:
   - Missing rules (gaps in our detection)
   - Unique capabilities (rules we have that Ahrefs doesn't)
   - Detection accuracy (page-level validation)

#### Data Format

Ahrefs CSVs should follow this structure:

- UTF-16LE encoded
- Tab-separated values
- Column 2 typically contains the affected URL

### Ahrefs Audit Runner

Run fresh audits for every Ahrefs fixture, store timestamped reports, and regenerate comparison artifacts:

```bash
bun run scripts/run-ahrefs-audits.ts
```

Options:

- `--max-pages <n>`: override crawl budget (defaults to config)
- `--no-refresh`: reuse cached crawls instead of forcing a fresh crawl
- `--skip-compare`: skip running the comparison scripts
- `--target <domain[,domain]>`: limit to specific Ahrefs fixtures
- `--run-id <id>`: reuse a timestamped run directory (for incremental runs)
- `--summarize-only`: rebuild summary/metadata from the latest reports without re-crawling

Notes:

- Each domain runs in an isolated child process to keep TLS/client state stable across multiple audits.
- Summaries are stored under `reports/ahrefs-runs/<run-id>/`, while the latest report artifacts stay in `app/data/reports/ahrefs-comparison/`.

## Build Scripts

(Document other scripts here)

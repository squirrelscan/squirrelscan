// squirrelscan/repo#3138: glossary.ts --check fails on each guard with a
// file:line message, and --write regenerates every block and the Glossary tab
// idempotently. Each test writes a small docs tree to a temp dir, so no fixture
// page ends up in the published site.

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  checkGlossary,
  frontmatterOf,
  type Hub,
  setFrontmatter,
  type Term,
  withGlossaryTab,
  writeGlossary,
} from "./glossary";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function rulePage(
  id: string,
  hub: string,
  title: string,
  severity = "warning",
): string {
  return [
    "---",
    `title: "${title}"`,
    `description: "What ${id} flags."`,
    "---",
    "",
    "## How to fix it",
    "",
    "| | |",
    "|---|---|",
    `| **Rule ID** | \`${id}\` |`,
    `| **Category** | [Crawlability](/rules/${hub}) |`,
    "| **Scope** | Per-page |",
    `| **Severity** | ${severity} |`,
    "| **Weight** | 5/10 |",
    "",
  ].join("\n");
}

const CRAWL_HUB = [
  "---",
  'title: "Crawlability"',
  'description: "Robots.txt and sitemaps."',
  "---",
  "",
  "Crawlability rules cover robots.txt and sitemaps.",
  "",
  '<Card title="robots.txt" href="/rules/crawl/robots-txt">Checks robots.txt.</Card>',
  "",
  "- [Sitemap](/rules/crawl/sitemap-exists)",
  "",
  "Contrast: the 4.5:1 rule is not a count.",
  "",
  "```toml",
  'disable = ["crawl/*"] # 2 rules',
  "```",
  "",
].join("\n");

const SEO_OVERVIEW = [
  "---",
  'title: "SEO"',
  'description: "The SEO score group."',
  "---",
  "",
  '<Card title="Crawlability" href="/rules/crawl">Robots.txt (2 rules)</Card>',
  "",
].join("\n");

function term(overrides: Partial<Term> & Pick<Term, "slug" | "term">): Term {
  return {
    aliases: [],
    format: "entry",
    hub: "crawl",
    title: null,
    primary_query: overrides.term,
    definition: `What ${overrides.term} is.`,
    rules: ["crawl/robots-txt"],
    related: [],
    learn: [],
    tools: [],
    authority: ["https://www.rfc-editor.org/rfc/rfc9309"],
    grounding_note: null,
    batch: "1",
    ...overrides,
  };
}

const HUBS: Hub[] = [
  {
    code: "crawl",
    category: "crawl",
    group: "seo",
    sidebarTitle: "Crawlability",
    title: "Crawlability audit rules: robots.txt and sitemaps",
    learn: [],
    tools: ["https://squirrelscan.com/tools/robots-txt-generator"],
    related: [],
  },
];

const TERMS: Term[] = [
  term({
    slug: "robots-txt",
    term: "robots.txt",
    format: "page",
    title: "What is robots.txt? Rules and syntax",
    related: ["xml-sitemap"],
  }),
  term({
    slug: "xml-sitemap",
    term: "XML sitemap",
    rules: ["crawl/sitemap-exists"],
    related: ["robots-txt"],
  }),
];

/** robots.txt alone, with no related term to dangle. */
const SOLO: Term = { ...TERMS[0]!, related: [] };

interface Fixture {
  files?: Record<string, string>;
  terms?: Term[];
  hubs?: Hub[];
  baseline?: Array<{ file: string; message: string; reason: string }>;
}

function docs({
  files = {},
  terms = TERMS,
  hubs = HUBS,
  baseline,
}: Fixture = {}): string {
  root = mkdtempSync(join(tmpdir(), "docs-glossary-"));
  const all: Record<string, string> = {
    "docs.json": `${JSON.stringify(
      {
        name: "docs",
        navigation: {
          tabs: [
            { tab: "Rules", groups: [] },
            { tab: "Cloud", groups: [] },
          ],
        },
      },
      null,
      2,
    )}\n`,
    ".tanglyignore": "/scripts/\n",
    "rules/crawl/index.mdx": CRAWL_HUB,
    "rules/crawl/robots-txt.mdx": rulePage(
      "crawl/robots-txt",
      "crawl",
      "robots.txt checks",
      "error",
    ),
    "rules/crawl/sitemap-exists.mdx": rulePage(
      "crawl/sitemap-exists",
      "crawl",
      "No XML sitemap found",
    ),
    "rules/seo/index.mdx": SEO_OVERVIEW,
    "scripts/glossary/terms.json": `${JSON.stringify({ terms }, null, 2)}\n`,
    "scripts/glossary/hubs.json": `${JSON.stringify({ hubs }, null, 2)}\n`,
    ...(baseline
      ? {
          "scripts/glossary/baseline.json": JSON.stringify({
            entries: baseline,
          }),
        }
      : {}),
    ...files,
  };
  for (const [path, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const messages = (dir: string): string[] =>
  checkGlossary(dir).problems.map((p) => `${p.file}:${p.line}: ${p.message}`);

const replaceIn = (path: string, from: string, to: string): void => {
  const file = join(root, path);
  writeFileSync(file, readFileSync(file, "utf8").replaceAll(from, to));
};

describe("glossary --check", () => {
  test("a consistent tree passes and prints coverage without failing on uncovered rules", () => {
    const dir = docs({ terms: [SOLO] });
    const result = checkGlossary(dir);
    expect(result.problems).toEqual([]);
    expect(result.coverage).toMatchObject({
      covered: 1,
      total: 2,
      uncovered: ["crawl/sitemap-exists"],
    });
  });

  test("a markdown file under scripts/ fails: tangly would publish it as a page", () => {
    const dir = docs({
      terms: [SOLO],
      files: {
        "scripts/glossary/AUTHORING.md": "# Notes\n",
        "scripts/glossary/term-template.mdx": "---\ntitle: x\n---\n",
        "scripts/glossary/AUTHORING.txt": "fine\n",
      },
    });
    const found = messages(dir).filter((m) => m.includes("under scripts/"));
    expect(found).toEqual([
      "scripts/glossary/AUTHORING.md:1: markdown under scripts/ is published as a docs page by tangly: use a non-page extension such as .txt",
      "scripts/glossary/term-template.mdx:1: markdown under scripts/ is published as a docs page by tangly: use a non-page extension such as .txt",
    ]);
  });

  test("a term naming a nonexistent rule fails at its line in terms.json", () => {
    const dir = docs({
      terms: [TERMS[0]!, { ...TERMS[1]!, rules: ["crawl/sitemap-exist"] }],
    });
    const text = readFileSync(join(dir, "scripts/glossary/terms.json"), "utf8");
    const line =
      text.split("\n").findIndex((l) => l.includes('"slug": "xml-sitemap"')) +
      1;
    expect(messages(dir)).toEqual([
      `scripts/glossary/terms.json:${line}: term xml-sitemap: names rule crawl/sitemap-exist, which has no docs rule page (no **Rule ID** row names it)`,
    ]);
  });

  test("bad term data: unknown related term, self-relation, no rules, no authority, MDX markup", () => {
    const dir = docs({
      terms: [
        { ...TERMS[0]!, related: ["robots-txt", "nope"], authority: [] },
        { ...TERMS[1]!, rules: [], definition: "The <urlset> root." },
      ],
    });
    const found = messages(dir).join("\n");
    expect(found).toContain("term robots-txt: relates to itself");
    expect(found).toContain("term robots-txt: related term nope is not a term");
    expect(found).toContain("term robots-txt: has no authority URL");
    expect(found).toContain("term xml-sitemap: lists no rules");
    expect(found).toContain(
      "term xml-sitemap: definition has < > { or } outside a code span",
    );
  });

  test("a rule missing from its hub fails", () => {
    const dir = docs({ terms: [SOLO] });
    replaceIn(
      "rules/crawl/index.mdx",
      "- [Sitemap](/rules/crawl/sitemap-exists)",
      "",
    );
    expect(messages(dir)).toEqual([
      "rules/crawl/index.mdx:1: hub does not link rule crawl/sitemap-exists, whose **Category** is /rules/crawl",
    ]);
  });

  test("a category Card on a category hub fails; the same Card on an overview page passes", () => {
    const dir = docs({ terms: [SOLO] });
    replaceIn(
      "rules/crawl/index.mdx",
      "Crawlability rules cover",
      '<Card\n  title="Links"\n  href="/rules/links">Link checks</Card>\n\nCrawlability rules cover',
    );
    expect(messages(dir)).toEqual([
      'rules/crawl/index.mdx:6: category hub has a category Card (href="/rules/links"): the private rule-count test would read it as an overview page; link categories inline',
    ]);
  });

  test("'N rules' prose on a category hub fails, in prose and frontmatter but not in code or a ratio", () => {
    const dir = docs({ terms: [SOLO] });
    replaceIn(
      "rules/crawl/index.mdx",
      "Crawlability rules cover",
      "These 20 audit rules cover",
    );
    replaceIn(
      "rules/crawl/index.mdx",
      '"Robots.txt and sitemaps."',
      '"2 rules for robots.txt."',
    );
    expect(messages(dir)).toEqual([
      'rules/crawl/index.mdx:3: category hub states a rule count ("2 rules"): counts here are not kept in sync; let the rule table show the count',
      'rules/crawl/index.mdx:6: category hub states a rule count ("20 audit rules"): counts here are not kept in sync; let the rule table show the count',
    ]);
  });

  test("an over-length title or description fails on hubs and glossary pages, and in the data", () => {
    const long = "x".repeat(61);
    const dir = docs({
      terms: [{ ...TERMS[0]!, title: long }],
      files: {
        "glossary/index.mdx": `---\ntitle: "Glossary"\ndescription: "${"y".repeat(156)}"\n---\n`,
      },
    });
    replaceIn(
      "rules/crawl/index.mdx",
      'title: "Crawlability"',
      `title: "${"z".repeat(61)}"`,
    );
    const found = messages(dir);
    expect(found).toContain(
      "glossary/index.mdx:3: description is 156 characters (max 155)",
    );
    expect(found).toContain(
      "rules/crawl/index.mdx:2: title is 61 characters (max 60)",
    );
    expect(
      found.some((m) =>
        m.endsWith("term robots-txt: title is 61 characters (max 60)"),
      ),
    ).toBe(true);
  });

  test("an em-dash fails in prose and in a definition, not inside a code block", () => {
    const dir = docs({
      terms: [TERMS[0]!, { ...TERMS[1]!, definition: "A file — an XML one." }],
    });
    replaceIn(
      "rules/crawl/index.mdx",
      "Crawlability rules cover",
      "Crawlability — rules cover",
    );
    replaceIn("rules/crawl/index.mdx", "# 2 rules", "# —");
    const found = messages(dir);
    expect(found).toContain(
      "rules/crawl/index.mdx:6: has an em-dash (use a colon, comma or period)",
    );
    expect(
      found.some((m) =>
        m.includes("term xml-sitemap: definition has an em-dash"),
      ),
    ).toBe(true);
    expect(
      found.filter((m) => m.startsWith("rules/crawl/index.mdx")),
    ).toHaveLength(1);
  });

  test("banned phrases fail; the allowlisted proper noun passes", () => {
    const dir = docs({ terms: [SOLO] });
    replaceIn(
      "rules/crawl/index.mdx",
      "Crawlability rules cover",
      "Cloudflare Agent Readiness differs from agent readiness. These SEO rules cover",
    );
    expect(messages(dir)).toEqual([
      'rules/crawl/index.mdx:6: says "SEO rules"',
      'rules/crawl/index.mdx:6: says "agent readiness"',
    ]);
  });

  test("a duplicate title fails on both pages, and a planned term page may not take one", () => {
    const dir = docs({
      terms: [{ ...TERMS[0]!, title: "No XML sitemap found" }],
    });
    replaceIn("rules/seo/index.mdx", 'title: "SEO"', 'title: "Crawlability"');
    const found = messages(dir);
    expect(found).toContain(
      "rules/crawl/index.mdx:2: same title as rules/seo/index.mdx",
    );
    expect(found).toContain(
      "rules/seo/index.mdx:2: same title as rules/crawl/index.mdx",
    );
    expect(
      found.some((m) =>
        m.endsWith(
          "term robots-txt: title is already the title of rules/crawl/sitemap-exists.mdx",
        ),
      ),
    ).toBe(true);
  });

  test("glossary pages must match a page term", () => {
    const dir = docs({
      files: {
        "glossary/orphan.mdx": '---\ntitle: "Orphan"\n---\n',
        "glossary/xml-sitemap.mdx": '---\ntitle: "XML sitemap"\n---\n',
      },
    });
    const found = messages(dir).join("\n");
    expect(found).toContain(
      "glossary/orphan.mdx:1: glossary page has no term in terms.json",
    );
    expect(found).toContain(
      'glossary/xml-sitemap.mdx:1: term xml-sitemap is an index-only entry (format "entry")',
    );
  });

  test("malformed markers fail", () => {
    const dir = docs({
      files: {
        "rules/crawl/sitemap-exists.mdx": `${rulePage("crawl/sitemap-exists", "crawl", "No XML sitemap found")}\n{/* glossary:backlinks:start */}\n{/* hub:rules:start */}\n`,
      },
    });
    const found = messages(dir).join("\n");
    expect(found).toContain(
      "rules/crawl/sitemap-exists.mdx:17: generated block hub:rules does not belong on this page",
    );
    expect(found).toContain(
      "rules/crawl/sitemap-exists.mdx:16: glossary:backlinks:start has no glossary:backlinks:end",
    );
  });

  test("docs/scripts must stay out of the published site", () => {
    const dir = docs({
      terms: [SOLO],
      files: { ".tanglyignore": "/node_modules/\n" },
    });
    expect(messages(dir)).toEqual([
      ".tanglyignore:1: must list /scripts/ so the glossary data and scripts are not published",
    ]);
  });

  test("a baseline entry hides a known finding; one that matches nothing fails", () => {
    const finding = "same title as rules/seo/index.mdx";
    const dir = docs({
      terms: [SOLO],
      baseline: [
        { file: "rules/crawl/index.mdx", message: finding, reason: "known" },
        { file: "rules/crawl/index.mdx", message: "gone", reason: "fixed" },
      ],
    });
    replaceIn("rules/seo/index.mdx", 'title: "SEO"', 'title: "Crawlability"');
    expect(messages(dir)).toEqual([
      "rules/seo/index.mdx:2: same title as rules/crawl/index.mdx",
      "scripts/glossary/baseline.json:1: stale entry (rules/crawl/index.mdx: gone): it no longer matches a finding, remove it",
    ]);
  });
});

describe("glossary --write", () => {
  const TERM_PAGE = [
    "---",
    'title: "Old title"',
    'description: "What robots.txt is."',
    "---",
    "",
    "A **robots.txt** file tells crawlers what to fetch.",
    "",
    "{/* glossary:hub:start */}",
    "{/* glossary:hub:end */}",
    "",
    "{/* glossary:rules:start */}",
    "stale",
    "{/* glossary:rules:end */}",
    "",
    "{/* glossary:run:start */}",
    "{/* glossary:run:end */}",
    "",
    "{/* glossary:related:start */}",
    "{/* glossary:related:end */}",
    "",
    "{/* glossary:jsonld:start */}",
    "{/* glossary:jsonld:end */}",
    "",
  ].join("\n");
  const INDEX =
    '---\ntitle: "Website audit glossary"\ndescription: "Terms."\n---\n\n{/* glossary:index:start */}\n{/* glossary:index:end */}\n\n{/* glossary:jsonld:start */}\n{/* glossary:jsonld:end */}\n';
  const HUB_MARKERS =
    "{/* hub:start-here:start */}\n{/* hub:start-here:end */}\n\n{/* hub:rules:start */}\n{/* hub:rules:end */}\n\n{/* hub:terms:start */}\n{/* hub:terms:end */}\n";

  const tree = () =>
    docs({
      files: {
        "glossary/index.mdx": INDEX,
        "glossary/robots-txt.mdx": TERM_PAGE,
        "rules/crawl/index.mdx": `---\ntitle: "Crawlability"\ndescription: "Robots.txt and sitemaps."\n---\n\nIntro.\n\n${HUB_MARKERS}`,
        "rules/crawl/robots-txt.mdx": `${rulePage("crawl/robots-txt", "crawl", "robots.txt checks", "error")}\n{/* glossary:backlinks:start */}\n{/* glossary:backlinks:end */}\n`,
      },
    });

  test("--check reports every stale block, frontmatter field and the tab", () => {
    const found = messages(tree());
    expect(found).toContain(
      "glossary/robots-txt.mdx:11: generated block glossary:rules is out of date: run `bun scripts/glossary.ts --write`",
    );
    expect(found).toContain(
      'glossary/robots-txt.mdx:2: frontmatter title differs from the data file ("What is robots.txt? Rules and syntax"): run `bun scripts/glossary.ts --write`',
    );
    expect(found).toContain(
      "docs.json:1: the Glossary tab differs from the generated one: run `bun scripts/glossary.ts --write`",
    );
    expect(found).toContain(
      "rules/crawl/index.mdx:8: generated block hub:start-here is out of date: run `bun scripts/glossary.ts --write`",
    );
  });

  test("regenerates every block and the Glossary tab, then a second run changes nothing", () => {
    const dir = tree();
    expect(writeGlossary(dir)).toEqual([
      "docs.json",
      "glossary/index.mdx",
      "glossary/robots-txt.mdx",
      "rules/crawl/index.mdx",
      "rules/crawl/robots-txt.mdx",
    ]);
    expect(messages(dir)).toEqual([]);
    const snapshot = (path: string) => readFileSync(join(dir, path), "utf8");
    const before = [
      "docs.json",
      "glossary/index.mdx",
      "glossary/robots-txt.mdx",
    ].map(snapshot);
    expect(writeGlossary(dir)).toEqual([]);
    expect(
      ["docs.json", "glossary/index.mdx", "glossary/robots-txt.mdx"].map(
        snapshot,
      ),
    ).toEqual(before);

    const page = snapshot("glossary/robots-txt.mdx");
    expect(page).toContain(
      'title: "What is robots.txt? Rules and syntax"\nsidebarTitle: "robots.txt"',
    );
    expect(page).toContain(
      "A **robots.txt** file tells crawlers what to fetch.",
    );
    expect(page).toContain("Category: [Crawlability](/rules/crawl)");
    expect(page).toContain(
      "| [robots.txt checks](/rules/crawl/robots-txt) | What crawl/robots-txt flags. | error |",
    );
    expect(page).toContain(
      "squirrel audit https://example.com --rule-include crawl/robots-txt",
    );
    expect(page).toContain(
      "- [XML sitemap](/glossary#xml-sitemap): What XML sitemap is.",
    );
    expect(page).not.toContain("stale");
    const ld = (text: string): Record<string, unknown> => {
      const raw = /<script type="application\/ld\+json">\{`(.*)`\}<\/script>/.exec(
        text,
      )?.[1];
      // The build reads the template literal, so unescape it the same way.
      return JSON.parse(
        Function(`return \`${raw}\`;`)() as string,
      ) as Record<string, unknown>;
    };
    expect(ld(page)).toMatchObject({
      "@type": "DefinedTerm",
      "@id": "https://docs.squirrelscan.com/glossary/robots-txt#term",
      name: "robots.txt",
      description: "What robots.txt is.",
      url: "https://docs.squirrelscan.com/glossary/robots-txt",
      inDefinedTermSet: { "@id": "https://docs.squirrelscan.com/glossary#set" },
    });
    expect(ld(snapshot("glossary/index.mdx"))).toMatchObject({
      "@type": "DefinedTermSet",
      "@id": "https://docs.squirrelscan.com/glossary#set",
      url: "https://docs.squirrelscan.com/glossary",
      hasDefinedTerm: expect.arrayContaining([
        expect.objectContaining({
          "@type": "DefinedTerm",
          name: "XML sitemap",
          url: "https://docs.squirrelscan.com/glossary#xml-sitemap",
        }),
      ]),
    });

    const index = snapshot("glossary/index.mdx");
    expect(index).toContain("### robots.txt \\{#robots-txt\\}");
    expect(index).toContain(
      "[Read the full definition](/glossary/robots-txt).",
    );
    expect(index).toContain(
      "Checked by [No XML sitemap found](/rules/crawl/sitemap-exists).",
    );

    const hub = snapshot("rules/crawl/index.mdx");
    expect(hub).toContain(
      'title: "Crawlability audit rules: robots.txt and sitemaps"',
    );
    expect(hub).toContain(
      "| [No XML sitemap found](/rules/crawl/sitemap-exists) | What crawl/sitemap-exists flags. | warning | Per-page |",
    );
    expect(hub.indexOf("- [robots.txt checks]")).toBeLessThan(
      hub.indexOf("- [No XML sitemap found]"),
    );
    expect(hub).toContain("## Key terms");

    expect(snapshot("rules/crawl/robots-txt.mdx")).toContain(
      "Glossary: [robots.txt](/glossary/robots-txt).",
    );
    const tabs = (
      JSON.parse(snapshot("docs.json")) as {
        navigation: { tabs: Array<{ tab: string }> };
      }
    ).navigation.tabs;
    expect(tabs.map((t) => t.tab)).toEqual(["Rules", "Glossary", "Cloud"]);
    expect(tabs[1]).toMatchObject({
      groups: [
        { group: "Glossary", pages: ["glossary/index"] },
        { group: "SEO", pages: ["glossary/robots-txt"] },
      ],
    });
  });

  test("a term page or the index without a glossary:jsonld block fails", () => {
    const dir = tree();
    writeGlossary(dir);
    replaceIn("glossary/robots-txt.mdx", "{/* glossary:jsonld:start */}", "");
    replaceIn("glossary/robots-txt.mdx", "{/* glossary:jsonld:end */}", "");
    expect(messages(dir)).toContain(
      "glossary/robots-txt.mdx:1: glossary page has no glossary:jsonld block (its DefinedTerm JSON-LD): add the start and end markers at the end of the page, then run `bun scripts/glossary.ts --write`",
    );
  });

  test("a hand edit inside a block is reported, and --write puts it back", () => {
    const dir = tree();
    writeGlossary(dir);
    replaceIn(
      "rules/crawl/index.mdx",
      "[No XML sitemap found](/rules/crawl/sitemap-exists)",
      "removed",
    );
    expect(messages(dir)).toEqual([
      "rules/crawl/index.mdx:1: hub does not link rule crawl/sitemap-exists, whose **Category** is /rules/crawl",
      "rules/crawl/index.mdx:9: generated block hub:start-here is out of date: run `bun scripts/glossary.ts --write`",
      "rules/crawl/index.mdx:20: generated block hub:rules is out of date: run `bun scripts/glossary.ts --write`",
    ]);
    writeGlossary(dir);
    expect(messages(dir)).toEqual([]);
  });
});

test("the CLI exits 1 with file:line messages on a bad rule id", () => {
  const dir = docs({ terms: [{ ...TERMS[0]!, rules: ["crawl/not-a-rule"] }] });
  const run = Bun.spawnSync([
    "bun",
    join(import.meta.dir, "glossary.ts"),
    "--check",
    dir,
  ]);
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toMatch(
    /^scripts\/glossary\/terms\.json:\d+: term robots-txt: names rule crawl\/not-a-rule, which has no docs rule page/m,
  );
  expect(run.stdout.toString()).toContain(
    "Glossary coverage: 0/2 rules linked from a term",
  );
});

describe("review edge cases", () => {
  test("a category Card hidden in a comment or code fence still fails: the private test reads raw text", () => {
    const dir = docs({ terms: [SOLO] });
    replaceIn(
      "rules/crawl/index.mdx",
      "Crawlability rules cover",
      '<!-- <Card href="/rules/links">x</Card> -->\n\nCrawlability rules cover',
    );
    expect(messages(dir)).toEqual([
      'rules/crawl/index.mdx:6: category hub has a category Card (href="/rules/links"): the private rule-count test would read it as an overview page; link categories inline',
    ]);
  });

  test("a marker quoted in a code fence is left alone", () => {
    const quoted =
      "```mdx\n{/* glossary:backlinks:start */}\nexample\n{/* glossary:backlinks:end */}\n```\n";
    const dir = docs({
      terms: [SOLO],
      files: {
        "rules/crawl/sitemap-exists.mdx": `${rulePage("crawl/sitemap-exists", "crawl", "No XML sitemap found")}\n${quoted}`,
      },
    });
    expect(writeGlossary(dir)).toEqual([]);
    expect(messages(dir)).toEqual([]);
  });

  test("duplicate Glossary tabs collapse to one in a single write", () => {
    const tab = { tab: "Glossary", groups: [] };
    const config = {
      navigation: { tabs: [tab, { tab: "Rules", groups: [] }, tab] },
    };
    expect(
      withGlossaryTab(config, null).navigation?.tabs?.map((t) => t.tab),
    ).toEqual(["Rules"]);
  });

  test("setFrontmatter replaces a block scalar whole and adds a missing key after title", () => {
    const source = '---\ntitle: |\n  Old title\ndescription: "d"\n---\nbody\n';
    expect(setFrontmatter(source, { title: "New", sidebarTitle: "S" })).toBe(
      '---\ntitle: "New"\nsidebarTitle: "S"\ndescription: "d"\n---\nbody\n',
    );
  });

  test("two planned term pages with the same title fail, though neither is written", () => {
    const dir = docs({
      terms: [
        { ...SOLO },
        {
          ...TERMS[1]!,
          related: [],
          format: "page",
          title: "what is robots.txt? Rules and syntax",
        },
      ],
    });
    expect(
      messages(dir).filter((m) => m.includes("same title as term")),
    ).toEqual([
      expect.stringMatching(
        /^scripts\/glossary\/terms\.json:\d+: term xml-sitemap: same title as term robots-txt$/,
      ),
    ]);
  });

  test("rule counts with a thousands separator or a plus sign fail on a category hub", () => {
    const dir = docs({ terms: [SOLO] });
    replaceIn(
      "rules/crawl/index.mdx",
      "Crawlability rules cover",
      "Of 1,000 rules and 300+ audit rules, these cover",
    );
    expect(messages(dir)).toEqual([
      'rules/crawl/index.mdx:6: category hub states a rule count ("1,000 rules"): counts here are not kept in sync; let the rule table show the count',
      'rules/crawl/index.mdx:6: category hub states a rule count ("300+ audit rules"): counts here are not kept in sync; let the rule table show the count',
    ]);
  });

  test("a hub link with a trailing slash, a relative path or a reference definition counts", () => {
    const dir = docs({ terms: [SOLO] });
    replaceIn(
      "rules/crawl/index.mdx",
      '<Card title="robots.txt" href="/rules/crawl/robots-txt">Checks robots.txt.</Card>',
      "See [robots.txt][r].\n\n[r]: crawl/robots-txt#how-to-fix",
    );
    replaceIn(
      "rules/crawl/index.mdx",
      "(/rules/crawl/sitemap-exists)",
      "(/rules/crawl/sitemap-exists/)",
    );
    expect(messages(dir)).toEqual([]);
    // `./x` on /rules/crawl resolves to /rules/x, as in a browser: not a link to the rule.
    replaceIn(
      "rules/crawl/index.mdx",
      "(/rules/crawl/sitemap-exists/)",
      "(./sitemap-exists)",
    );
    expect(messages(dir)).toEqual([
      "rules/crawl/index.mdx:1: hub does not link rule crawl/sitemap-exists, whose **Category** is /rules/crawl",
    ]);
  });

  test("an unclosed code fence is an error, so markers after it are not silently ignored", () => {
    const dir = docs({
      terms: [SOLO],
      files: {
        "rules/crawl/robots-txt.mdx": `${rulePage("crawl/robots-txt", "crawl", "robots.txt checks", "error")}\n\`\`\`bash\nsquirrel audit\n\n{/* glossary:backlinks:start */}\n{/* glossary:backlinks:end */}\n`,
      },
    });
    expect(messages(dir)).toEqual([
      "rules/crawl/robots-txt.mdx:16: code fence is never closed: everything after it, generated-block markers included, reads as code",
    ]);
    expect(writeGlossary(dir)).toEqual([]);
  });

  test("aliases follow the copy rules and may not take another term's slug, name or alias", () => {
    const dir = docs({
      terms: [
        { ...TERMS[0]!, aliases: ["AI readiness file", "robots file"] },
        {
          ...TERMS[1]!,
          aliases: ["Robots File", "sitemap — xml", "ROBOTS-TXT"],
        },
      ],
    });
    const found = messages(dir).map((m) => m.replace(/^[^ ]+ /, ""));
    expect(found).toEqual([
      'term robots-txt: alias "AI readiness file" says "AI readiness"',
      'term xml-sitemap: alias "ROBOTS-TXT" is also the slug, name or alias of term robots-txt',
      'term xml-sitemap: alias "Robots File" is also the slug, name or alias of term robots-txt',
      'term xml-sitemap: alias "sitemap — xml" has an em-dash (use a colon, comma or period)',
    ]);
  });

  test("a description in a block scalar or wrapped onto indented lines is length-checked", () => {
    const long = "word ".repeat(40).trim();
    const half = "word ".repeat(20).trim();
    const dir = docs({
      terms: [SOLO],
      files: {
        "glossary/index.mdx": `---\ntitle: "Glossary"\ndescription: >-\n  ${half}\n  ${half}\n---\n`,
      },
    });
    replaceIn(
      "rules/crawl/index.mdx",
      'description: "Robots.txt and sitemaps."',
      `description: "${half}\n  ${half}"`,
    );
    expect(messages(dir).filter((m) => m.includes("description is"))).toEqual([
      `glossary/index.mdx:3: description is ${long.length} characters (max 155)`,
      `rules/crawl/index.mdx:3: description is ${long.length} characters (max 155)`,
    ]);
  });

  test("setFrontmatter leaves a block scalar alone when it already holds the value", () => {
    const source = "---\ntitle: >-\n  Two\n  lines\n---\nbody\n";
    expect(frontmatterOf(source).get("title")).toEqual({
      value: "Two lines",
      line: 2,
    });
    expect(setFrontmatter(source, { title: "Two lines" })).toBe(source);
    // A missing key goes after the whole title, not inside it.
    expect(
      setFrontmatter(source, { title: "Two lines", sidebarTitle: "S" }),
    ).toBe('---\ntitle: >-\n  Two\n  lines\nsidebarTitle: "S"\n---\nbody\n');
  });

  test("frontmatterOf: comments, blank lines and nested maps", () => {
    const fields = frontmatterOf(
      [
        "---",
        'title: "Example"',
        "  # an editorial note",
        "description: plain words",
        "  # ends the plain scalar",
        'summary: "Short',
        "",
        '  and longer"',
        "seo:",
        "  noindex: true",
        "---",
      ].join("\n"),
    );
    expect(fields.get("title")).toEqual({ value: "Example", line: 2 });
    expect(fields.get("description")).toEqual({
      value: "plain words",
      line: 4,
    });
    expect(fields.get("summary")).toEqual({
      value: "Short and longer",
      line: 6,
    });
    expect(fields.get("seo")).toEqual({ value: "", line: 9 });
  });

  test("a percent-encoded hub link reaches the rule", () => {
    const dir = docs({ terms: [SOLO] });
    replaceIn(
      "rules/crawl/index.mdx",
      "(/rules/crawl/sitemap-exists)",
      "(/rules/crawl/%73itemap-exists)",
    );
    expect(messages(dir)).toEqual([]);
  });

  test("rule text with MDX syntax is escaped in generated blocks", () => {
    const dir = docs({
      terms: [SOLO],
      files: {
        "glossary/index.mdx":
          '---\ntitle: "Glossary"\ndescription: "Terms."\n---\n\n{/* glossary:index:start */}\n{/* glossary:index:end */}\n',
      },
    });
    replaceIn(
      "rules/crawl/robots-txt.mdx",
      'title: "robots.txt checks"',
      'title: "robots.txt <meta> \\\\{x} | y"',
    );
    writeGlossary(dir);
    expect(readFileSync(join(dir, "glossary/index.mdx"), "utf8")).toContain(
      "[robots.txt \\<meta\\> \\\\\\{x\\} \\| y](/rules/crawl/robots-txt)",
    );
  });
});

// squirrelscan/repo#3152: rule pages link up to the terms that list them.
describe("rule page backlinks (rule_backlinks)", () => {
  const ON: Hub[] = [{ ...HUBS[0]!, rule_backlinks: true }];
  const RELATED = [
    "## Related rules",
    "",
    "- [crawl/sitemap-exists](/rules/crawl/sitemap-exists): the sitemap.",
    "",
    "Crawlability findings ship in every audit.",
    "",
    "",
    "## References",
    "",
    "- [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309)",
    "",
  ].join("\n");
  const withRelated = (tail = RELATED) =>
    `${rulePage("crawl/robots-txt", "crawl", "robots.txt checks", "error")}\n${tail}`;
  const read = (dir: string, path: string) =>
    readFileSync(join(dir, path), "utf8");

  test("--check fails on a listed rule page without the block; --write adds it at the end of Related rules, once", () => {
    const dir = docs({
      terms: [SOLO],
      hubs: ON,
      files: { "rules/crawl/robots-txt.mdx": withRelated() },
    });
    expect(messages(dir)).toEqual([
      "rules/crawl/robots-txt.mdx:21: rule page has no glossary:backlinks block, and a term lists it: run `bun scripts/glossary.ts --write`",
    ]);
    expect(writeGlossary(dir)).toEqual(["rules/crawl/robots-txt.mdx"]);
    expect(read(dir, "rules/crawl/robots-txt.mdx")).toContain(
      [
        "Crawlability findings ship in every audit.",
        "",
        "{/* glossary:backlinks:start */}",
        "",
        "Glossary: [robots.txt](/glossary#robots-txt).",
        "",
        "{/* glossary:backlinks:end */}",
        "",
        "",
        "## References",
      ].join("\n"),
    );
    expect(messages(dir)).toEqual([]);
    expect(writeGlossary(dir)).toEqual([]);
  });

  test("no block on a rule no term lists, nor in a category without rule_backlinks", () => {
    const unlisted = docs({
      terms: [{ ...SOLO, rules: ["crawl/sitemap-exists"] }],
      hubs: ON,
      files: {
        "rules/crawl/robots-txt.mdx": withRelated(),
        "rules/crawl/sitemap-exists.mdx": `${rulePage("crawl/sitemap-exists", "crawl", "No XML sitemap found")}\n${RELATED}`,
      },
    });
    expect(writeGlossary(unlisted)).toEqual(["rules/crawl/sitemap-exists.mdx"]);
    expect(read(unlisted, "rules/crawl/robots-txt.mdx")).not.toContain(
      "glossary:backlinks",
    );
    const off = docs({
      terms: [SOLO],
      files: { "rules/crawl/robots-txt.mdx": withRelated() },
    });
    expect(messages(off)).toEqual([]);
    expect(writeGlossary(off)).toEqual([]);
  });

  test("a listed rule page with no Related rules section fails, and a heading in a code fence does not count", () => {
    const dir = docs({
      terms: [SOLO],
      hubs: ON,
      files: {
        "rules/crawl/robots-txt.mdx": withRelated(
          "```md\n## Related rules\n```\n",
        ),
      },
    });
    const problem =
      "rules/crawl/robots-txt.mdx:1: rule page has no ## Related rules section, where its glossary:backlinks block goes: add one";
    expect(messages(dir)).toEqual([problem]);
    expect(writeGlossary(dir)).toEqual([]);
  });

  test("Related rules as the last section: the block goes after its last line", () => {
    const dir = docs({
      terms: [SOLO],
      hubs: ON,
      files: {
        "rules/crawl/robots-txt.mdx": withRelated(
          "## Related rules\n\n- [crawl/sitemap-exists](/rules/crawl/sitemap-exists): the sitemap.\n\n",
        ),
      },
    });
    writeGlossary(dir);
    expect(read(dir, "rules/crawl/robots-txt.mdx")).toEndWith(
      "the sitemap.\n\n{/* glossary:backlinks:start */}\n\nGlossary: [robots.txt](/glossary#robots-txt).\n\n{/* glossary:backlinks:end */}\n\n",
    );
    expect(messages(dir)).toEqual([]);
  });

  test("a heading inside a comment does not end the section", () => {
    const dir = docs({
      terms: [SOLO],
      hubs: ON,
      files: {
        "rules/crawl/robots-txt.mdx": withRelated(
          "## Related rules\n\n- one\n\n{/*\n## Example\n*/}\n\n## References\n",
        ),
      },
    });
    writeGlossary(dir);
    expect(read(dir, "rules/crawl/robots-txt.mdx")).toContain(
      "{/*\n## Example\n*/}\n\n{/* glossary:backlinks:start */}",
    );
    expect(messages(dir)).toEqual([]);
  });

  test("a JSX component that ends the section stays whole: the block goes after it", () => {
    const dir = docs({
      terms: [SOLO],
      hubs: ON,
      files: {
        "rules/crawl/robots-txt.mdx": withRelated(
          "## Related rules\n\n- one\n\n<Note>\n  See also the sitemap rules.\n</Note>\n\n## References\n",
        ),
      },
    });
    writeGlossary(dir);
    expect(read(dir, "rules/crawl/robots-txt.mdx")).toContain(
      "</Note>\n\n{/* glossary:backlinks:start */}\n\nGlossary: [robots.txt](/glossary#robots-txt).\n\n{/* glossary:backlinks:end */}\n\n## References",
    );
    expect(messages(dir)).toEqual([]);
  });

  test("an existing block is kept where it is and only refilled", () => {
    const dir = docs({
      terms: [SOLO],
      hubs: ON,
      files: {
        "rules/crawl/robots-txt.mdx": withRelated(
          `{/* glossary:backlinks:start */}\nstale\n{/* glossary:backlinks:end */}\n\n${RELATED}`,
        ),
      },
    });
    expect(messages(dir)).toEqual([
      "rules/crawl/robots-txt.mdx:16: generated block glossary:backlinks is out of date: run `bun scripts/glossary.ts --write`",
    ]);
    writeGlossary(dir);
    const page = read(dir, "rules/crawl/robots-txt.mdx");
    expect(page.match(/glossary:backlinks:start/g)).toHaveLength(1);
    expect(page.indexOf("glossary:backlinks:start")).toBeLessThan(
      page.indexOf("## Related rules"),
    );
    expect(messages(dir)).toEqual([]);
  });

  test("rule_backlinks must be a boolean", () => {
    const dir = docs({
      terms: [SOLO],
      hubs: [{ ...HUBS[0]!, rule_backlinks: "yes" as unknown as boolean }],
    });
    expect(messages(dir)).toContain(
      "scripts/glossary/hubs.json:1: hubs[0] is missing a field or has a field of the wrong type",
    );
  });
});

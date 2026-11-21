import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Workspace,
  allDocs,
  formatSelection,
  importEdges,
  readWorkspaces,
  selectAffected,
  withDependents,
  workspaceGraph,
  workspaceOf,
} from "./ci-affected.ts";
import { suiteNames } from "./test-suites.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const real = await workspaceGraph();
const names = (dirs: string[]) => dirs.map((d) => real.find((w) => w.dir === d)?.name);

/** a <- b <- c, and d on its own; report and report-v2 share a prefix. */
const fake: Workspace[] = [
  { name: "a", dir: "packages/a", deps: [] },
  { name: "b", dir: "packages/b", deps: ["a"] },
  { name: "c", dir: "apps/cli", deps: ["b"] },
  { name: "d", dir: "packages/d", deps: [] },
  { name: "report", dir: "packages/report", deps: [] },
  { name: "report-v2", dir: "packages/report-v2", deps: [] },
];
const docsOnly = () => true;

describe("withDependents", () => {
  test("adds every dependent, transitively, and nothing upstream", () => {
    expect([...withDependents(["a"], fake)].sort()).toEqual(["a", "b", "c"]);
    expect([...withDependents(["b"], fake)].sort()).toEqual(["b", "c"]);
    expect([...withDependents(["d"], fake)]).toEqual(["d"]);
  });
});

describe("workspaceOf", () => {
  test("a prefix look-alike is a different workspace", () => {
    expect(workspaceOf("packages/report-v2/src/a.ts", fake)?.name).toBe("report-v2");
    expect(workspaceOf("packages/report/src/a.ts", fake)?.name).toBe("report");
    expect(workspaceOf("packages/reports.md", fake)).toBeUndefined();
  });
});

describe("selectAffected", () => {
  test("a workspace that is not a named suite root maps to rest", () => {
    expect(selectAffected(["packages/d/src/x.ts"], fake, docsOnly)).toEqual({
      full: false,
      workspaces: ["d"],
      suites: ["rest"],
    });
  });

  test("a change reaches the suites of its dependents", () => {
    expect(selectAffected(["packages/a/src/x.ts"], fake, docsOnly).suites).toEqual(["cli", "rest"]);
  });

  test("a path under apps/ or packages/ outside every workspace runs everything", () => {
    expect(selectAffected(["packages/brand-new/src/x.ts"], fake, docsOnly).full).toBe(true);
  });

  test("an empty diff runs everything", () => {
    expect(selectAffected([], fake, docsOnly)).toEqual({
      full: true,
      workspaces: fake.map((w) => w.name),
      suites: suiteNames(),
    });
    expect(selectAffected(["", ""], fake, docsOnly).full).toBe(true);
  });

  test("a non-docs path outside the workspaces runs everything", () => {
    expect(selectAffected(["packages/d/src/x.ts", "bun.lock"], fake, () => false)).toEqual({
      full: true,
      workspaces: fake.map((w) => w.name),
      suites: suiteNames(),
    });
  });
});

describe("the real repository", () => {
  test("docs-only selects nothing (the docs job covers it)", () => {
    const docs = [
      "docs/guides/ci.mdx",
      "docs/package.json",
      "README.md",
      "changelog.d/1-a.added.md",
    ];
    expect(selectAffected(docs, real)).toEqual({ full: false, workspaces: [], suites: [] });
  });

  test("rules-only selects rules, its dependents and its importers, not report", () => {
    const got = selectAffected(["packages/rules/src/crawl/robots-txt.ts"], real);
    expect(got.full).toBe(false);
    // cli and audit-engine depend on rules; docs/scripts tests import rules
    // (rest); crawler tests import an audit-engine test helper.
    expect(got.workspaces).toEqual(
      expect.arrayContaining(
        names(["apps/cli", "packages/audit-engine", "packages/rules", "docs"]),
      ),
    );
    expect(got.workspaces).not.toContain(names(["packages/report"])[0]);
    expect(got.workspaces).not.toContain(names(["packages/core-contracts"])[0]);
    expect(got.suites).toEqual(["audit-engine", "crawler", "cli", "rules", "rest"]);
  });

  test("docs plus a rule change is the rule change", () => {
    const rule = selectAffected(["packages/rules/src/crawl/robots-txt.ts"], real);
    expect(selectAffected(["docs/a.mdx", "packages/rules/src/crawl/robots-txt.ts"], real)).toEqual(
      rule,
    );
  });

  test("core-contracts selects every suite", () => {
    const got = selectAffected(["packages/core-contracts/src/index.ts"], real);
    expect(got.full).toBe(false);
    expect(got.suites).toEqual(suiteNames());
  });

  test("an unnamed package's tests run in rest", () => {
    expect(selectAffected(["packages/fetchers/tests/a.test.ts"], real).suites).toContain("rest");
  });

  test.each([
    "bun.lock",
    "package.json",
    "tsconfig.json",
    "scripts/ci-affected.ts",
    "scripts/release.ts",
    ".github/workflows/ci.yml",
    ".github/actions/setup-bun/action.yml",
    "install.sh",
    "install.ps1",
    "CHANGELOG.md",
    "npm/package.json",
    "oxlint.disabled-core-rules.mjs",
    "new-thing.toml",
  ])("%s runs everything", (path) => {
    expect(selectAffected(["packages/rules/src/a.ts", path], real)).toEqual({
      full: true,
      workspaces: real.map((w) => w.name),
      suites: suiteNames(),
    });
  });

  test("allDocs follows ci-classify.sh's docs set", () => {
    expect(allDocs(["docs/a.mdx", "CONTRIBUTING.md"])).toBe(true);
    expect(allDocs(["docs/a.mdx", "install.sh"])).toBe(false);
    expect(allDocs(["docsx/a.mdx"])).toBe(false);
  });

  test("an import package.json does not declare is still an edge", async () => {
    // packages/rules tests import packages/report sources by relative path;
    // rules does not depend on report, so only the source scan links them.
    const declared = await readWorkspaces();
    expect(declared.find((w) => w.dir === "packages/rules")?.deps).not.toContain(
      names(["packages/report"])[0],
    );
    const edges = await importEdges(declared);
    expect([...(edges.get(names(["packages/rules"])[0] as string) ?? [])]).toContain(
      names(["packages/report"])[0],
    );
    expect(selectAffected(["packages/report/src/grouping.ts"], real).suites).toContain("rules");
  });
});

describe("formatSelection", () => {
  test("matches the shape ci.yml's changes job accepts", async () => {
    const workflow = await Bun.file(join(repoRoot, ".github/workflows/ci.yml")).text();
    const line = workflow.split("\n").find((l) => l.includes("shape=$'^full="));
    const quoted = line?.match(/shape=\$'(.*)'$/)?.[1];
    expect(quoted).toBeDefined();
    const shape = new RegExp((quoted as string).replaceAll("\\n", "\n"));
    for (const changed of [
      ["packages/rules/src/a.ts"],
      ["docs/a.mdx"],
      ["bun.lock"],
      ["packages/core-contracts/src/a.ts"],
    ]) {
      expect(formatSelection(selectAffected(changed, real)).trimEnd()).toMatch(shape);
    }
  });
});

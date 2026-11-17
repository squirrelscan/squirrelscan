// Release-time assembly of changelog.d/ entries into CHANGELOG.md, and the
// conversion of an open PR's CHANGELOG.md bullets into entry files. #2113
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addedBullets,
  ChangelogError,
  entryName,
  readEntries,
  release,
  renderUnreleased,
  restoreUnreleased,
  SECTIONS,
  unreleasedBullets,
  writeEntries,
} from "./changelog";

const CHANGELOG = `# Changelog

Header prose.

## v1.0.0 (2026-01-02)

### Added

- shipped feature
`;

const dirs: string[] = [];
function repo(entries: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "changelog-d-"));
  dirs.push(root);
  mkdirSync(join(root, "changelog.d"));
  writeFileSync(join(root, "changelog.d", "README.md"), "# not an entry\n");
  writeFileSync(join(root, "CHANGELOG.md"), CHANGELOG);
  for (const [file, text] of Object.entries(entries))
    writeFileSync(join(root, "changelog.d", file), text);
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("release assembly", () => {
  test("two entries in one section land under one heading, in file-name order, and the files are deleted", () => {
    const root = repo({
      "20-second.added.md": "- Second thing (#20)\n",
      "10-first.added.md": "- First thing (#10)\n",
    });
    expect(release(root, "1.1.0", "2026-01-03")).toBe(2);
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(`# Changelog

Header prose.

## v1.1.0 (2026-01-03)

### Added

- First thing (#10)
- Second thing (#20)

## v1.0.0 (2026-01-02)

### Added

- shipped feature
`);
    expect(readdirSync(join(root, "changelog.d"))).toEqual(["README.md"]);
  });

  test("an empty section gets no heading, and sections follow Added, Changed, Fixed, Security, Docs", () => {
    const root = repo({
      "a-docs.docs.md": "- Docs (#5)\n",
      "b-fix.fixed.md": "- Fix (#4)\n",
      "c-sec.security.md": "- Sec (#3)\n",
      "d-add.added.md": "- Add (#1)\n",
    });
    release(root, "v1.1.0", "2026-01-03");
    const text = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const section = text.slice(text.indexOf("## v1.1.0"), text.indexOf("## v1.0.0"));
    expect(section.match(/^### .+$/gm)).toEqual([
      "### Added",
      "### Fixed",
      "### Security",
      "### Docs",
    ]);
    expect(section).not.toContain("### Changed");
  });

  test("the section order is the one the criteria name", () => {
    expect([...SECTIONS]).toEqual(["Added", "Changed", "Fixed", "Security", "Docs"]);
  });

  test("a file with an unknown section name fails and nothing is written or deleted", () => {
    const root = repo({
      "1-ok.added.md": "- Fine (#1)\n",
      "2-bad.removed.md": "- Unknown section (#2)\n",
    });
    expect(() => release(root, "1.1.0", "2026-01-03")).toThrow(ChangelogError);
    expect(() => release(root, "1.1.0", "2026-01-03")).toThrow("2-bad.removed.md");
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(CHANGELOG);
    expect(existsSync(join(root, "changelog.d", "1-ok.added.md"))).toBe(true);
  });

  test("an entry that is not a bullet, or a name with no section, fails", () => {
    expect(() =>
      readEntries(join(repo({ "1-prose.fixed.md": "Fixed it\n" }), "changelog.d")),
    ).toThrow('starting with "- "');
    expect(() => readEntries(join(repo({ "1-nosection.md": "- x\n" }), "changelog.d"))).toThrow(
      "<section>",
    );
  });

  test("no entries is an error, not an empty release", () => {
    expect(() => release(repo({}), "1.1.0", "2026-01-03")).toThrow("no entries");
  });

  test("a version that already has a section is refused; a stable after its beta is not", () => {
    expect(() => release(repo({ "1-a.added.md": "- a\n" }), "1.0.0", "2026-01-03")).toThrow(
      "already has a section",
    );
    const root = repo({ "1-a.added.md": "- a\n" });
    writeFileSync(join(root, "CHANGELOG.md"), CHANGELOG.replace("## v1.0.0 ", "## v1.1.0-beta.1 "));
    expect(release(root, "1.1.0", "2026-01-03")).toBe(1);
  });

  test("a multi-line entry is kept verbatim", () => {
    const root = repo({ "1-long.changed.md": "- First line\n  continued\n  - nested\n" });
    release(root, "1.1.0", "2026-01-03");
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain(
      "### Changed\n\n- First line\n  continued\n  - nested\n\n## v1.0.0",
    );
  });

  test("the unreleased preview prints the same sections without touching anything", () => {
    const root = repo({ "1-a.fixed.md": "- Fix (#1)\n", "2-b.added.md": "- Add (#2)\n" });
    expect(renderUnreleased(readEntries(join(root, "changelog.d")))).toBe(
      "## [Unreleased]\n\n### Added\n\n- Add (#2)\n\n### Fixed\n\n- Fix (#1)\n",
    );
    expect(readdirSync(join(root, "changelog.d")).length).toBe(3);
    expect(renderUnreleased([])).toBe("## [Unreleased]\n\nNo entries in changelog.d/.\n");
  });
});

describe("converting an open PR", () => {
  const base = `# Changelog

## [Unreleased]

### Added

- already on main (#1)

## v1.0.0

- shipped
`;
  const head = `# Changelog

## [Unreleased]

### Added

- already on main (#1)
- my new rule \`a/b\` (squirrelscan/repo#42)

### Fixed

- my fix
  spans two lines (#43)

## v1.0.0

- shipped
`;

  test("only the bullets the branch added are taken, with their section and exact text", () => {
    const { added, removed } = addedBullets(base, head);
    expect(added).toEqual([
      { section: "Added", text: "- my new rule `a/b` (squirrelscan/repo#42)" },
      { section: "Fixed", text: "- my fix\n  spans two lines (#43)" },
    ]);
    expect(removed).toEqual([]);
  });

  test("files hold the same text and CHANGELOG.md goes back to the base block", () => {
    const root = repo({});
    const dir = join(root, "changelog.d");
    const files = writeEntries(dir, addedBullets(base, head).added);
    expect(files).toEqual([
      "42-my-new-rule-a-b-squirrelscan.added.md",
      "43-my-fix-spans-two-lines-43.fixed.md",
    ]);
    expect(readEntries(dir).map((e) => e.text)).toEqual([
      "- my new rule `a/b` (squirrelscan/repo#42)",
      "- my fix\n  spans two lines (#43)",
    ]);
    expect(restoreUnreleased(base, head)).toBe(base);
  });

  test("the switch: a base with no [Unreleased] drops the block", () => {
    expect(restoreUnreleased("# Changelog\n\n## v1.0.0\n", base)).toBe(
      "# Changelog\n\n## v1.0.0\n\n- shipped\n",
    );
    expect(unreleasedBullets(base)).toEqual([{ section: "Added", text: "- already on main (#1)" }]);
  });

  test("a bullet under an unknown heading fails and writes nothing", () => {
    const root = repo({});
    const dir = join(root, "changelog.d");
    expect(() =>
      writeEntries(dir, [
        { section: "Added", text: "- ok" },
        { section: "Known limits", text: "- a limit" },
      ]),
    ).toThrow('unknown section "### Known limits"');
    expect(readdirSync(dir)).toEqual(["README.md"]);
  });

  test("an edited base bullet is reported as removed", () => {
    const edited = head.replace("- already on main (#1)", "- already on main, reworded (#1)");
    const { added, removed } = addedBullets(base, edited);
    expect(removed).toEqual([{ section: "Added", text: "- already on main (#1)" }]);
    expect(added.map((b) => b.text)).toContain("- already on main, reworded (#1)");
  });

  test("names come from the issue and first words, and never collide", () => {
    expect(entryName("- See [the docs](https://x.test/a) for `x` (#3093)")).toBe(
      "3093-see-the-docs-for-x-3093",
    );
    const root = repo({});
    const dir = join(root, "changelog.d");
    expect(
      writeEntries(dir, [
        { section: "Fixed", text: "- same (#1)" },
        { section: "Fixed", text: "- same (#1)" },
      ]),
    ).toEqual(["1-same-1.fixed.md", "1-same-1-2.fixed.md"]);
  });
});

test("the CI guard accepts exactly the sections the assembler knows", () => {
  const guard = readFileSync(join(import.meta.dir, "check-changelog-entries.sh"), "utf8");
  const line = /^SECTIONS="([^"]*)"$/m.exec(guard)?.[1];
  expect(line?.split(" ")).toEqual(SECTIONS.map((s) => s.toLowerCase()));
});

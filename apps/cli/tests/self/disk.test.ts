// #1912: `squirrel self disk` is the only way to find out that ~/.squirrel has
// grown to tens of gigabytes. It reports; it must never delete, and it must not
// fail on a directory that is missing, unreadable, or holds a database from an
// older schema — those are exactly the states someone is in when they go
// looking for what is eating their disk.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectDiskUsage,
  formatBytes,
  type DiskUsageRoots,
} from "../../src/self/disk";

let home: string;
let roots: DiskUsageRoots;

/** A project.db with `crawls` and `rule_results`, as the crawler would leave it. */
function writeProject(name: string, crawls: number, ruleRows: number): void {
  const dir = join(home, ".squirrel", "projects", name);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "project.db"), { create: true });
  db.exec("CREATE TABLE crawls (id TEXT PRIMARY KEY, base_url TEXT)");
  db.exec("CREATE TABLE rule_results (id INTEGER PRIMARY KEY, crawl_id TEXT)");
  for (let i = 0; i < crawls; i++)
    db.query("INSERT INTO crawls VALUES (?, ?)").run(`c${i}`, "https://x.test");
  const insert = db.query("INSERT INTO rule_results (crawl_id) VALUES (?)");
  const many = db.transaction(() => {
    for (let i = 0; i < ruleRows; i++)
      insert.run(`c${i % Math.max(1, crawls)}`);
  });
  many();
  db.close();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sq-disk-"));
  roots = {
    projects: join(home, ".squirrel", "projects"),
    releases: join(home, ".squirrel", "releases"),
    logs: join(home, ".squirrel", "logs"),
    contentStore: join(home, ".squirrel", "content-store.db"),
    linkCache: join(home, ".squirrel", "link-cache.db"),
  };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("collectDiskUsage", () => {
  test("an empty home reports zeroes rather than failing", () => {
    const result = collectDiskUsage(roots);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.projects).toEqual([]);
    expect(result.data.totalBytes).toBe(0);
  });

  test("reports each project's size, audit count and rule-result rows", () => {
    writeProject("small-site", 1, 50);
    writeProject("big-site", 4, 4_000);

    const result = collectDiskUsage(roots);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Biggest first: the reason to run this is to find what to act on.
    const [first, second] = result.data.projects;
    expect(first?.name).toBe("big-site");
    expect(second?.name).toBe("small-site");
    expect(first?.crawls).toBe(4);
    expect(first?.ruleResultRows).toBe(4_000);
    expect(first!.bytes).toBeGreaterThan(second!.bytes);
    expect(result.data.projectsBytes).toBe(first!.bytes + second!.bytes);
    expect(result.data.totalBytes).toBeGreaterThanOrEqual(
      result.data.projectsBytes
    );
  });

  test("a database it cannot read still contributes its size, and says why", () => {
    const dir = join(home, ".squirrel", "projects", "corrupt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "project.db"), "this is not a database");

    const result = collectDiskUsage(roots);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const project = result.data.projects.find((p) => p.name === "corrupt");
    expect(project).toBeDefined();
    expect(project!.bytes).toBeGreaterThan(0);
    expect(project!.unreadable).toBeTruthy();
    // Counts are unknown, not invented.
    expect(project!.crawls).toBe(0);
  });

  test("a project directory with no database is still listed", () => {
    mkdirSync(join(home, ".squirrel", "projects", "empty"), {
      recursive: true,
    });
    const result = collectDiskUsage(roots);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.projects.map((p) => p.name)).toContain("empty");
  });

  test("counts the content store separately from projects", () => {
    writeProject("a-site", 1, 10);
    mkdirSync(join(home, ".squirrel"), { recursive: true });
    writeFileSync(
      join(home, ".squirrel", "content-store.db"),
      "x".repeat(4096)
    );

    const result = collectDiskUsage(roots);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The store is shared by every project, so it must not be attributed to one.
    expect(result.data.contentStoreBytes).toBe(4096);
    expect(result.data.projectsBytes).toBeGreaterThan(0);
    // Asserted against the fixture bytes rather than by restating the sum the
    // implementation computes, which would agree with any double count.
    expect(result.data.totalBytes).toBe(result.data.projectsBytes + 4096);
  });

  test("counts the shared link cache", () => {
    mkdirSync(join(home, ".squirrel"), { recursive: true });
    writeFileSync(join(home, ".squirrel", "link-cache.db"), "x".repeat(2048));

    const result = collectDiskUsage(roots);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.linkCacheBytes).toBe(2048);
    expect(result.data.totalBytes).toBe(2048);
  });

  test("a shared database INSIDE a counted directory is not counted twice", () => {
    // SQUIRREL_CONTENT_STORE_PATH can point anywhere, and the benchmark
    // harnesses put it under a project. Counted on its own line as well as in
    // the project directory, it would inflate the total and blame that project
    // for bytes it does not own.
    writeProject("a-site", 1, 10);
    const inside = join(
      home,
      ".squirrel",
      "projects",
      "a-site",
      "content-store.db"
    );
    writeFileSync(inside, "x".repeat(8192));

    const result = collectDiskUsage({ ...roots, contentStore: inside });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.contentStoreBytes).toBe(0);
    // The bytes are still reported, once, against the directory holding them.
    expect(result.data.projectsBytes).toBeGreaterThanOrEqual(8192);
    expect(result.data.totalBytes).toBe(result.data.projectsBytes);
  });

  test("sums files nested deeper than a project ever nests", () => {
    // The depth backstop must not silently understate a real tree.
    const deep = join(
      home,
      ".squirrel",
      "projects",
      "deep",
      "a",
      "b",
      "c",
      "d",
      "e"
    );
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "blob.bin"), "x".repeat(5000));

    const result = collectDiskUsage(roots);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const project = result.data.projects.find((p) => p.name === "deep");
    expect(project?.bytes).toBe(5000);
  });
});

describe("formatBytes", () => {
  test("scales to the unit someone deciding what to delete would use", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(200 * 1024 * 1024)).toBe("200 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });
});

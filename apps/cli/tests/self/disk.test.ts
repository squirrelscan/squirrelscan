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
    expect(result.data.totalBytes).toBe(
      result.data.projectsBytes +
        result.data.contentStoreBytes +
        result.data.releasesBytes +
        result.data.logsBytes
    );
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

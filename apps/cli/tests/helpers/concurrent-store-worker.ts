// One of N processes hammering the machine-wide stores and a project database
// at once (#1226). Waits for the start file so every process opens its
// connections in the same instant, which is when a fresh connection's first
// statements contend for the lock.
//
// argv: <dir> <worker id> <start file>

import { SQLiteStorage } from "@squirrelscan/crawler/storage";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ContentStore } from "../../src/crawler/storage/content-store";
import { LinkCacheStorage } from "../../src/crawler/storage/link-cache";

const [dir, id, startFile] = process.argv.slice(2) as [string, string, string];

while (!existsSync(startFile)) await Bun.sleep(1);

const content = new ContentStore(join(dir, "content-store.db"));
const links = new LinkCacheStorage(join(dir, "link-cache.db"));
// One project db shared by every worker, to put the project's own writes under
// contention as well.
const project = new SQLiteStorage(join(dir, "project.db"));
const { Effect } = await import("effect");
try {
  await Effect.runPromise(project.init());
} catch (e) {
  const cause = (e as { cause?: { message?: string } }).cause;
  console.error("INIT FAILED:", cause?.message ?? String(e));
  process.exit(1);
}

for (let i = 0; i < 40; i++) {
  content.put(`worker ${id} body ${i} ${"x".repeat(2000)}`, "text/html");
  links.setCachedBulk(
    Array.from({ length: 20 }, (_, n) => ({
      href: `https://example.com/${id}/${i}/${n}`,
      status: 200,
      checkedAt: Date.now(),
    })) as never
  );
  await Effect.runPromise(project.transaction(() => undefined));
}

content.close?.();
links.close();
process.stdout.write("ok\n");

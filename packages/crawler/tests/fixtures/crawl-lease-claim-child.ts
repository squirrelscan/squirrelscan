import { existsSync } from "fs";

import { startCrawlLease } from "../../src/storage/crawl-lease";

const [dbPath, crawlId, startPath, resultPath, releasePath] = Bun.argv.slice(2);
if (!dbPath || !crawlId || !startPath || !resultPath || !releasePath) {
  throw new Error("expected db, crawl, start, result and release paths");
}

const lease = startCrawlLease({
  dbPath,
  getCrawlId: () => null,
  host: "same-host",
  now: () => 10_000_000,
});

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await Bun.sleep(5);
  }
}

try {
  await waitFor(startPath);
  const claim = lease.claim(crawlId);
  await Bun.write(resultPath, JSON.stringify({ claim, pid: process.pid }));
  await waitFor(releasePath);
} finally {
  lease.release();
}

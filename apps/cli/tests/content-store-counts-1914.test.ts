import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contentStoreLine } from "@/cli/commands/audit";
import { ContentStore } from "@/crawler/storage/content-store";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("content store put counts (#1914)", () => {
  test("an empty store stores fresh, a second put of the same body is reused", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-1914-"));
    dirs.push(dir);
    const store = new ContentStore(join(dir, "cold.db"));
    try {
      store.put("<html>a</html>", "text/html");
      store.put("<html>b</html>", "text/html");
      store.put("<html>a</html>", "text/html");
      expect(store.getPutCounts()).toEqual({ stored: 2, reused: 1 });
    } finally {
      store.close();
    }
  });

  test("the summary line only appears when bodies were reused", () => {
    expect(contentStoreLine({ stored: 5, reused: 0 })).toBeNull();
    expect(contentStoreLine(undefined)).toBeNull();
    expect(contentStoreLine({ stored: 1, reused: 3 })).toContain(
      "3 of 4 page bodies were already stored"
    );
  });
});

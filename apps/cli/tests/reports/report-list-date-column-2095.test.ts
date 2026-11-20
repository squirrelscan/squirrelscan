import { afterEach, describe, expect, it, spyOn } from "bun:test";

import { printAuditList } from "@/cli/commands/report";

describe("report list date column (#2095)", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  it("separates the widest locale date from the page count", () => {
    const lines: string[] = [];
    spies.push(
      spyOn(console, "log").mockImplementation((...a: unknown[]) => {
        lines.push(a.join(" "));
      })
    );
    const widest = "11/17/2026, 10:32:20 AM";
    spies.push(spyOn(Date.prototype, "toLocaleString").mockReturnValue(widest));
    printAuditList([
      {
        id: "abcdef1234567890",
        baseUrl: "https://example.com",
        startedAt: 1_700_000_000_000,
        status: "completed",
        stats: { pagesTotal: 25 },
      },
    ]);
    const row = lines.find((l) => l.startsWith("abcdef12"));
    expect(row).toBeDefined();
    expect(row).toContain(`${widest}  25`);
    expect(row).not.toContain(`${widest}25`);
    const header = lines.find((l) => l.startsWith("ID"));
    expect(row?.indexOf("25")).toBe(header?.indexOf("Pages"));
  });
});

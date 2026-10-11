import type { ProbeBudget } from "@squirrelscan/rules";

import * as engine from "@squirrelscan/audit-engine";
// Probing intensity on `squirrel audit`, driven through citty's real parser
// (`runCommand` with raw argv) so a flag that parses in a unit test but never
// reaches the command fails here. The assertions are on the run banner and on
// the shared budget the rules phase actually receives as `ctx.probe`.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { parseArgs, runCommand } from "citty";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  audit,
  probeBannerLines,
  probeFlagsFromArgs,
} from "@/cli/commands/audit";
import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";
import { closeGlobalContentStore } from "@/crawler/storage/content-store";
import { closeGlobalLinkCache } from "@/crawler/storage/link-cache";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

// Same isolation as audit-discovery-probes-wiring.test.ts: every store the
// audit writes goes to a scratch dir, and the process-wide stores are closed
// on the way in and out.
function closeGlobalStores(): void {
  closeGlobalContentStore();
  closeGlobalLinkCache();
}
// #626: every squirrel path under one scratch dir, removed afterwards.
const scratch = isolateSquirrelHome("squirrel-probe-wiring").root;
const configPath = join(scratch, "squirrel.toml");
const restores: (() => void)[] = [];

// The budget each run handed to the rules phase.
let probes: ProbeBudget[] = [];

beforeAll(() => {
  closeGlobalStores();
  const previousConfig = getGlobalConfigPath();
  setGlobalConfigPath(configPath);
  restores.push(() => setGlobalConfigPath(previousConfig));
  const realRunStreamingRules = engine.runStreamingRules;
  const spy = spyOn(engine, "runStreamingRules").mockImplementation(
    (...args: Parameters<typeof engine.runStreamingRules>) => {
      const probe = args[4]?.probe;
      if (probe) probes.push(probe);
      return realRunStreamingRules(...args);
    }
  );
  restores.push(() => spy.mockRestore());
});

afterAll(() => {
  closeGlobalStores();
  for (const restore of restores) restore();
});

/** Thrown in place of process.exit, so a command exit cannot kill the runner. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const originalFetch = globalThis.fetch;
const originalExit = process.exit;
const originalExitCode = process.exitCode;
const originalEnv = { ...process.env };
let output: string[] = [];
let requested: string[] = [];
let restoreConsole: () => void = () => {};

beforeEach(() => {
  probes = [];
  output = [];
  requested = [];
  process.exitCode = 0;
  // Anonymous and offline: nothing here may reach a real API.
  delete process.env.SQUIRREL_API_TOKEN;
  process.env.SQUIRREL_API_SERVER = "http://127.0.0.1:9";
  process.env.SQUIRREL_DISABLE_TELEMETRY = "1";
  process.env.SQUIRREL_NO_UPDATE = "1";
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
  const capture = (...parts: unknown[]) => {
    // Without color codes, so assertions read the text a user sees.
    output.push(Bun.stripANSI(parts.map(String).join(" ")));
  };
  const log = spyOn(console, "log").mockImplementation(capture);
  const error = spyOn(console, "error").mockImplementation(capture);
  restoreConsole = () => {
    log.mockRestore();
    error.mockRestore();
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    if (url.hostname === "example.com") requested.push(url.pathname);
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "<html><head><title>t</title></head><body><h1>h</h1></body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  restoreConsole();
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  process.exitCode = originalExitCode ?? 0;
  process.env = { ...originalEnv };
});

/** `squirrel audit https://example.com/ <flags>`, one page, offline, no prompts. */
async function runAudit(
  flags: string[],
  config = "",
  coverage: string[] = ["-C", "quick"]
): Promise<void> {
  writeFileSync(configPath, config);
  const rawArgs = [
    "https://example.com/",
    "-m",
    "1",
    ...coverage,
    "--offline",
    "-y",
    ...flags,
  ];
  try {
    await runCommand(audit, { rawArgs });
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
}

const line = (label: string) =>
  output.find((l) => l.startsWith(label.padEnd(10)))?.slice(10);
const ROBOTS_NOTE = "requests robots-disallowed paths on purpose";

describe("squirrel audit probing intensity", () => {
  test("anonymous (here: --offline) defaults to passive and the rules phase gets a passive budget", async () => {
    await runAudit([]);
    expect(line("Probing")).toBe("passive · no requests beyond the crawl");
    expect(probes).toHaveLength(1);
    expect(probes[0]?.level).toBe("passive");
    expect(probes[0]?.allows("quiet")).toBe(false);
    expect(output.some((l) => l.includes(ROBOTS_NOTE))).toBe(false);
  });

  test("--aggressive: banner, robots note, and a 2m shared budget", async () => {
    await runAudit(["--aggressive"]);
    expect(line("Probing")).toBe("aggressive · budget 2m");
    expect(output.some((l) => l.includes(ROBOTS_NOTE))).toBe(true);
    expect(probes[0]?.level).toBe("aggressive");
    expect(probes[0]?.budgetMs).toBe(120_000);
  });

  test("-P active --probe-budget 5s caps all probing at 5s", async () => {
    await runAudit(["-P", "active", "--probe-budget", "5s"]);
    expect(line("Probing")).toBe("active · budget 5s");
    expect(probes[0]?.level).toBe("active");
    expect(probes[0]?.budgetMs).toBe(5_000);
    expect(probes[0]?.allows("loud")).toBe(false);
  });

  test("[security] probe and budget are read from config", async () => {
    await runAudit([], '[security]\nprobe = "active"\nbudget = "45s"\n');
    expect(line("Probing")).toBe("active · budget 45s");
    expect(probes[0]?.budgetMs).toBe(45_000);
  });

  test("--probe and the shortcuts beat [security] probe", async () => {
    await runAudit(
      ["--probe", "passive"],
      '[security]\nprobe = "aggressive"\n'
    );
    expect(probes[0]?.level).toBe("passive");
    probes = [];
    await runAudit(["--passive"], '[security]\nprobe = "active"\n');
    expect(probes[0]?.level).toBe("passive");
  });

  test("--probe-budget beats [security] budget", async () => {
    await runAudit(
      ["--probe-budget", "10s"],
      '[security]\nprobe = "active"\nbudget = "45s"\n'
    );
    expect(probes[0]?.budgetMs).toBe(10_000);
  });

  test("--pentest is --level full --probe aggressive", async () => {
    await runAudit(["--pentest"], "", []);
    // -m 1 and aggressive probing are both changes from the full level.
    expect(line("Level")).toBe("custom (full + max_pages 1, probe aggressive)");
    expect(line("Probing")).toBe("aggressive · budget 2m");
    expect(output.some((l) => l.includes(ROBOTS_NOTE))).toBe(true);
  });

  test("--disable-discovery-probes forces passive and says why", async () => {
    await runAudit(["--disable-discovery-probes", "--aggressive"]);
    expect(line("Probing")).toBe("passive · no requests beyond the crawl");
    expect(
      output.some((l) => l.includes("discovery probes are disabled"))
    ).toBe(true);
    expect(probes[0]?.level).toBe("passive");
    expect(probes[0]?.allows("quiet")).toBe(false);
    expect(probes[0]?.allows("loud")).toBe(false);
  });

  test("[crawler] disable_discovery_probes = true forces passive over [security] probe", async () => {
    await runAudit(
      [],
      '[crawler]\ndisable_discovery_probes = true\n\n[security]\nprobe = "aggressive"\n'
    );
    expect(probes[0]?.level).toBe("passive");
    expect(output.some((l) => l.includes(ROBOTS_NOTE))).toBe(false);
  });

  test.each([
    [
      ["--passive", "--aggressive"],
      "--passive and --aggressive cannot be combined",
    ],
    [
      ["--probe", "active", "--aggressive"],
      "--aggressive cannot be combined with --probe active",
    ],
    [
      ["-P", "loud"],
      "unknown --probe level 'loud'. Valid: passive, active, aggressive.",
    ],
    [["--probe-budget", "abc"], "--probe-budget must be a positive duration"],
    [["--pentest"], "--pentest cannot be combined with --level quick"],
  ])("%p is refused before any request", async (flags, message) => {
    await runAudit(flags);
    expect(process.exitCode).toBe(1);
    expect(output.some((l) => l.includes(message))).toBe(true);
    expect(requested).toEqual([]);
    expect(probes).toEqual([]);
  });

  test("--pentest with a repeated -C is refused, not a crash", async () => {
    await runAudit(["--pentest"], "", ["-C", "full", "-C", "full"]);
    expect(process.exitCode).toBe(1);
    expect(
      output.some((l) =>
        l.includes("--coverage was given more than once (full, full)")
      )
    ).toBe(true);
    expect(requested).toEqual([]);
  });

  test("an invalid [security] budget fails config loading", async () => {
    await runAudit([], '[security]\nbudget = "forever"\n');
    expect(
      output.some((l) => l.includes("budget must be a positive duration"))
    ).toBe(true);
    expect(probes).toEqual([]);
  });
});

describe("probing flags through citty's parser", () => {
  async function parse(argv: string[]) {
    const def = await (typeof audit.args === "function"
      ? audit.args()
      : audit.args);
    return probeFlagsFromArgs(
      parseArgs(argv, def as never) as Record<string, unknown>
    );
  }

  test("-P is --probe and does not collide with -p (--publish)", async () => {
    expect((await parse(["https://example.com/", "-P", "active"])).probe).toBe(
      "active"
    );
    const def = await (typeof audit.args === "function"
      ? audit.args()
      : audit.args);
    const args = parseArgs(
      ["https://example.com/", "-p"],
      def as never
    ) as Record<string, unknown>;
    expect(args.probe).toBeUndefined();
    expect(args.publish).toBe(true);
  });

  test("repeated, the last one wins", async () => {
    const flags = await parse([
      "https://example.com/",
      "--probe",
      "passive",
      "--probe",
      "aggressive",
    ]);
    expect(flags.probe).toBe("aggressive");
  });

  test("shortcuts and budget", async () => {
    expect(
      await parse([
        "https://example.com/",
        "--aggressive",
        "--probe-budget",
        "30s",
      ])
    ).toMatchObject({ aggressive: true, probeBudget: "30s" });
    expect(await parse(["https://example.com/", "--pentest"])).toMatchObject({
      pentest: true,
    });
  });
});

describe("probeBannerLines", () => {
  test("only aggressive carries the robots note", () => {
    expect(
      probeBannerLines({ level: "passive", budgetMs: 0 }).note
    ).toBeUndefined();
    expect(
      probeBannerLines({ level: "active", budgetMs: 30_000 }).note
    ).toBeUndefined();
    expect(
      probeBannerLines({ level: "aggressive", budgetMs: 120_000 }).note
    ).toContain(ROBOTS_NOTE);
  });
});

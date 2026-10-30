// Checks that a compiled `squirrel` binary reads no bunfig.toml and no .env from
// the directory it is run in.
//
//   bun run scripts/check-compiled-autoload.ts build/squirrelscan
//
// A bunfig.toml `preload` there must not run, and a `.env` there must not set
// SQUIRREL_* variables (the audit below writes its content store where the real
// environment says, never where the .env does). Exits 1 on either, with which.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const binary = process.argv[2];
if (!binary) {
  console.error(
    "usage: check-compiled-autoload.ts <path to compiled squirrel binary>"
  );
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "squirrel-autoload-"));
const cwd = join(root, "project");
const home = join(root, "home");
mkdirSync(cwd, { recursive: true });
mkdirSync(home, { recursive: true });
const marker = join(root, "preload-ran");
const dotenvStore = join(root, "dotenv-store.db");

writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
writeFileSync(
  join(cwd, "preload.ts"),
  `await Bun.write(${JSON.stringify(marker)}, "ran");\n`
);
writeFileSync(
  join(cwd, ".env"),
  `SQUIRREL_CONTENT_STORE_PATH=${dotenvStore}\n`
);

const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/") {
      return new Response(
        '<!doctype html><html lang="en"><head><title>Autoload check</title></head><body><h1>Hi</h1></body></html>',
        { headers: { "content-type": "text/html" } }
      );
    }
    return new Response("not found", { status: 404 });
  },
});

// The real environment, minus anything the check itself is about.
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !key.startsWith("SQUIRREL") && key !== "NO_COLOR")
    env[key] = value;
}
Object.assign(env, {
  HOME: home,
  SQUIRREL_NO_UPDATE: "1",
  NO_TELEMETRY: "1",
  NO_COLOR: "1",
});

const problems: string[] = [];

async function run(label: string, args: string[]): Promise<void> {
  const proc = Bun.spawn([resolve(binary!), ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // A run that failed early proves nothing about what it loaded.
  if (code !== 0)
    problems.push(`${label} exited ${code}: ${stderr.trim().slice(0, 300)}`);
}

try {
  await run("--version", ["--version"]);
  await run("audit", [
    "audit",
    `http://127.0.0.1:${site.port}/`,
    "--offline",
    "--passive",
    "-m",
    "1",
    "-f",
    "json",
    "-o",
    join(root, "report.json"),
  ]);
} finally {
  void site.stop(true);
}

if (!existsSync(join(root, "report.json")))
  problems.push("the audit wrote no report.json");
if (existsSync(marker))
  problems.push("a bunfig.toml preload in the working directory ran");
if (existsSync(dotenvStore))
  problems.push(
    "a .env in the working directory set SQUIRREL_CONTENT_STORE_PATH"
  );
rmSync(root, { recursive: true, force: true });

if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  process.exit(1);
}
console.log(
  "ok: the compiled binary reads no bunfig.toml or .env from the working directory"
);

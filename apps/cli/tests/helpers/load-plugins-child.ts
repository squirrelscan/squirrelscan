// Runs loadConfiguredPlugins in its own process and prints the outcome as JSON, so a
// test can prove it returns promptly: a synchronous read of a FIFO would freeze the
// test runner itself, and its timeout could never fire.
// argv[2] = JSON { entry, baseDir, settingsPath, cacheRoot }
import { loadConfiguredPlugins } from "@/audit/plugins";

const arg = JSON.parse(process.argv[2] ?? "{}") as {
  entry: string;
  baseDir: string;
  settingsPath: string;
  cacheRoot: string;
};

try {
  const r = await loadConfiguredPlugins(
    {
      enabled: true,
      items: [{ id: "acme-pack", entry: arg.entry, allow: [] }],
    },
    {
      baseDir: arg.baseDir,
      settingsPath: arg.settingsPath,
      cacheRoot: arg.cacheRoot,
    }
  );
  console.log(
    JSON.stringify({ rules: r.snapshot.rules.length, notices: r.notices })
  );
} catch (error) {
  console.log(
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    })
  );
}

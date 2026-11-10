// Child process for settings-race-1660.test.ts: `bun settings-writer.ts <key> <count> <prefix>` calls updateSettings `count`
// times, each setting `key` to `<prefix><i>@example.test`. HOME is the test's temp directory, so it writes the test's own settings.json.
import { updateSettings } from "../../../src/self/settings";

const [key, countArg, prefix] = process.argv.slice(2);
const count = Number(countArg);
for (let i = 1; i <= count; i++) {
  const result = updateSettings({
    [key as string]: `${prefix}${i}@example.test`,
  } as never);
  if (!result.ok) {
    console.error(`write ${i} failed: ${result.error.message}`);
    process.exit(2);
  }
}

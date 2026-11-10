// Child process for settings-race-1660.test.ts: a foreground `login` writing `auth` after a short delay. A CHILD, with HOME in
// its environment: Bun resolves the home directory once per process, so changing process.env.HOME inside the test process would
// still write the real ~/.squirrel/settings.json.
import { updateSettings } from "../../../src/self/settings";

const delayMs = Number(process.argv[2] ?? "0");
await Bun.sleep(delayMs);
const auth = {
  token: "tok",
  userId: "u1",
  email: "u@example.test",
  name: null,
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const result = updateSettings({ auth });
if (!result.ok) {
  console.error(result.error.message);
  process.exit(2);
}

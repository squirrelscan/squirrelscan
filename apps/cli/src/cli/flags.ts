// `--no-<name>` flags, read from the raw argv because citty cannot deliver them.
//
// citty (0.1.6 and 0.2.x) turns any `--no-<name>` token into `<name>: false`
// and never sets a declared `"no-<name>"` arg, so `args["no-publish"]` is
// always undefined and a check on it silently never fires. Its parsed value is
// no substitute when both forms are passed either: the result depends on argv
// order and alias use (`--no-publish --publish` gives `publish: [false, true]`,
// `-p --no-publish` gives `publish: true`, `--publish --no-publish` gives
// `publish: false`).
//
// The pattern: declare the `no-<name>` arg so help and completions list it,
// then read it with `hasNegatedFlag(rawArgs, name)` from the command context,
// never from `args`. When the flag has a positive twin, refuse the pair with
// `hasFlag`.

/**
 * The flag tokens in argv, tokenized the way citty does it: stop at the `--`
 * terminator, skip values and positionals (no leading dash), and split off the
 * dashes. citty never takes a dash-led token as a flag's value, so every token
 * that starts with `-` is a flag.
 */
function flagTokens(
  rawArgs: readonly string[] | undefined
): { dashes: number; key: string }[] {
  const argv = rawArgs ?? [];
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).flatMap((arg) => {
    const dashes = /^-+/.exec(arg)?.[0].length ?? 0;
    return dashes === 0 ? [] : [{ dashes, key: arg.slice(dashes) }];
  });
}

/** `--no-<name>` is in argv (`rawArgs` from the citty command context). */
export function hasNegatedFlag(
  rawArgs: readonly string[] | undefined,
  name: string
): boolean {
  return flagTokens(rawArgs).some(({ key }) => key === `no-${name}`);
}

/**
 * The positive form of a boolean flag is in argv: `--<name>`,
 * `--<name>=<value>`, a single-letter alias `-<a>`, or that alias inside a
 * short cluster (`-yp`).
 */
export function hasFlag(
  rawArgs: readonly string[] | undefined,
  name: string,
  aliases: readonly string[] = []
): boolean {
  return flagTokens(rawArgs).some(({ dashes, key }) => {
    if (key.startsWith("no-")) return false;
    // citty looks for the `=` from the second character on.
    const eq = key.indexOf("=", 1);
    const flag = eq === -1 ? key : key.slice(0, eq);
    // citty reads `--name` as one flag and any other dash count as a cluster
    // of single-letter flags.
    if (dashes === 2) return flag === name || aliases.includes(flag);
    return [...flag].some((c) => aliases.includes(c));
  });
}

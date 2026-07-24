// @squirrelscan/utils — bounded-concurrency map

/**
 * Run `tasks` with at most `concurrency` in flight, returning results in input
 * order (not completion order) — deterministic output. A fixed worker pool
 * pulls the next index off a shared cursor (`cursor++` is atomic in
 * single-threaded JS). `concurrency <= 1` runs sequentially. The first task
 * rejection is propagated only AFTER every worker stops pulling, so no work
 * runs unobserved in the background.
 */
export async function mapWithConcurrency<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  if (tasks.length === 0) return results;

  const limit = Math.max(1, Math.min(concurrency, tasks.length));
  let cursor = 0;
  let firstError: unknown;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = cursor++;
      if (index >= tasks.length) return;
      try {
        results[index] = await tasks[index]();
      } catch (e) {
        if (!failed) {
          failed = true;
          firstError = e;
        }
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  if (failed) throw firstError;
  return results;
}

/** Split `arr` into consecutive slices of at most `size` (last may be shorter). */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

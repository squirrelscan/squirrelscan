import type { Result } from "@/controllers/types";
import type { UpdateResult } from "@/self/types";

import { runInteractiveUpdate, checkOnly } from "@/self/updater";

export async function runSelfUpdate(options?: {
  force?: boolean;
}): Promise<Result<UpdateResult>> {
  return runInteractiveUpdate(options);
}

export async function runCheckOnly(): Promise<
  Result<{
    available: boolean;
    current_version: string;
    latest_version: string | null;
    release_url: string | null;
  }>
> {
  return checkOnly();
}

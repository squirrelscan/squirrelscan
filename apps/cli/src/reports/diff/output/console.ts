import type { DiffReport } from "../types";

import { renderDiffText } from "./text";

export function generateDiffConsole(diff: DiffReport): void {
  const content = renderDiffText(diff);
  process.stdout.write(content);
  process.stdout.write("\n");
}

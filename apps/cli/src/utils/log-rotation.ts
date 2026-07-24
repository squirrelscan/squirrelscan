import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import {
  LOG_COMPRESS_AFTER_DAYS,
  LOG_DELETE_AFTER_DAYS,
  LOG_MAX_SIZE_BYTES,
} from "@/constants";
import { getLogsPath } from "@/self/paths";
import { loadSettings } from "@/self/settings";

/**
 * Rotate logs: compress old .log files to .gz, delete ancient .gz files.
 * Also rotates current debug.log if it exceeds size limit.
 * Runs best-effort, silent on errors.
 */
export async function rotateLogsIfNeeded(): Promise<void> {
  try {
    const settings = loadSettings();
    const compressDays = settings.ok
      ? (settings.data.log_compress_after_days ?? LOG_COMPRESS_AFTER_DAYS)
      : LOG_COMPRESS_AFTER_DAYS;
    const deleteDays = settings.ok
      ? (settings.data.log_delete_after_days ?? LOG_DELETE_AFTER_DAYS)
      : LOG_DELETE_AFTER_DAYS;

    const logDir = getLogsPath();
    if (!existsSync(logDir)) return;

    const files = readdirSync(logDir);
    const now = Date.now();
    const MS_PER_DAY = 1000 * 60 * 60 * 24;

    // Check debug.log size and rotate if needed
    const debugLogPath = join(logDir, "debug.log");
    if (existsSync(debugLogPath)) {
      try {
        const stat = statSync(debugLogPath);
        if (stat.size > LOG_MAX_SIZE_BYTES) {
          // Rotate: rename to debug.log.1.gz and compress
          const rotatedPath = join(logDir, `debug.log.${Date.now()}.gz`);
          const content = await Bun.file(debugLogPath).arrayBuffer();
          await Bun.write(rotatedPath, Bun.gzipSync(new Uint8Array(content)));
          unlinkSync(debugLogPath);
        }
      } catch {
        // Skip if we can't rotate
      }
    }

    for (const file of files) {
      const path = join(logDir, file);

      try {
        const stat = statSync(path);
        if (!stat.isFile()) continue;

        const ageDays = (now - stat.mtime.getTime()) / MS_PER_DAY;

        // Compress old .log files (but not the current debug.log being written to)
        if (
          file.endsWith(".log") &&
          file !== "debug.log" &&
          ageDays > compressDays
        ) {
          const content = await Bun.file(path).arrayBuffer();
          await Bun.write(`${path}.gz`, Bun.gzipSync(new Uint8Array(content)));
          unlinkSync(path);
        }
        // Delete ancient .gz files
        else if (file.endsWith(".gz") && ageDays > deleteDays) {
          unlinkSync(path);
        }
      } catch {
        // Skip files we can't process
      }
    }
  } catch {
    // Silent fail - log rotation is best effort
  }
}

const DB_LOCK_PATTERNS = [
  /database is locked/i,
  /database table is locked/i,
  /sqlite_busy/i,
];

export function isDatabaseLockMessage(message: string): boolean {
  return DB_LOCK_PATTERNS.some((pattern) => pattern.test(message));
}

export function getDatabaseLockWarning(): string {
  return "Warning: Another SquirrelScan process appears to be using SQLite. Avoid running multiple crawl/report/analyze commands in parallel for the same workspace.";
}

export function printDatabaseLockWarningIfNeeded(
  message: string,
  log: (text: string) => void = console.error
): void {
  if (isDatabaseLockMessage(message)) {
    log(getDatabaseLockWarning());
  }
}

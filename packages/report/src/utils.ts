// Shared utilities for report output formatters

export interface GroupedLine {
  main: string;
  subs: string[];
}

/**
 * Parse indented text into grouped main lines with sub-items
 */
export function parseIndentedLines(text: string): GroupedLine[] {
  const lines = String(text).split("\n");
  const grouped: GroupedLine[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    if (line.startsWith("  ")) {
      if (grouped.length > 0) {
        grouped[grouped.length - 1].subs.push(line.trim());
      }
    } else {
      grouped.push({ main: line, subs: [] });
    }
  }

  return grouped;
}

/**
 * Escape HTML special characters
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Wrap text at specified column width
 */
export function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (currentLine.length + word.length + 1 <= maxWidth) {
      currentLine += (currentLine ? " " : "") + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines;
}

/**
 * Format ISO date for report headers
 */
export function formatReportDate(timestamp: string): string {
  return new Date(timestamp).toISOString();
}

/**
 * Humanize a byte count, e.g. 1536 → "1.5 KB", 0 → "0 B". Binary (1024) units.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  // Whole bytes show no decimal; KB+ show one.
  const formatted = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${formatted} ${units[unit]}`;
}

/**
 * Format date as human-friendly "8th Feb 2026" style
 */
export function formatHumanDate(timestamp: string): string {
  const d = new Date(timestamp);
  const day = d.getUTCDate();
  const suffix = [11, 12, 13].includes(day)
    ? "th"
    : day % 10 === 1
      ? "st"
      : day % 10 === 2
        ? "nd"
        : day % 10 === 3
          ? "rd"
          : "th";
  const month = d.toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  return `${day}${suffix} ${month} ${d.getUTCFullYear()}`;
}

/**
 * Like formatHumanDate but with the UTC time appended — "8th Feb 2026 at 14:30 UTC".
 */
export function formatHumanDateTime(timestamp: string): string {
  const d = new Date(timestamp);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${formatHumanDate(timestamp)} at ${hh}:${mm} UTC`;
}

/**
 * Sanitize URL for safe use in href attributes
 */
export function sanitizeUrl(url: string): string {
  const trimmed = url.trim().toLowerCase();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return url;
  }
  return "#";
}

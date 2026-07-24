// URL utilities for report rendering

export function getPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

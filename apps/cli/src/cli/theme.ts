// Terminal colour theme for the CLI's own chrome (help, home screen, setup,
// errors). Colours come from the brand palette in ./brand; this module only
// decides how many colours the terminal gets and paints text with them.

import { BRAND, type ColorLevel, renderHeader, sgrColor } from "./brand";

type Stream = { isTTY?: boolean };

/**
 * Colour support for a stream: NO_COLOR wins, FORCE_COLOR overrides detection,
 * a non-TTY or dumb terminal gets none, then COLORTERM/TERM decide the depth.
 */
export function detectColorLevel(stream: Stream = process.stdout, env = process.env): ColorLevel {
  if (env.NO_COLOR) return 0;
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === "0" || force === "false") return 0;
    if (force === "2") return 2;
    if (force === "3") return 3;
    if (force === "1" || force === "" || force === "true") {
      return /truecolor|24bit/i.test(env.COLORTERM ?? "") ? 3 : 2;
    }
  }
  if (!stream.isTTY || env.TERM === "dumb") return 0;
  if (/truecolor|24bit/i.test(env.COLORTERM ?? "") || env.WT_SESSION) return 3;
  if (/256/.test(env.TERM ?? "") || env.TERM_PROGRAM === "Apple_Terminal") return 2;
  return 1;
}

/** Whether the terminal can draw box and half-block glyphs. */
export function supportsUnicode(env = process.env): boolean {
  if (process.platform === "win32") return Boolean(env.WT_SESSION || env.TERM_PROGRAM);
  const loc = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return /utf-?8/i.test(loc) || env.TERM_PROGRAM !== undefined;
}

const ESC = "\u001b[";

export interface Theme {
  level: ColorLevel;
  unicode: boolean;
  /** Section headings. */
  heading: (s: string) => string;
  /** Command names and runnable examples. */
  command: (s: string) => string;
  /** The brand accent for highlights. */
  accent: (s: string) => string;
  bold: (s: string) => string;
  dim: (s: string) => string;
  ok: (s: string) => string;
  warn: (s: string) => string;
  error: (s: string) => string;
  /** Glyphs with ASCII fallbacks. */
  sym: { ok: string; warn: string; error: string; arrow: string; rule: string; bullet: string };
  header: (opts?: { version?: string; subtitle?: string }) => string;
}

export function createTheme(stream: Stream = process.stdout, env = process.env): Theme {
  const level = detectColorLevel(stream, env);
  const unicode = supportsUnicode(env);
  const wrap = (open: string) => (s: string) => (level === 0 ? s : `${ESC}${open}m${s}${ESC}0m`);
  const brand = (hex: string, basic: string, bold = false) =>
    wrap(`${bold ? "1;" : ""}${level >= 2 ? sgrColor(hex, level) : basic}`);
  return {
    level,
    unicode,
    heading: brand(BRAND.accent, "33", true),
    command: brand(BRAND.primaryText, "32"),
    accent: brand(BRAND.accent, "33"),
    bold: wrap("1"),
    dim: wrap("2"),
    ok: brand(BRAND.primaryText, "32"),
    warn: wrap("33"),
    error: wrap("31"),
    sym: unicode
      ? { ok: "✓", warn: "!", error: "✗", arrow: "→", rule: "─", bullet: "•" }
      : { ok: "v", warn: "!", error: "x", arrow: "->", rule: "-", bullet: "*" },
    header: (opts = {}) => renderHeader({ level, unicode, ...opts }),
  };
}

/** Visible length of a string that may contain SGR escapes. */
export function visibleLength(s: string): number {
  return s.replace(/\u001b\[[0-9;]*m/g, "").length;
}

/** Pad a possibly-coloured string to a visible width. */
export function padVisible(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleLength(s)));
}

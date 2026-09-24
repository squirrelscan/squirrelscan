// The squirrelscan brand in the terminal: the pixel squirrel, the palette and
// the header. This is the ONE source for the header art. The CLI renders it
// directly; install.sh and install.ps1 carry generated copies written by
// scripts/sync-install-header.ts, whose --check mode fails CI when they drift.
//
// Pure: no imports, no I/O, no environment reads. Callers pass the colour level,
// so the installer generator can render every variant from the same data.

/** The hero mascot from the website (packages/ui brand.tsx `SquirrelPixels`, viewBox 32x32). */
const SQUIRREL_RECTS: ReadonlyArray<readonly [x: number, y: number, w: number, h: number, fill: string]> = [
  [2, 4, 4, 4, "#8B4513"],
  [2, 8, 4, 4, "#8B4513"],
  [4, 12, 4, 4, "#8B4513"],
  [6, 16, 4, 4, "#A0522D"],
  [2, 0, 4, 4, "#A0522D"],
  [10, 12, 4, 4, "#A0522D"],
  [14, 12, 4, 4, "#A0522D"],
  [10, 16, 4, 4, "#CD853F"],
  [14, 16, 4, 4, "#CD853F"],
  [18, 16, 4, 4, "#A0522D"],
  [10, 20, 4, 4, "#CD853F"],
  [14, 20, 4, 4, "#DEB887"],
  [18, 20, 4, 4, "#CD853F"],
  [18, 8, 4, 4, "#A0522D"],
  [22, 8, 4, 4, "#A0522D"],
  [18, 12, 4, 4, "#CD853F"],
  [22, 12, 4, 4, "#CD853F"],
  [26, 12, 4, 4, "#A0522D"],
  [24, 10, 2, 2, "#000000"],
  [20, 4, 4, 4, "#A0522D"],
  [24, 6, 2, 2, "#DEB887"],
  [10, 24, 4, 4, "#8B4513"],
  [18, 24, 4, 4, "#8B4513"],
  [26, 18, 4, 4, "#8B4513"],
  [28, 16, 2, 2, "#228B22"],
];

/** Website palette (design_system.md), as sRGB hex. */
export const BRAND = {
  /** --accent oklch(0.62 0.14 45): soft orange. Headings and highlights. */
  accent: "#c96736",
  /** --primary oklch(0.52 0.12 145): muted green. Commands and success. */
  primary: "#357a3a",
  /** The primary green lifted to oklch(0.66 0.13 145) so it reads on dark terminals too. */
  primaryText: "#56a55a",
  /** The mascot's own orange, for the wordmark. */
  mascot: "#CD853F",
} as const;

export const TAGLINE = "The website QA tool for your coding agent";

/** 0 = no colour, 1 = 16 colours, 2 = 256 colours, 3 = truecolor. */
export type ColorLevel = 0 | 1 | 2 | 3;

type Pixel = string | null;

/** The squirrel as a pixel grid at the art's native 2-unit resolution, cropped to its bounding box. */
function squirrelGrid(): Pixel[][] {
  const size = 16;
  const grid: Pixel[][] = Array.from({ length: size }, () => Array<Pixel>(size).fill(null));
  for (const [x, y, w, h, fill] of SQUIRREL_RECTS) {
    for (let row = y / 2; row < (y + h) / 2; row++) {
      for (let col = x / 2; col < (x + w) / 2; col++) grid[row]![col] = fill;
    }
  }
  const rows = grid.map((r, i) => (r.some(Boolean) ? i : -1)).filter((i) => i >= 0);
  const cols = [...Array(size).keys()].filter((c) => grid.some((r) => r[c]));
  const top = rows[0]!;
  const bottom = rows.at(-1)!;
  const left = cols[0]!;
  const right = cols.at(-1)!;
  return grid.slice(top, bottom + 1).map((r) => r.slice(left, right + 1));
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Nearest xterm-256 colour-cube index (16-231) or greyscale ramp index (232-255). */
export function rgbTo256([r, g, b]: [number, number, number]): number {
  const levels = [0, 95, 135, 175, 215, 255];
  const nearest = (v: number) => {
    let best = 0;
    for (let i = 1; i < levels.length; i++) {
      if (Math.abs(levels[i]! - v) < Math.abs(levels[best]! - v)) best = i;
    }
    return best;
  };
  const [ri, gi, bi] = [nearest(r), nearest(g), nearest(b)];
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const cubeRgb = [levels[ri]!, levels[gi]!, levels[bi]!];
  const grey = Math.min(23, Math.max(0, Math.round(((r + g + b) / 3 - 8) / 10)));
  const greyV = 8 + grey * 10;
  const dist = (c: number[]) => (c[0]! - r) ** 2 + (c[1]! - g) ** 2 + (c[2]! - b) ** 2;
  return dist([greyV, greyV, greyV]) < dist(cubeRgb) ? 232 + grey : cube;
}

/** SGR parameters for a foreground (38) or background (48) colour at a level. */
export function sgrColor(hex: string, level: ColorLevel, layer: 38 | 48 = 38): string {
  const rgb = hexToRgb(hex);
  if (level >= 3) return `${layer};2;${rgb.join(";")}`;
  return `${layer};5;${rgbTo256(rgb)}`;
}

const ESC = "\u001b[";
const RESET = `${ESC}0m`;

/**
 * The squirrel as lines of half-block glyphs: each text row carries two pixel
 * rows (upper half = foreground of "▀", lower half = its background). Level 0
 * and 1 get a monochrome silhouette, since 16-colour palettes have no browns.
 */
export function renderSquirrel(level: ColorLevel): string[] {
  const grid = squirrelGrid();
  const lines: string[] = [];
  for (let row = 0; row < grid.length; row += 2) {
    const upper = grid[row]!;
    const lower = grid[row + 1] ?? upper.map(() => null);
    let line = "";
    for (let col = 0; col < upper.length; col++) {
      // The eye is black: in a silhouette it has to stay a hole to read as an eye.
      const hole = (p: Pixel) => (level < 2 && p === "#000000" ? null : p);
      const top = hole(upper[col] ?? null);
      const bottom = hole(lower[col] ?? null);
      if (!top && !bottom) {
        line += " ";
      } else if (level < 2) {
        line += top && bottom ? "█" : top ? "▀" : "▄";
      } else if (top && bottom) {
        line += `${ESC}${sgrColor(top, level, 38)};${sgrColor(bottom, level, 48)}m▀${RESET}`;
      } else if (top) {
        line += `${ESC}${sgrColor(top, level)}m▀${RESET}`;
      } else {
        line += `${ESC}${sgrColor(bottom!, level)}m▄${RESET}`;
      }
    }
    lines.push(line.replace(/ +$/, ""));
  }
  return lines;
}

/** Visible width of the squirrel in columns. */
export function squirrelWidth(): number {
  return squirrelGrid()[0]!.length;
}

export interface HeaderOptions {
  level: ColorLevel;
  /** Whether the terminal can draw the half-block glyphs (UTF-8). */
  unicode: boolean;
  /** Shown after the wordmark, e.g. "v0.0.99". Omitted by the installers. */
  version?: string;
  /** Replaces the tagline line, e.g. for a command's own subtitle. */
  subtitle?: string;
}

/**
 * The header: the squirrel on the left, the wordmark and tagline beside it.
 * Without unicode it degrades to the text lines alone.
 */
export function renderHeader({ level, unicode, version, subtitle }: HeaderOptions): string {
  const paint = (hex: string, text: string, bold = false) =>
    level === 0
      ? text
      : level === 1
        ? `${ESC}${bold ? "1;" : ""}33m${text}${RESET}`
        : `${ESC}${bold ? "1;" : ""}${sgrColor(hex, level)}m${text}${RESET}`;
  const dim = (text: string) => (level === 0 ? text : `${ESC}2m${text}${RESET}`);

  const wordmark = paint(BRAND.mascot, "squirrelscan", true) + (version ? `  ${dim(version)}` : "");
  const text = [wordmark, dim(subtitle ?? TAGLINE)];
  if (!unicode) return text.map((l) => `  ${l}`).join("\n");

  const art = renderSquirrel(level);
  const width = squirrelWidth();
  // Text sits beside the squirrel's head and body, vertically centred.
  const start = Math.max(0, Math.floor((art.length - text.length) / 2));
  return art
    .map((line, i) => {
      const t = text[i - start];
      if (t === undefined) return `  ${line}`;
      const visible = line.replace(/\u001b\[[0-9;]*m/g, "").length;
      return `  ${line}${" ".repeat(width - visible)}   ${t}`;
    })
    .join("\n");
}

// Simple terminal progress helper

import {
  DEFAULT_TERMINAL_COLUMNS,
  MIN_DETAIL_LENGTH,
  PROGRESS_DETAIL_PADDING,
  PROGRESS_SPINNER_INTERVAL_MS,
} from "@/constants";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface ProgressState {
  message: string;
  current?: number;
  total?: number;
  detail?: string;
}

/**
 * Simple progress indicator that updates a single line
 * Buffers log output above the progress line
 */
export class Progress {
  private frameIndex = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private state: ProgressState = { message: "" };
  private isTTY: boolean;
  private lastOutput = "";
  private isActive = false;

  constructor() {
    this.isTTY = process.stdout.isTTY === true;
  }

  /**
   * Start the progress indicator
   */
  start(message: string): void {
    this.state = { message };
    this.isActive = true;
    this.render();

    if (this.isTTY) {
      this.intervalId = setInterval(() => {
        this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
        this.render();
      }, PROGRESS_SPINNER_INTERVAL_MS);
    }
  }

  /**
   * Update progress with counts
   */
  update(current: number, total?: number, detail?: string): void {
    this.state.current = current;
    this.state.total = total;
    this.state.detail = detail;
    this.render();
  }

  /**
   * Update just the detail text
   */
  setDetail(detail: string): void {
    this.state.detail = detail;
    this.render();
  }

  /**
   * Log a message above the progress line
   * Clears progress, prints message, re-renders progress
   */
  log(message: string): void {
    if (this.isTTY && this.isActive) {
      // Clear current progress line
      process.stdout.write("\r" + " ".repeat(this.lastOutput.length) + "\r");
      // Print the log message
      console.log(message);
      // Re-render progress
      this.render();
    } else {
      console.log(message);
    }
  }

  /**
   * Stop the progress indicator
   */
  stop(finalMessage?: string): void {
    this.isActive = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.isTTY) {
      // Clear the line
      process.stdout.write("\r" + " ".repeat(this.lastOutput.length) + "\r");
    }

    if (finalMessage) {
      console.log(finalMessage);
    }
  }

  /**
   * Stop with success message
   */
  succeed(message: string): void {
    this.stop(`✓ ${message}`);
  }

  /**
   * Stop with failure message
   */
  fail(message: string): void {
    this.stop(`✗ ${message}`);
  }

  private render(): void {
    if (!this.isActive) return;

    const spinner = SPINNER_FRAMES[this.frameIndex];
    let output = `${spinner} ${this.state.message}`;

    if (this.state.current !== undefined) {
      if (this.state.total !== undefined) {
        output += ` (${this.state.current}/${this.state.total})`;
      } else {
        output += ` (${this.state.current})`;
      }
    }

    if (this.state.detail) {
      // Truncate detail to fit terminal
      const columns = process.stdout.columns ?? DEFAULT_TERMINAL_COLUMNS;
      const maxDetailLen = columns - output.length - PROGRESS_DETAIL_PADDING;
      let detail = this.state.detail;
      if (detail.length > maxDetailLen && maxDetailLen > MIN_DETAIL_LENGTH) {
        detail = "..." + detail.slice(-(maxDetailLen - 3));
      }
      output += ` ${detail}`;
    }

    if (this.isTTY) {
      // Clear previous output and write new
      const clearLen = Math.max(this.lastOutput.length, output.length);
      try {
        process.stdout.write("\r" + " ".repeat(clearLen) + "\r" + output);
        this.lastOutput = output;
      } catch {
        // Gracefully degrade if stdout fails (e.g., pipe closed)
        this.isActive = false;
      }
    }
    // Non-TTY: only log on significant updates (handled by caller)
  }
}

/**
 * Create and start a new progress indicator
 */
export function createProgress(message: string): Progress {
  const progress = new Progress();
  progress.start(message);
  return progress;
}

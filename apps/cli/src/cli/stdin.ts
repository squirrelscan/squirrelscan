// stdin for commands that take their input piped as well as typed.

/** Whether stdin is a terminal a person can type into. */
export function stdinIsTTY(): boolean {
  return Boolean(process.stdin.isTTY);
}

export interface ReadTextOptions {
  /** Stop once more than this many bytes have arrived. */
  maxBytes: number;
  /**
   * Stop when nothing new arrives for this long. A pipe the parent never
   * closes (some agent harnesses spawn with stdin open and write nothing)
   * would otherwise block until the process is killed.
   */
  idleMs: number;
}

export interface ReadTextResult {
  text: string;
  /** The read ended on `idleMs` rather than at EOF or `maxBytes`. */
  timedOut: boolean;
}

/** Resolves to "idle" after `ms` unless cancelled first. */
function idleAfter(ms: number): { idle: Promise<"idle">; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<"idle">((resolve) => {
    timer = setTimeout(() => resolve("idle"), ms);
  });
  return { idle, cancel: () => clearTimeout(timer) };
}

/** Read a byte stream as UTF-8 until EOF, `maxBytes`, or `idleMs` of silence. */
export async function readStreamText(
  stream: ReadableStream<Uint8Array>,
  { maxBytes, idleMs }: ReadTextOptions
): Promise<ReadTextResult> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  try {
    while (size <= maxBytes) {
      const { idle, cancel } = idleAfter(idleMs);
      const next = await Promise.race([reader.read(), idle]).finally(cancel);
      if (next === "idle") {
        timedOut = true;
        break;
      }
      if (next.done) break;
      chunks.push(next.value);
      size += next.value.byteLength;
    }
  } finally {
    // Releases stdin so the process can exit with the pipe still open.
    void reader.cancel().catch(() => {});
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), timedOut };
}

/** Read piped stdin; see readStreamText. */
export function readStdinText(
  options: ReadTextOptions
): Promise<ReadTextResult> {
  return readStreamText(Bun.stdin.stream(), options);
}

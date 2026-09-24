// stdin for commands that take their input piped as well as typed.

/** Whether stdin is a terminal a person can type into. */
export function stdinIsTTY(): boolean {
  return Boolean(process.stdin.isTTY);
}

/** Read piped stdin to EOF as UTF-8, stopping once more than `maxBytes` have arrived. */
export async function readStdinText(maxBytes: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
    size += chunk.byteLength;
    if (size > maxBytes) break;
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

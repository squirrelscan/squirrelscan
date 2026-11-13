// IP text parsing shared by the country and edge lookups.
export function parseV4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

export function parseV6(ip: string): Uint8Array | null {
  let text = ip.split("%")[0]!;
  const tailV4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tailV4) {
    const v4 = parseV4(tailV4[1]!);
    if (v4 === null) return null;
    text = `${text.slice(0, -tailV4[1]!.length)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const [head, tail, extra] = text.split("::");
  if (extra !== undefined) return null;
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = text.includes("::") ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array<string>(Math.max(fill, 0)).fill("0"), ...t];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const v = Number.parseInt(groups[i]!, 16);
    if (!Number.isFinite(v)) return null;
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  }
  return out;
}


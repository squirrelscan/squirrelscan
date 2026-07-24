// YARA-style signature engine. A signature declares named `strings` (substring or
// regex matchers, each scoped to a corpus) and a boolean `condition` over those
// names. The engine matches a page's HTML/JS/title against the loaded signatures
// and returns the ones whose condition holds. Pure + synchronous — safe to run
// inside a rule.

import type {
  SignatureMatch,
  SignatureMatchInput,
  SignatureSeverity,
  SignatureTarget,
} from "@squirrelscan/core-contracts";

import calendlyKitRaw from "./signatures/calendly-kit.yml";

// ── parsed signature shape ──────────────────────────────────────────

interface StringDef {
  key: string;
  target: SignatureTarget;
  test(corpus: string): boolean;
}

type Condition =
  | { type: "id"; name: string }
  | { type: "and"; left: Condition; right: Condition }
  | { type: "or"; left: Condition; right: Condition }
  | { type: "not"; expr: Condition }
  | { type: "quant"; n: number | "all" | "any"; keys: string[] };

export interface Signature {
  id: string;
  name: string;
  severity: SignatureSeverity;
  description?: string;
  strings: StringDef[];
  condition: Condition;
}

const VALID_TARGETS: SignatureTarget[] = ["title", "html", "text", "url", "scripts", "any"];
const VALID_SEVERITIES: SignatureSeverity[] = ["critical", "high", "medium", "low"];

// ── condition parser (recursive descent over a tiny boolean grammar) ─

function tokenize(src: string): string[] {
  const re = /(\(|\)|,|[A-Za-z0-9_]+)/y;
  const tokens: string[] = [];
  let pos = 0;
  while (pos < src.length) {
    while (pos < src.length && /\s/.test(src[pos]!)) pos++;
    if (pos >= src.length) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m || m.index !== pos) {
      throw new Error(`signature condition: unexpected char at ${pos} in "${src}"`);
    }
    tokens.push(m[1]!);
    pos = re.lastIndex;
  }
  return tokens;
}

class ConditionParser {
  private i = 0;
  constructor(
    private readonly tokens: string[],
    private readonly keys: Set<string>,
  ) {}

  parse(): Condition {
    const c = this.parseOr();
    if (this.i < this.tokens.length) {
      throw new Error(`signature condition: trailing token "${this.tokens[this.i]}"`);
    }
    return c;
  }

  private peek(): string | undefined {
    return this.tokens[this.i];
  }
  private next(): string | undefined {
    return this.tokens[this.i++];
  }
  private lower(): string | undefined {
    return this.peek()?.toLowerCase();
  }

  private parseOr(): Condition {
    let left = this.parseAnd();
    while (this.lower() === "or") {
      this.next();
      left = { type: "or", left, right: this.parseAnd() };
    }
    return left;
  }
  private parseAnd(): Condition {
    let left = this.parseNot();
    while (this.lower() === "and") {
      this.next();
      left = { type: "and", left, right: this.parseNot() };
    }
    return left;
  }
  private parseNot(): Condition {
    if (this.lower() === "not") {
      this.next();
      return { type: "not", expr: this.parseNot() };
    }
    return this.parsePrimary();
  }
  private parsePrimary(): Condition {
    const t = this.peek();
    if (t === "(") {
      this.next();
      const c = this.parseOr();
      this.expect(")");
      return c;
    }
    // quantifier: (all | any | NUMBER) of (them | ( a, b, … ))
    if (
      t !== undefined &&
      (t.toLowerCase() === "all" || t.toLowerCase() === "any" || /^\d+$/.test(t))
    ) {
      const save = this.i;
      const head = this.next()!;
      if (this.lower() === "of") {
        this.next();
        const keys = this.parseQuantKeys();
        const n =
          head.toLowerCase() === "all"
            ? "all"
            : head.toLowerCase() === "any"
              ? "any"
              : parseInt(head, 10);
        return { type: "quant", n, keys };
      }
      this.i = save; // not a quantifier — fall through to identifier
    }
    const name = this.next();
    if (name === undefined) throw new Error("signature condition: unexpected end");
    if (!this.keys.has(name)) {
      throw new Error(`signature condition: unknown string "${name}"`);
    }
    return { type: "id", name };
  }
  private parseQuantKeys(): string[] {
    if (this.lower() === "them") {
      this.next();
      return [...this.keys];
    }
    this.expect("(");
    const keys: string[] = [];
    for (;;) {
      const k = this.next();
      if (k === undefined) throw new Error("signature condition: unterminated list");
      if (!this.keys.has(k)) throw new Error(`signature condition: unknown string "${k}"`);
      keys.push(k);
      const sep = this.next();
      if (sep === ")") break;
      if (sep !== ",") throw new Error('signature condition: expected "," or ")"');
    }
    return keys;
  }
  private expect(sym: string): void {
    const t = this.next();
    if (t !== sym) throw new Error(`signature condition: expected "${sym}"`);
  }
}

function parseCondition(src: string, keys: Set<string>): Condition {
  return new ConditionParser(tokenize(src), keys).parse();
}

function evalCondition(c: Condition, matched: Set<string>): boolean {
  switch (c.type) {
    case "id":
      return matched.has(c.name);
    case "and":
      return evalCondition(c.left, matched) && evalCondition(c.right, matched);
    case "or":
      return evalCondition(c.left, matched) || evalCondition(c.right, matched);
    case "not":
      return !evalCondition(c.expr, matched);
    case "quant": {
      const count = c.keys.filter((k) => matched.has(k)).length;
      if (c.n === "all") return c.keys.length > 0 && count === c.keys.length;
      if (c.n === "any") return count >= 1;
      return count >= c.n;
    }
  }
}

// ── signature normalization ─────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object") throw new Error("signature: expected an object");
  return v as Record<string, unknown>;
}

function buildStringDef(key: string, raw: unknown): StringDef {
  const def = asRecord(raw);
  const target = (def.target as SignatureTarget) ?? "html";
  if (!VALID_TARGETS.includes(target)) {
    throw new Error(`signature string "${key}": invalid target "${target}"`);
  }
  if (typeof def.contains === "string") {
    const needle = def.contains.toLowerCase();
    return { key, target, test: (c) => c.toLowerCase().includes(needle) };
  }
  if (typeof def.regex === "string") {
    let flags = typeof def.flags === "string" ? def.flags : "";
    if (def.nocase === true && !flags.includes("i")) flags += "i";
    let re: RegExp;
    try {
      re = new RegExp(def.regex, flags);
    } catch (err) {
      throw new Error(`signature string "${key}": bad regex — ${String(err)}`);
    }
    return { key, target, test: (c) => re.test(c) };
  }
  throw new Error(`signature string "${key}": needs "contains" or "regex"`);
}

/** Validate + normalize one raw YAML signature object into a usable Signature. */
export function parseSignature(raw: unknown): Signature {
  const obj = asRecord(raw);
  const id = obj.id;
  const name = obj.name;
  if (typeof id !== "string" || typeof name !== "string") {
    throw new Error('signature: "id" and "name" are required strings');
  }
  const severity = (obj.severity as SignatureSeverity) ?? "high";
  if (!VALID_SEVERITIES.includes(severity)) {
    throw new Error(`signature "${id}": invalid severity "${severity}"`);
  }
  const stringsRaw = asRecord(obj.strings);
  const strings = Object.entries(stringsRaw).map(([key, def]) => buildStringDef(key, def));
  if (strings.length === 0) {
    throw new Error(`signature "${id}": needs at least one string`);
  }
  const keys = new Set(strings.map((s) => s.key));
  const conditionSrc = typeof obj.condition === "string" ? obj.condition : "all of them";
  const condition = parseCondition(conditionSrc, keys);
  return {
    id,
    name,
    severity,
    description: typeof obj.description === "string" ? obj.description : undefined,
    strings,
    condition,
  };
}

// ── matching ────────────────────────────────────────────────────────

function corpusFor(target: SignatureTarget, input: SignatureMatchInput): string {
  switch (target) {
    case "title":
      return input.title ?? "";
    case "html":
      return input.html;
    case "text":
      return input.text ?? "";
    case "url":
      return input.url;
    case "scripts":
      return (input.scripts ?? []).join("\n");
    case "any":
      return [
        input.title ?? "",
        input.html,
        input.text ?? "",
        input.url,
        (input.scripts ?? []).join("\n"),
      ].join("\n");
  }
}

/** Match `input` against every signature; return those whose condition holds. */
export function matchSignatures(
  signatures: Signature[],
  input: SignatureMatchInput,
): SignatureMatch[] {
  const out: SignatureMatch[] = [];
  for (const sig of signatures) {
    const matched = new Set<string>();
    for (const def of sig.strings) {
      if (def.test(corpusFor(def.target, input))) matched.add(def.key);
    }
    if (matched.size === 0) continue; // no strings hit → condition can't hold
    if (evalCondition(sig.condition, matched)) {
      out.push({
        id: sig.id,
        name: sig.name,
        severity: sig.severity,
        description: sig.description,
        matchedStrings: [...matched],
      });
    }
  }
  return out;
}

// ── bundled signatures ──────────────────────────────────────────────

let bundled: Signature[] | null = null;

/**
 * Load the signatures shipped with the package (parsed + validated once, then
 * memoized). New signatures are added by dropping a `.yml` under `signatures/`
 * and importing it here.
 */
export function loadSignatures(): Signature[] {
  if (!bundled) {
    bundled = [parseSignature(calendlyKitRaw)];
  }
  return bundled;
}

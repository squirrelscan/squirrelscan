// security/url-sensitive-params - sensitive data in URL query parameters
//
// Query strings are copied into server and proxy logs, browser history, analytics and the Referer
// header, so a token or an email address in a URL spreads far past the visitor. The rule reads the
// page's own URL, its a[href] links, form[action], the canonical and the og:url. A parameter is
// flagged by its NAME (token, api_key, password...) or by the SHAPE of its value: the leaked-secrets
// detectors, through redactSecretsInUrl, decide what looks like a secret. Values are never printed.

import type { CheckItem } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { redactSecretsInUrl } from "./leaked-secrets";

const CHECK = "url-sensitive-params";
const PERSONAL_CHECK = "url-personal-params";
/** Items kept per check: a site that links a token on every page must not grow the report. */
const MAX_ITEMS = 25;
/** Query strings longer than this are not parsed: they are attacker-sized input. */
const MAX_URL_LENGTH = 4096;
const MAX_PARAMS_PER_URL = 100;

/** Names compared without case, `_`, `-` or `.`. */
const CREDENTIAL_NAMES: ReadonlySet<string> = new Set([
  "token",
  "accesstoken",
  "authtoken",
  "idtoken",
  "refreshtoken",
  "sessiontoken",
  "bearer",
  "apikey",
  "xapikey",
  "secret",
  "clientsecret",
  "secretkey",
  "privatekey",
  "accesskey",
  "authkey",
  "password",
  "passwd",
  "pwd",
  "pass",
  "sessionid",
  "sessid",
  "phpsessid",
  "jsessionid",
  "aspsessionid",
  "jwt",
  "signature",
  "auth",
  "authorization",
]);

/** A name ending in one of these is a credential too (`user_token`, `stripe_secret`). */
const CREDENTIAL_SUFFIXES = ["token", "secret", "password", "apikey"];
/** Tokens that are not credentials: pagination cursors, CSRF and captcha tokens, unsubscribe ids. */
const BENIGN_NAME_PARTS = [
  "page",
  "cursor",
  "next",
  "continuation",
  "csrf",
  "xsrf",
  "captcha",
  "nonce",
  "tokenizer",
];

const PERSONAL_NAMES: ReadonlySet<string> = new Set([
  "email",
  "emailaddress",
  "useremail",
  "phone",
  "phonenumber",
  "mobile",
  "ssn",
  "dob",
  "birthdate",
  "creditcard",
  "cardnumber",
  "cvv",
]);

const EMAIL_VALUE_RE = /^[^\s@/]{1,64}@[^\s@/]{1,255}\.[a-z]{2,24}$/i;
const FLAG_VALUES: ReadonlySet<string> = new Set([
  "true",
  "false",
  "yes",
  "no",
  "0",
  "1",
  "null",
  "undefined",
]);

export type ParamKind = "credential" | "personal";
export type ParamReason = "name" | "value";

export interface SensitiveParam {
  name: string;
  kind: ParamKind;
  reason: ParamReason;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[_\-.\s]/g, "");
}

function isCredentialName(name: string): boolean {
  const n = normalizeName(name);
  if (CREDENTIAL_NAMES.has(n)) return true;
  if (BENIGN_NAME_PARTS.some((part) => n.includes(part))) return false;
  return CREDENTIAL_SUFFIXES.some((suffix) => n.endsWith(suffix));
}

/** A template placeholder or a flag is not a value somebody could have leaked. */
function isInertValue(value: string): boolean {
  const v = value.trim();
  if (v === "" || FLAG_VALUES.has(v.toLowerCase())) return true;
  return /^(?:[{<[$%:*]|\$\{)/.test(v) || /^\*+$/.test(v);
}

/** Does a value alone look like a secret, by the leaked-secrets matchers? */
function valueLooksSecret(name: string, value: string): boolean {
  if (value.length < 8) return false;
  try {
    const probe = new URL("https://example.com/");
    probe.searchParams.set(name, value);
    const href = probe.href;
    return redactSecretsInUrl(href) !== href;
  } catch {
    return false;
  }
}

/** The sensitive parameters of one URL. Ordinary ones (page, utm_*, id, q, sort) are never returned. */
export function sensitiveParamsOf(url: string): SensitiveParam[] {
  if (url.length > MAX_URL_LENGTH) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return [];
  const out: SensitiveParam[] = [];
  const seen = new Set<string>();
  let count = 0;
  for (const [name, value] of parsed.searchParams) {
    if (++count > MAX_PARAMS_PER_URL) break;
    if (seen.has(name) || isInertValue(value)) continue;
    let found: SensitiveParam | null = null;
    if (isCredentialName(name))
      found = { name, kind: "credential", reason: "name" };
    else if (PERSONAL_NAMES.has(normalizeName(name)))
      found = { name, kind: "personal", reason: "name" };
    else if (valueLooksSecret(name, value))
      found = { name, kind: "credential", reason: "value" };
    else if (EMAIL_VALUE_RE.test(value))
      found = { name, kind: "personal", reason: "value" };
    if (found) {
      seen.add(name);
      out.push(found);
    }
  }
  return out;
}

/** The URL as a finding shows it: origin and path, no credentials, query or fragment. */
function bareUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.slice(0, 200);
  } catch {
    return "(unparsable URL)";
  }
}

interface Candidate {
  source: string;
  url: string;
}

function candidates(ctx: RuleContext): Candidate[] {
  const base = ctx.page.url;
  const out: Candidate[] = [{ source: "page URL", url: base }];
  const add = (source: string, raw: string | null | undefined): void => {
    if (!raw) return;
    try {
      out.push({ source, url: new URL(raw.trim(), base).href });
    } catch {
      /* not a URL */
    }
  };
  for (const link of ctx.parsed.links) add("link", link.url);
  const doc = ctx.parsed.document;
  if (doc) {
    for (const form of doc.querySelectorAll("form[action]"))
      add("form action", form.getAttribute("action"));
    // The parser skips `#...` anchors, but a query-bearing href is still an a[href].
    for (const a of doc.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") ?? "";
      if (href.includes("?")) add("link", href);
    }
  }
  add("canonical", ctx.parsed.meta.canonical);
  add("og:url", ctx.parsed.og.url);
  return out;
}

export const urlSensitiveParamsRule: Rule = {
  meta: {
    id: "security/url-sensitive-params",
    name: "Sensitive data in URLs",
    description:
      "Checks URLs, links, form actions and canonical URLs for tokens, secrets, passwords and personal data in query parameters",
    solution:
      "Query strings are written to server and proxy logs, browser history and analytics, and are sent in the Referer header to other sites. Move tokens, API keys, session ids, passwords and email addresses out of the URL: send them in a POST body or an Authorization header, or keep the session in a cookie. Rotate any credential that has already appeared in a URL.",
    category: "security",
    scope: "page",
    findingScope: "page",
    verdictScope: "page",
    severity: "error",
    weight: 7,
    checks: [
      { name: CHECK, outcome: "problem" },
      { name: PERSONAL_CHECK, outcome: "problem" },
      { name: CHECK, outcome: "clean", clears: [CHECK, PERSONAL_CHECK] },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const credentials: CheckItem[] = [];
    const personal: CheckItem[] = [];
    const reported = new Set<string>();
    let examined = 0;
    let credentialTotal = 0;
    let personalTotal = 0;

    for (const { source, url } of candidates(ctx)) {
      const key = JSON.stringify([source, url]);
      if (reported.has(key)) continue;
      reported.add(key);
      examined++;
      for (const param of sensitiveParamsOf(url)) {
        const where = bareUrl(url);
        const why =
          param.reason === "name"
            ? "a parameter name that carries sensitive data"
            : "a value shaped like " +
              (param.kind === "credential" ? "a secret" : "an email address");
        const item: CheckItem = {
          id: `${source}: ${where}?${param.name}=[redacted]`.slice(0, 300),
          label: `${source} ${where} has "${param.name}" in its query string: ${why}`,
          meta: {
            source,
            url: where,
            param: param.name,
            reason: param.reason,
            kind: param.kind,
          },
        };
        if (param.kind === "credential") {
          credentialTotal++;
          if (credentials.length < MAX_ITEMS) credentials.push(item);
        } else {
          personalTotal++;
          if (personal.length < MAX_ITEMS) personal.push(item);
        }
      }
    }

    const checks: CheckResult[] = [];
    if (credentialTotal > 0) {
      checks.push({
        name: CHECK,
        status: "fail",
        message: `${credentialTotal} URL parameter(s) carry a token, key, password or other secret`,
        items: credentials,
        details: { urlsChecked: examined, total: credentialTotal },
      });
    }
    if (personalTotal > 0) {
      checks.push({
        name: PERSONAL_CHECK,
        status: "warn",
        message: `${personalTotal} URL parameter(s) carry personal data such as an email address`,
        items: personal,
        details: { urlsChecked: examined, total: personalTotal },
      });
    }
    if (credentialTotal === 0 && personalTotal === 0) {
      checks.push({
        name: CHECK,
        status: "pass",
        message: "No sensitive data found in URL query parameters",
        details: { urlsChecked: examined },
      });
    }
    return { checks };
  },
};

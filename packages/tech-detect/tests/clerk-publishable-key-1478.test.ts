// #1478: a Clerk publishable key is `pk_<test|live>_` plus the base64 of its Frontend API host (`clerk.<domain>$` or
// `<name>.clerk.accounts.dev$`). A Stripe publishable key has the same prefix and is passed under the same property name.
// Keys are built at run time so no key-shaped literal sits in the file.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";

type Kind = "live" | "test";
const pk = (kind: Kind, body: string): string => ["pk_", kind, "_", body].join("");
const b64 = (text: string): string => Buffer.from(text).toString("base64");
const b64url = (text: string): string => b64(text).replace(/\+/g, "-").replace(/\//g, "_");
const unpadded = (text: string): string => b64(text).replace(/=+$/, "");
// A Stripe-shaped body: opaque alphanumerics after `51`, 99 characters.
const stripeBody = (seed: string): string => `51${seed.repeat(12)}`.slice(0, 99);

function idsOf(content: string): string[] {
  return detectTechnologies({
    url: "https://example.com/",
    headers: {},
    html: "",
    scripts: [{ url: "https://example.com/app.js", content }],
  }).map((technology) => technology.id);
}
const detectsClerk = (content: string): boolean => idsOf(content).includes("clerk");
const assigned = (key: string): string => `config={publishableKey:"${key}"}`;

describe("Clerk publishable-key detection (#1478)", () => {
  test("a Stripe publishableKey is not Clerk, live or test, in each written form", () => {
    for (const kind of ["live", "test"] as const) {
      const key = pk(kind, stripeBody("AbCdEfGh1"));
      expect(detectsClerk(`var cfg={stripe:{publishableKey:"${key}"},env:"prod"};`)).toBe(false);
      expect(detectsClerk(`{"stripe":{"publishableKey":"${key}"}}`)).toBe(false);
      expect(detectsClerk(`publishableKey:e.publishableKey||"${key}"`)).toBe(false);
    }
  });

  test("real-shaped Clerk keys still detect: production and development hosts, test and live prefixes", () => {
    const hosts = [
      "clerk.example.com$",
      "foo-bar-12.clerk.accounts.dev$",
      "a.clerk.accounts.dev$",
      "ab.clerk.example.org$",
      "abc.clerk.example.org$",
      "x-clerk.accounts.dev$",
      "clerk.my-app.io$",
      "a.clerk.x.com$",
    ];
    for (const host of hosts) {
      for (const kind of ["test", "live"] as const) {
        expect(detectsClerk(assigned(pk(kind, b64(host)))), `${kind} ${host}`).toBe(true);
      }
    }
  });

  test("the written form of the body does not matter: unpadded and base64url", () => {
    for (const host of ["clerk.example.com$", "foo-bar-12.clerk.accounts.dev$", "ab.clerk.example.org$"]) {
      expect(detectsClerk(assigned(pk("live", unpadded(host)))), `unpadded ${host}`).toBe(true);
      expect(detectsClerk(assigned(pk("test", b64url(host)))), `base64url ${host}`).toBe(true);
    }
  });

  test("a body that does not decode to a Clerk host is not Clerk", () => {
    const bodies = [
      b64("auth.example.com$"), // a host with the terminator but no `clerk.`
      b64("clerk.example.com"), // no terminator
      b64("clerk.example.com$trailing"), // bytes after the terminator
      b64("some random sentence that is not a host"),
      `${stripeBody("Zy")}ZXJr`, // a Stripe-shaped body that happens to contain base64 of "erk"
      `${stripeBody("Q9")}Y2xlcm`, // ... or of "cler"
    ];
    for (const body of bodies) {
      for (const kind of ["live", "test"] as const) {
        expect(detectsClerk(assigned(pk(kind, body))), `${kind} ${body.slice(0, 24)}`).toBe(false);
      }
    }
  });

  test("unpadded bodies whose host length is not a multiple of 3 still decode (the padding is restored)", () => {
    for (const host of ["clerk.a-b.com$", "clerk.b2b-app.io$", "clerk.ab$"]) {
      expect(detectsClerk(assigned(pk("live", unpadded(host)))), `unpadded ${host}`).toBe(true);
      expect(detectsClerk(assigned(pk("test", b64(host)))), `padded ${host}`).toBe(true);
    }
  });

  test("the host charset is case-insensitive after `clerk.`, but the `clerk.` marker itself is lower case", () => {
    expect(detectsClerk(assigned(pk("live", b64("clerk.EXAMPLE.com$"))))).toBe(true);
    expect(detectsClerk(assigned(pk("live", b64("Clerk.example.com$"))))).toBe(false);
  });

  test("the body floor: 12 base64 characters decode to the shortest accepted host, 11 do not", () => {
    expect(b64("clerk.ab$")).toHaveLength(12);
    expect(detectsClerk(assigned(pk("live", b64("clerk.ab$"))))).toBe(true);
    expect(detectsClerk(assigned(pk("live", unpadded("clerk.a$"))))).toBe(false);
  });

  test("a body that is not valid base64 (length 1 mod 4) is not Clerk and does not throw", () => {
    const body = `${unpadded("clerk.ab$")}A`;
    expect(body.length % 4).toBe(1);
    expect(() => detectsClerk(assigned(pk("live", body)))).not.toThrow();
    expect(detectsClerk(assigned(pk("live", body)))).toBe(false);
  });

  test("a Stripe key and a Clerk key in one bundle detect Clerk once, from the Clerk key", () => {
    const bundle = `var a={stripe:{publishableKey:"${pk("live", stripeBody("ZyXwVu8T7"))}"}};var b={publishableKey:"${pk("live", b64("clerk.example.com$"))}"};`;
    expect(idsOf(bundle)).toContain("clerk");
    expect(idsOf(bundle).filter((id) => id === "clerk")).toHaveLength(1);
  });
});

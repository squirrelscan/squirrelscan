// security/leaked-secrets: values that cannot be credentials and credentials
// that are sample data (#1292, #1308). Synthetic values only, built at runtime.

import { describe, expect, test } from "bun:test";

import { scanContent, seedWork } from "../../src/security/leaked-secrets";
import { mixedRun, runOf, seededRng } from "./leaked-secrets/generators";

const HEX = "0123456789abcdef";
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PAGE = "https://app.acme.test/";
const r = seededRng(1292);
// A password a person would set: 12 mixed characters.
const PASSWORD = "Xk9!" + "mQ2vL8zP"; // pragma: allowlist secret

const found = (text: string) => scanContent(text, "inline-script", PAGE).map((f) => f.type);
const none = (text: string) => expect(found(text)).toEqual([]);

describe("values that name something other than a credential (#1292)", () => {
  test("labels, i18n bundles, ICE and selector fragments", () => {
    none(`var s={fields:[{name:"password",label:"Password"}],password:"Password",secret:"secret"};`); // pragma: allowlist secret
    none(`var d={es:{password:"Contraseña",apiKey:"Clé API"},fr:{secret:"Clé secrète",password:"Mot de passe"}};`); // pragma: allowlist secret
    none(`var o="a=ice-pwd:"+e.pwd+"\\r\\n";var p=function(){return "a=ice-ufrag:"+e.ufrag};`);
    none(`var i=document.querySelector('input[type=password]');var n=$('[name=secret]');`);
    none(`var k=process.env.SECRET||"x";var j=env.SECRET||"default";`);
  });

  test("storage-key constants, CSS-module classes, joined identifiers", () => {
    none(`const K="app_secret_v6";var s={SECRET_KEY:"my_app_secret_v6",tokenKey:"auth_token_v2_store"};`); // pragma: allowlist secret
    none(`var c={password:"Button__primary___3xK9z",secret:"styles-module__secret___x9Y2z"};`); // pragma: allowlist secret
    none(`var c={password:"user_password_field",secret:"secret:reset:token",accessToken:"auth.token.value"};`); // pragma: allowlist secret
  });

  test("URLs and paths, env references, elided stubs, masks", () => {
    none(`var c={secret:"https://cdn.acme.test/js/app.min.js",password:"//cdn.acme.test/x",token:"/js/secret/app"};`); // pragma: allowlist secret
    none(`var c={password:"process.env.PASSWORD_HERE",secret:"import.meta.env.VITE_SECRET",x:{password:"\${DB_PASSWORD_ENV}"}};`); // pragma: allowlist secret
    none(`var c={password:"••••••••••",secret:"abcdefgh...",y:{secret:"abcdefgh…"},z:{password:"__________"}};`); // pragma: allowlist secret
  });

  test("a span that is code, not a quoted value", () => {
    none(`var a=f(b)===g&&(c=function(){return "password:"+d;});x.secret="Hello World Text";`);
    none(`var a={password:"x(a.b);var d=g(h)+e.pwd"};`);
    none(`var a={password:"a=>b;return c&&d"};`); // pragma: allowlist secret
  });

  test("a plain word under a credential-named key is reported: a weak default is a credential", () => {
    for (const word of ["changeme", "Summer2024!", "Passw0rd123"]) {
      expect([word, found(`var c={password:"${word}"};`)]).toEqual([word, ["Generic Secret Assignment"]]); // pragma: allowlist secret
    }
  });

  test("shapes that merely look like identifiers, addresses, URLs or code still report", () => {
    const reports = (text: string) => expect([text.slice(0, 60), found(text).length > 0]).toEqual([text.slice(0, 60), true]);
    reports(`var c={api_key:"${"kqzvmplxwn_rtbhdgcsyj_fmaoeiuqzk"}"};`); // pragma: allowlist secret
    reports(`var c={secret:"Prod_token_8fK2mQ9x"};`); // pragma: allowlist secret
    reports(`var c={secret:"https://hooks.acme.test/services/${"abcdefghijklmnopqrstuvwxyzabcdef"}"};`); // pragma: allowlist secret
    reports(`var c={secret:"0x${runOf(r, HEX, 40)}"};`); // pragma: allowlist secret
    reports(`var c={secret:"secret1${runOf(r, "qpzry9x8gf2tvdw0s3jn54khce6mua7l", 38)}"};`); // pragma: allowlist secret
    for (const pw of ["Zx9&&" + "Kw3mQ7", "return-of-the-king-2024", "$ADMIN" + "123", "env.Secr" + "et9x!", "Xk9mQ2vL8zPqRt4...", "a=>b" + "Q9x7Lm2K", "p||q" + "W8z3Rt6Y"]) {
      reports(`var c={password:"${pw}"};`); // pragma: allowlist secret
    }
  });

  test("real assignments still report", () => {
    const text = `var c={SECRET_KEY:"${runOf(r, HEX, 40)}",password:"${PASSWORD}",client_secret:"${"GOC" + "SPX-"}${runOf(r, ALNUM, 28)}"};`;
    // The `GOCSPX-` value has its own named pattern where that detector exists; either way it reports.
    const types = found(text);
    expect(types.filter((t) => t === "Generic Secret Assignment").length).toBeGreaterThanOrEqual(2);
    expect(types.length).toBeGreaterThanOrEqual(3);
  });

  test("a URL that is itself the credential still reports", () => {
    expect(found(`var c={secret:"https://hooks.zapier.test/hooks/catch/${runOf(r, "0123456789", 7)}/${runOf(r, ALNUM, 8)}/"};`)).toEqual(["Generic Secret Assignment"]); // pragma: allowlist secret
    expect(found(`var c={secret:"https://user:${PASSWORD}@hooks.acme.test/x"};`)).toEqual(["Generic Secret Assignment"]); // pragma: allowlist secret
    expect(found(`var c={secret:"https://api.acme.test/hook?key=${"abcdefghijkl"}"};`)).toEqual(["Generic Secret Assignment"]); // pragma: allowlist secret
  });

  test("a real password with code-like characters is not mistaken for code", () => {
    expect(found(`var c={password:"${"P@ss;word(" + "7Qx9!zK"}"};`)).toEqual(["Generic Secret Assignment"]); // pragma: allowlist secret
    expect(found(`var c={password:"${"aB3$dE5" + "&gH7(jK9"}"};`)).toEqual(["Generic Secret Assignment"]); // pragma: allowlist secret
  });
});

describe("sample data the page renders (#1308)", () => {
  const row = (email: string, role: string, pw: string) => `{role:"${role}",email:"${email}",password:"${pw}"}`;
  const table = (domain: string) =>
    `var users=[${row(`a@${domain}`, "admin", PASSWORD)},${row(`b@${domain}`, "user", "Yk7!" + "mQ2vL8zQ")},${row(`c@${domain}`, "user", "Zk5!" + "mQ2vL8zR")}];`; // pragma: allowlist secret

  test("a table of same-shaped records with reserved-domain emails is sample data", () => {
    for (const domain of ["x.test", "demo.example", "example.com", "foo.example.org", "demo.localhost"]) none(table(domain));
  });

  test("the same table with real-domain emails still reports, labelled a possible demo login", () => {
    const types = found(table("acme.com"));
    expect(types).toEqual(Array(3).fill("Possible Demo Login (seed data table)"));
    expect(scanContent(table("acme.com"), "inline-script", PAGE)[0]?.extra).toMatchObject({ hint: expect.stringContaining("demo login") });
  });

  test("a mix of reserved and real domains is not a sample", () => {
    const mixed = `var users=[${row("a@x.test", "admin", PASSWORD)},${row("b@acme.com", "user", "Yk7!" + "mQ2vL8zQ")},${row("c@x.test", "user", "Zk5!" + "mQ2vL8zR")}];`; // pragma: allowlist secret
    expect(found(mixed).every((t) => t === "Possible Demo Login (seed data table)")).toBe(true);
    expect(found(mixed).length).toBeGreaterThan(0);
  });

  test("two rows are not a table, and a table of differently shaped rows is not one", () => {
    const two = `var u=[${row("a@acme.com", "admin", PASSWORD)},${row("b@acme.com", "user", "Yk7!" + "mQ2vL8zQ")}];`; // pragma: allowlist secret
    expect(found(two)).toEqual(Array(2).fill("Generic Secret Assignment"));
    const shaped = `var u=[{email:"a@x.test",password:"${PASSWORD}"},{email:"b@x.test",user:"q",password:"${PASSWORD}A"},{email:"c@x.test",note:"n",password:"${PASSWORD}B"}];`;
    expect(found(shaped)).toEqual(Array(3).fill("Generic Secret Assignment"));
  });

  test("a single config object with an email and a password still reports", () => {
    expect(found(`var c={email:"a@acme.com",password:"${PASSWORD}"};`)).toEqual(["Generic Secret Assignment"]);
    expect(found(`var c={email:"a@x.test",password:"${PASSWORD}"};`)).toEqual(["Generic Secret Assignment"]);
  });

  test("puzzle levels and generator output carry markers", () => {
    none(`var l={crackUser:"root",crackPassword:"${PASSWORD}",candidates:["a","b"],flagPath:"/flag"};`);
    none(`var l={password:"${PASSWORD}",flag:"FLAG{ctf_win}"};`);
    none(`var g={password:"${PASSWORD}A",sample:"${mixedRun(r, 32)}",options:{length:32,symbols:true}};`);
  });

  test("one marker alone, in a config object, is not a puzzle: the password still reports", () => {
    for (const text of [
      `var c={flag:"beta",password:"${PASSWORD}",host:"db.acme.test"};`,
      `var c={secret:"${PASSWORD}",options:{retries:3,length:10}};`,
      `var c={password:"${PASSWORD}",candidates:[1,2]};`,
      `var c={flagPath:"/x",password:"${PASSWORD}"};`,
    ]) {
      expect([text.slice(0, 40), found(text)]).toEqual([text.slice(0, 40), ["Generic Secret Assignment"]]);
    }
  });

  test("one marker inside a table of same-shaped records is sample data", () => {
    const row = (n: number) => `{id:${n},flag:"x${n}",password:"${PASSWORD}${n}"}`;
    none(`var l=[${row(1)},${row(2)},${row(3)}];`);
  });

  test("a real private host is a real host: a .local table reports as a possible demo login", () => {
    const row = (e: string, p: string) => `{email:"${e}",password:"${p}"}`;
    const text = `var u=[${row("a@corp.local", PASSWORD)},${row("b@corp.local", PASSWORD + "2")},${row("c@corp.local", PASSWORD + "3")}];`;
    expect(found(text)).toEqual(Array(3).fill("Possible Demo Login (seed data table)"));
  });

  test("feature flags and options beside a real credential are not markers", () => {
    expect(found(`var c={flags:{beta:true},flag:true,password:"${PASSWORD}",options:{retries:3}};`)).toEqual(["Generic Secret Assignment"]);
    expect(found(`var c={featureFlags:["a"],secret:"${PASSWORD}"};`)).toEqual(["Generic Secret Assignment"]);
  });

  test("a table of API credentials with no emails is not exempt", () => {
    const rows = Array.from({ length: 3 }, (_, i) => `{name:"tenant${i}",secret:"${PASSWORD}${i}"}`).join(",");
    expect(found(`var t=[${rows}];`)).toEqual(Array(3).fill("Generic Secret Assignment"));
  });
});

describe("a real password with a bare parenthesis is not code", () => {
  test("`Pa(ssw.rd9Qx`, `Qx9===Kw3mT` shaped values", () => {
    expect(found(`var c={password:"Pa(ssw.rd9Qx"};`)).toEqual(["Generic Secret Assignment"]); // pragma: allowlist secret
    expect(found(`var a={password:"x(a.b);var d=g(h)+e.pwd"};`)).toEqual([]);
  });
});

describe("the gates stay linear on adversarial input", () => {
  test("a CSS-module-looking value of 256 KB is not run through the class regex", () => {
    const body = "Ab9__abc" + "___x1".repeat(52_000) + "!";
    const start = performance.now();
    found(`var c={password:"${body}"};`);
    // 9.4 s before the length cap, a few milliseconds after.
    expect(performance.now() - start).toBeLessThan(1500);
  });

  test("seed-data walks stop at the per-scan allowance on 5 MB of adversarial rows", () => {
    const rows = `{email:"a@acme.com",password:"${PASSWORD}"},`.repeat(Math.floor(5_000_000 / 52));
    seedWork.examined = 0;
    const start = performance.now();
    scanContent(`var u=[${rows}];`, "external-script", PAGE);
    // The allowance is 3 million characters of walking; one match may overshoot it by one walk.
    expect(seedWork.examined).toBeLessThanOrEqual(3_000_000 + 20_000);
    expect(performance.now() - start).toBeLessThan(3000);
  });

  test("a megabyte of object separators, brackets and elisions", () => {
    const inputs = [
      `[${"{password:\"" + PASSWORD + "\"},".repeat(8000)}]`,
      "[".repeat(300000) + `{password:"${PASSWORD}"}`,
      `{password:"${"abcd.".repeat(20)}..."}`.repeat(15000),
      `x=[{a:1},`.repeat(40000) + `{password:"${PASSWORD}"}`,
    ];
    for (const text of inputs) {
      const start = performance.now();
      scanContent(text, "external-script", PAGE);
      expect(performance.now() - start).toBeLessThan(5000);
    }
  });
});

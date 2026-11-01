// security/leaked-secrets: values that cannot be credentials and credentials
// that are sample data (#1292, #1308). Synthetic values only, built at runtime.

import { describe, expect, test } from "bun:test";

import { isImplausibleSecretValue, scanContent, seedWork } from "../../src/security/leaked-secrets";
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

describe("review follow-ups (#1292, #1308)", () => {
  test("a translation of the word `secret` in German is a label; with a digit or a symbol it is a value", () => {
    none(`var d={de:{password:"Geheimnis"}};`); // pragma: allowlist secret
    none(`var d={de:{secret:"Geheimnis",password:"Passwort"}};`); // pragma: allowlist secret
    expect(found(`var d={password:"Geheimnis9"};`)).toEqual(["Generic Secret Assignment"]); // pragma: allowlist secret
    expect(found(`var d={password:"Geheimnis!x"};`)).toEqual(["Generic Secret Assignment"]); // pragma: allowlist secret
  });

  test("a versioned storage key is a name whatever its prefix, with one or two version digits", () => {
    for (const value of ["app_secret_v6", "authentication_secret_v6", "myapplication_secret_v12", "storage:secret:v2", "user.auth.token.v3"]) {
      expect([value, found(`const K={secret:"${value}"};`)]).toEqual([value, []]);
    }
    for (const value of ["Authentication_secret_v6", "app_secret_v123", "abcdefghijklmnopqrstu_secret_v6", "App_secret_v6"]) {
      expect([value, found(`const K={secret:"${value}"};`).length > 0]).toEqual([value, true]);
    }
  });

  describe("sample tables: the email domains of the secret's own rows decide", () => {
    const secret = () => runOf(r, HEX, 40);
    const real = (list: string) => `var u=[${list}];`;

    test("a real secret row beside an unrelated row with a reserved-domain email still reports", () => {
      const text = real(`{env:"prod",secret:"${secret()}"},{env:"stage",secret:"${secret()}"},{env:"dev",secret:"${secret()}"},{contact:"x@example.com"}`);
      expect(found(text)).toEqual(Array(3).fill("Generic Secret Assignment"));
    });

    test("rows that carry the secret and reserved-domain emails are a sample, whatever else the array holds", () => {
      const row = (email: string, pw: string) => `{email:"${email}",secret:"${pw}"}`;
      const text = real(`${row("a@x.test", secret())},${row("b@demo.example", secret())},${row("c@example.com", secret())},{contact:"y@acme.com"}`);
      none(text);
    });

    test("one real-domain row among the secret's own rows keeps the table reporting", () => {
      const row = (email: string, pw: string) => `{email:"${email}",secret:"${pw}"}`;
      const text = real(`${row("a@x.test", secret())},${row("b@acme.com", secret())},${row("c@example.com", secret())}`);
      expect(found(text).length).toBeGreaterThan(0);
    });
  });

  test("tables holding a 7,000-character run of local-part characters scan in linear time", () => {
    const run = "a".repeat(7_000);
    // Distinct secrets in every table: the scan reports one finding per distinct value, so a repeated table is not rescanned.
    const table = () => `[{env:"e0",secret:"${mixedRun(r, 24, ALNUM)}"},{env:"e1",secret:"${mixedRun(r, 24, ALNUM)}"},{env:"e2",note:"${run}",secret:"${mixedRun(r, 24, ALNUM)}"}];`;
    const text = Array.from({ length: 250 }, table).join("");
    const start = performance.now();
    scanContent(text, "external-script", PAGE);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("joined identifiers are names of credentials, never passphrases or header values (#1292)", () => {
  const types = (text: string) => found(text);
  const LETTERS = "abcdefghijklmnopqrstuvwxyz";
  const WORDS = ["secret", "token", "key", "pass", "pwd", "auth", "cred", "api", "private", "bearer", "session", "sign", "salt", "jwt", "login", "access"];
  const neutral = (rng: () => number, separator: string): string => {
    for (;;) {
      const count = 2 + Math.floor(rng() * 3);
      const words = Array.from({ length: count }, () => runOf(rng as never, LETTERS, 3 + Math.floor(rng() * 6)));
      const value = words.join(separator);
      if (!WORDS.some((w) => value.includes(w))) return value;
    }
  };

  test("twelve catalogue names are still dropped", () => {
    for (const name of [
      "user_password_field", "secret:reset:token", "app_secret_v6", "my_app_secret_v6", "auth_token_v2_store", "storage:secret:v2",
      "authentication_secret_v6", "user.auth.token.v3", "api_key_name", "session_token_key", "login_pass_field", "private.key.path",
    ]) {
      expect([name, found(`const K={secret:"${name}"};`)]).toEqual([name, []]);
    }
  });

  test("random lower-case words joined by `_`, `:` or `.` (no credential word among them) are never dropped by the joined-identifier gate", () => {
    // The control is the same words joined by `-`, which the gate never reads: whatever else drops a value (an entropy floor)
    // drops both; the gate drops only the joined one.
    const rng = seededRng(12923);
    let total = 0;
    let reportedControl = 0;
    // (a dotted name is dropped by the older dotted-catalogue rule, which is not this gate)
    for (const separator of ["_", ":"]) {
      for (let i = 0; i < 300; i++) {
        const value = neutral(rng, separator);
        const control = value.split(separator).join("-");
        total++;
        const joined = found(`var c={password:"${value}"};`).length > 0;
        const hyphen = found(`var c={password:"${control}"};`).length > 0;
        if (hyphen) reportedControl++;
        if (hyphen && !joined) throw new Error(`the joined-identifier gate dropped: ${value}`);
      }
    }
    // the control is not vacuous: most neutral values are reported by the rest of the rule
    expect(reportedControl).toBeGreaterThan(total / 2);
  });

  test("a versioned key without a credential word is a value; with one it is a name", () => {
    expect(found(`const K={secret:"${runOf(seededRng(5), LETTERS, 12)}_${runOf(seededRng(6), LETTERS, 9)}_v6"};`).length).toBe(1);
    expect(found(`const K={secret:"authentication_secret_v6"};`)).toEqual([]); // pragma: allowlist secret
  });

  test("a Bearer value is never a name: a joined value after the scheme reports", () => {
    for (const value of ["app_secret_token_value_x1x2", "correct_horse_battery_staple_ok", "user_session_token_abcd"]) {
      expect([value, types(`var h="Authorization: Bearer ${value}";`)]).toEqual([value, ["Bearer Token"]]);
    }
    expect(types(`var h="Authorization: Basic ${Buffer.from("deploy:Xk9!mQ2vL8zP").toString("base64")}";`)).toEqual(["Basic Auth Header"]);
  });
});

describe("gates narrowed after the security review and the value-matched A/B (#1292, #1308)", () => {
  const SYMBOLS = ALNUM + "!@#$%^&*()-_+:;.|~";
  const randomValue = (rng: () => number, length: number): string => {
    for (;;) {
      let out = "";
      for (let i = 0; i < length; i++) out += SYMBOLS[Math.floor(rng() * SYMBOLS.length)];
      if (!/===|!==|=>/.test(out)) return out;
    }
  };

  test("a credential word counts only as a WHOLE segment: monkey, capital, bypass and author say nothing", () => {
    // random lower-case words that merely CONTAIN a credential word are values (the gate, read directly: natural-language words
    // are dropped by the entropy floor, which is not this gate)
    const rng = seededRng(4411);
    const word = (core: string) => runOf(rng as never, "abcdefghijklmnopqrstuvwxyz", 2) + core + runOf(rng as never, "abcdefghijklmnopqrstuvwxyz", 1);
    for (const core of ["monkey", "capital", "bypass", "author", "tokenize", "passage", "apiary", "keyed", "signal", "salty", "access", "sessions"]) {
      const joined = `${word(core)}_${runOf(rng as never, "abcdefghijklmnopqrstuvwxyz", 6)}_${runOf(rng as never, "abcdefghijklmnopqrstuvwxyz", 5)}`;
      expect([joined, isImplausibleSecretValue(joined, "Generic Secret Assignment")]).toEqual([joined, false]);
    }
    for (const joined of ["monkey_bread_farm", "capital_city_name", "bypass_cache_flag", "author_name_here", "tokenize_words_ok", "passage_text_one", "apiary_notes_xy"]) {
      expect([joined, isImplausibleSecretValue(joined, "Generic Secret Assignment")]).toEqual([joined, false]);
    }
    // the whole words still name a credential
    for (const joined of ["my_key_name", "the_pass_field", "user_auth_header", "api_notes_x", "salt_value_x", "login_form_field", "app_secret_v6", "user.auth.token.v3"]) {
      expect([joined, isImplausibleSecretValue(joined, "Generic Secret Assignment")]).toEqual([joined, true]);
    }
  });

  test("random symbol-rich passwords of 18, 40, 62 and 102 characters are not read as code", () => {
    const rng = seededRng(77123);
    for (const length of [18, 40, 62, 102]) {
      let dropped = 0;
      for (let i = 0; i < 2000; i++) if (isImplausibleSecretValue(randomValue(rng, length), "Generic Secret Assignment")) dropped++;
      expect([length, dropped]).toEqual([length, 0]);
    }
    // the clauses that were bare: `&&` and `||` beside a semicolon, one-letter member calls
    for (const value of ["Zx9&&Kw3;mQ7pLr2Tn5", "Xk9mQ2;vL8||zPq4rT7yU1iO3", "Pa(ssw.rd9Qx", "a.b(Qx9mKw3Zp7LrT2", "Qx9;a.b(mKw3Zp7LrT2yU"]) {
      expect([value, isImplausibleSecretValue(value, "Generic Secret Assignment")]).toEqual([value, false]);
    }
  });

  test("real code fragments are still dropped, up to 64 characters", () => {
    for (const code of ["a===b", "a!==b", "function(){return 1;}", "window.setTimeout(handler", "document.getElementById(id", "x=>y;return a", "var a=1;return b"]) {
      expect([code, isImplausibleSecretValue(code, "Generic Secret Assignment")]).toEqual([code, true]);
    }
    const fill = (n: number) => runOf(seededRng(31), ALNUM, n);
    expect(isImplausibleSecretValue(`a===b${fill(59)}`, "Generic Secret Assignment")).toBe(true);
    // 65 characters and up are not gated by the code-span rule
    expect(isImplausibleSecretValue(`a===b${fill(60)}`, "Generic Secret Assignment")).toBe(false);
  });

  test("a CSS-module class is the whole value `<file>__<local>___<hash>`; a secret that merely contains `module__` reports", () => {
    for (const cls of ["styles-module__secret___x9Y2z", "Button__primary___3xK9z", "app-module__password___a1B2c"]) {
      expect([cls, found(`var c={password:"${cls}"};`)]).toEqual([cls, []]);
    }
    const q = (n: number, seed: number) => runOf(seededRng(seed), ALNUM, n);
    for (const value of [`${q(12, 1)}-module__${q(12, 2)}`, `${q(12, 3)}_module__${q(15, 4)}`, `${q(6, 5)}___${q(16, 6)}`, `x_module__y${q(17, 7)}`, `a-module__b___cd${q(18, 8)}!`]) {
      expect([value, found(`var c={password:"${value}"};`).length > 0]).toEqual([value, true]);
    }
  });

  describe("a sample table needs a reserved email in EVERY row that carries the key", () => {
    const row = (email: string | undefined, pw: string) => `{${email === undefined ? "" : `email:"${email}",`}password:"${pw}"}`;
    const pw = (n: number) => "Xk9!" + runOf(seededRng(900 + n), ALNUM, 10);

    test("one row with a reserved email does not excuse the rows with none", () => {
      expect(found(`var u=[${row("a@example.com", pw(1))},${row(undefined, pw(2))},${row(undefined, pw(3))}];`)).toEqual(Array(3).fill("Generic Secret Assignment"));
    });

    test("every row with a reserved email is a sample; one real domain or one row without an email is not", () => {
      expect(found(`var u=[${row("a@example.com", pw(4))},${row("b@x.test", pw(5))},${row("c@demo.example", pw(6))}];`)).toEqual([]);
      expect(found(`var u=[${row("a@example.com", pw(7))},${row("b@acme.com", pw(8))},${row("c@demo.example", pw(9))}];`).length).toBe(3);
      expect(found(`var u=[${row("a@example.com", pw(10))},${row("b@x.test", pw(11))},${row(undefined, pw(12))}];`).length).toBe(3);
    }); // pragma: allowlist secret
  });
});

describe("pins after the final review (#1292)", () => {
  const gate = (value: string, name = "Generic Secret Assignment") => isImplausibleSecretValue(value, name);

  test("every credential word names a credential on its own (a joined name with only that word)", () => {
    const WORDS = ["secret", "secrets", "token", "tokens", "key", "keys", "apikey", "pass", "password", "passwd", "pwd", "auth", "authorization", "cred", "creds", "credential", "credentials", "api", "private", "bearer", "session", "sign", "signature", "salt", "jwt", "login", "access", "oauth"];
    for (const word of WORDS) {
      // words of up to eight characters join as is; longer ones take a version suffix (the versioned form allows sixteen)
      const value = word.length <= 8 ? `qzx_${word}_vwy` : `qzx_${word}_v6`;
      expect([word, gate(value)]).toEqual([word, true]);
      // and the same shape without the word is not a name
      expect([word, gate(word.length <= 8 ? `qzx_${word.split("").reverse().join("")}_vwy` : `qzx_${word.split("").reverse().join("")}_v6`)]).toEqual([word, false]);
    }
  });

  test("the Basic and Bearer header values are never read as a name", () => {
    for (const name of ["Bearer Token", "Basic Auth Header"]) expect([name, gate("app_secret_token_value_x1x2", name)]).toEqual([name, false]);
    expect(gate("app_secret_token_value_x1x2", "Generic Token Assignment")).toBe(true);
  });

  test("a CSS-module class is `<file>__<local>___<hash>` with a letter-first head of word characters and a hash of at least three", () => {
    expect(gate("styles-module__secret___x9Y")).toBe(true);
    expect(gate("styles-module__secret___x9")).toBe(false);
    expect(gate("a__b___cde")).toBe(true);
    expect(gate("a__b___cd")).toBe(false);
    // a head that is not an identifier: it starts with a digit, or has a character a class name cannot
    expect(gate("9styles-module__secret___x9Y2z")).toBe(false);
    expect(gate("sty.les-module__secret___x9Y2z")).toBe(false);
    expect(gate("styles module__secret___x9Y2z")).toBe(false);
    expect(gate("-styles__secret___x9Y2z")).toBe(false);
    // no local name between the `__` and the `___`
    expect(gate("styles-module____x9Y2z")).toBe(false);
    expect(gate("styles__x9Y2z")).toBe(false);
  });
});

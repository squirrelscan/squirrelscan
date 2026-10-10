// The one local / private-network host classifier (#1841, pub#629), shared by
// the CLI's cloud preflight and the rules runner's private-target gate.
//
// The contract under test is deliberately ASYMMETRIC: a false negative here is
// cheap (the API's stricter classifier still refuses a cloud handoff, and a dev
// server gets a few delivery findings), while a false POSITIVE silently stops a
// real customer site from publishing and switches its HTTPS checks off. So the
// "still public" cases matter more than the coverage cases.
import { describe, expect, test } from "bun:test";

import {
  isNonPublicHostname,
  isNonPublicUrl,
  nonPublicHostLabel,
} from "../src/non-public-host";

describe("nonPublicHostLabel", () => {
  test.each([
    ["http://localhost:3000", "localhost:3000"],
    ["http://localhost/", "localhost"],
    ["http://app.localhost:8080/x", "app.localhost:8080"],
    ["http://127.0.0.1:4321", "127.0.0.1:4321"],
    // All of 127.0.0.0/8 is loopback, not just .1.
    ["http://127.8.9.10/", "127.8.9.10"],
    ["http://10.0.0.5/", "10.0.0.5"],
    ["http://192.168.1.10:8000/path", "192.168.1.10:8000"],
    ["http://172.16.4.1/", "172.16.4.1"],
    ["http://172.31.255.254/", "172.31.255.254"],
    ["http://169.254.169.254/latest/meta-data", "169.254.169.254"],
    ["http://169.254.10.20/", "169.254.10.20"], // link-local
    ["http://[::1]:5173/", "[::1]:5173"],
    ["http://0.0.0.0:9000", "0.0.0.0:9000"],
    ["http://100.64.0.1/", "100.64.0.1"], // CGNAT (Tailscale and friends)
  ])("%s is local or private, labelled %s", (url, label) => {
    expect(nonPublicHostLabel(url)).toBe(label);
  });

  // The WHATWG URL parser canonicalizes these to 127.0.0.1 before the check
  // ever sees them, which is why the syntactic guard catches them at all.
  test.each([
    ["http://2130706433/", "127.0.0.1"],
    ["http://0177.0.0.1/", "127.0.0.1"],
  ])("the %s spelling of loopback is caught too", (url, label) => {
    expect(nonPublicHostLabel(url)).toBe(label);
  });

  test("a schemeless private host is normalized the same way the crawl does", () => {
    expect(nonPublicHostLabel("localhost:3000")).toBe("localhost:3000");
    expect(nonPublicHostLabel("127.0.0.1")).toBe("127.0.0.1");
  });

  test.each([
    ["https://example.com/"],
    ["https://www.squirrelscan.com/docs"],
    ["http://staging.example.com:8080/"],
    ["https://203.0.113.10/"], // a public literal IP
    ["http://172.32.0.1/"], // just past 172.16/12
    ["http://192.169.0.1/"], // just past 192.168/16
  ])("%s is public", (url) => {
    expect(nonPublicHostLabel(url)).toBeNull();
  });

  // A typo must be reported by the normal URL validation, which says something
  // useful, not by a reachability verdict that does not.
  test.each([[""], ["   "], ["not a url"], ["ftp://example.com/"]])(
    "unusable input %p is not classified here",
    (url) => {
      expect(nonPublicHostLabel(url)).toBeNull();
    }
  );

  // The name cases a private-IP check alone cannot see.
  test.each([
    ["http://mac-mini.local:3000/", "mac-mini.local:3000"],
    ["http://svc.cluster.local/", "svc.cluster.local"],
    ["http://metadata.google.internal/", "metadata.google.internal"],
    ["http://instance-data.ec2.internal/", "instance-data.ec2.internal"],
    ["http://router.home.arpa/", "router.home.arpa"],
    ["http://db.svc/", "db.svc"],
    ["http://host.lan/", "host.lan"],
    ["http://thing.corp/", "thing.corp"],
    // Single-label: resolves through the machine's own search domain.
    ["http://intranet/", "intranet"],
    ["http://nas:8080/", "nas:8080"],
    // Trailing root dot, at the apex and under it, however many dots.
    ["http://localhost./", "localhost."],
    ["http://app.localhost./", "app.localhost."],
    ["http://metadata.google.internal../", "metadata.google.internal.."],
  ])("%s is local or private, labelled %s", (url, label) => {
    expect(nonPublicHostLabel(url)).toBe(label);
  });

  // The NAME rules must never see an IP literal. Every IPv6 address is dotless,
  // so running the dotless-host rule over one would classify `2606:4700::1111`,
  // a real public address, as private.
  test.each([
    ["https://[2606:4700:4700::1111]/"],
    ["https://[2001:4860:4860::8888]/"],
    ["https://93.184.216.34/"],
  ])("%s is a PUBLIC IP literal", (url) => {
    expect(nonPublicHostLabel(url)).toBeNull();
  });

  test.each([
    ["http://[fd00::1]/", "[fd00::1]"], // ULA
    ["http://[fe80::1]/", "[fe80::1]"], // link-local
    ["http://[febf::1]/", "[febf::1]"], // the top of fe80::/10
    ["http://[::ffff:10.0.0.1]/", "[::ffff:a00:1]"],
  ])("%s is still caught by the IP rules", (url, label) => {
    expect(nonPublicHostLabel(url)).toBe(label);
  });

  test("uppercase does not evade the name rules", () => {
    expect(nonPublicHostLabel("http://METADATA.GOOGLE.INTERNAL/")).not.toBeNull();
    expect(nonPublicHostLabel("http://Box.Local/")).not.toBeNull();
    expect(nonPublicHostLabel("http://LOCALHOST:3000/")).not.toBeNull();
  });

  // The narrowness that makes the zone list safe: these merely CONTAIN a zone
  // name, or end in it below a public registrable domain. Each is a real site.
  test.each([
    ["https://my.corp.example.com/"],
    ["https://local.example.com/"],
    ["https://internal-tools.example.com/"],
    ["https://intranet.example.com/"],
    ["https://localhost.example.com/"],
    ["https://mylocalhost.com/"],
    ["https://localhost-app.io/"],
    ["https://shop.local.example/"],
    ["https://10.0.0.1.example.com/"],
  ])("%s is a look-alike and stays public", (url) => {
    expect(nonPublicHostLabel(url)).toBeNull();
  });

  // Syntactic only, by design: no DNS lookup. A public name that resolves to
  // loopback is still a name someone can publish.
  test("a public name that resolves to loopback is public", () => {
    expect(nonPublicHostLabel("http://127.0.0.1.nip.io:3000/")).toBeNull();
  });
});

describe("isNonPublicHostname", () => {
  test("takes a bare hostname, IPv6 without brackets", () => {
    expect(isNonPublicHostname("localhost")).toBe(true);
    expect(isNonPublicHostname("::1")).toBe(true);
    expect(isNonPublicHostname("fe80::1")).toBe(true);
    expect(isNonPublicHostname("example.com")).toBe(false);
    expect(isNonPublicHostname("2606:4700:4700::1111")).toBe(false);
  });
});

describe("isNonPublicUrl", () => {
  test("is the boolean form of the label", () => {
    expect(isNonPublicUrl("http://localhost:3000/")).toBe(true);
    expect(isNonPublicUrl("http://192.168.0.2/")).toBe(true);
    expect(isNonPublicUrl("https://example.com/")).toBe(false);
    expect(isNonPublicUrl("not a url")).toBe(false);
  });
});

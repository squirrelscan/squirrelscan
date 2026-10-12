// repo#2729: an audit requests at most `max_links` distinct external links. The
// choice must be deterministic, take the links on the most pages first, and
// put any the caller names (an open finding's links) ahead of the rest.

import { describe, expect, test } from "bun:test";

import { externalLinkCheckCap } from "@squirrelscan/core-contracts/limits";

import { linkTextLooksLikeAnAction } from "../src/link-target-probe";
import {
  looksLikeAnAction,
  selectExternalLinksToCheck,
  type ExternalLinkOccurrences,
} from "../src/adapter";

function occurrences(spec: Record<string, string[]>): ExternalLinkOccurrences {
  const map: ExternalLinkOccurrences = new Map();
  for (const [href, pages] of Object.entries(spec)) {
    map.set(
      href,
      pages.map((pageUrl) => ({ pageUrl, text: "", position: "body", isNofollow: false })) as never,
    );
  }
  return map;
}

const SITE = occurrences({
  "https://b.example/": ["/a", "/b"],
  "https://a.example/": ["/a", "/b"],
  "https://footer.example/": ["/a", "/b", "/c"],
  "https://once.example/": ["/c"],
  // The same page twice counts once.
  "https://twice.example/": ["/a", "/a"],
});

describe("selectExternalLinksToCheck", () => {
  test("everything when there is no limit or it fits", () => {
    expect(selectExternalLinksToCheck(SITE, undefined)).toHaveLength(5);
    expect(selectExternalLinksToCheck(SITE, 5)).toHaveLength(5);
  });

  test("most pages first, ties by URL", () => {
    expect(selectExternalLinksToCheck(SITE, 3)).toEqual([
      "https://footer.example/",
      "https://a.example/",
      "https://b.example/",
    ]);
  });

  test("links the caller names go first, and an unknown one is ignored", () => {
    expect(
      selectExternalLinksToCheck(SITE, 2, ["https://once.example/", "https://gone.example/"]),
    ).toEqual(["https://once.example/", "https://footer.example/"]);
  });
});

describe("externalLinkCheckCap", () => {
  test("the page budget, never below 200", () => {
    expect(externalLinkCheckCap(10)).toBe(200);
    expect(externalLinkCheckCap(500)).toBe(500);
    expect(externalLinkCheckCap(Number.NaN)).toBe(200);
  });
});

describe("looksLikeAnAction (the internal link probe never requests these)", () => {
  test("action paths, action queries and token-carrying links", () => {
    for (const url of [
      "https://example.com/logout",
      "https://example.com/account/sign-out?next=/",
      "https://example.com/newsletter/unsubscribe/abc123",
      "https://example.com/logout.php",
      "https://example.com/cart?remove=12",
      "https://example.com/item?action=delete&id=4",
      "https://example.com/cart/add?id=1",
      "https://example.com/add-to-cart/7",
      "https://example.com/?add-to-cart=7",
      "https://example.com/confirm/abc123def456",
      "https://example.com/email/verify",
      "https://example.com/password/reset",
      "https://example.com/help/delete-your-account",
      "https://example.com/one-click-unsubscribe",
      "https://example.com/checkout",
      "https://example.com/basket",
      "https://example.com/auth/callback",
      "https://example.com/oauth/authorize",
      "https://example.com/posts/9/like",
      "https://example.com/item/3/trash",
      "https://example.com/posts?id=7&_wpnonce=a1b2c3d4e5",
      "https://example.com/form?csrf_token=x",
      "https://example.com/invite?token=1",
      "https://example.com/download?file=a&sig=x",
      "https://example.com/view?ref=4f9c2b7e1d8a6f3c9b0e",
      "https://example.com/view?t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl", // pragma: allowlist secret
      "https://user:pass@example.com/", // pragma: allowlist secret
      "javascript:alert(1)",
      "mailto:a@example.com",
      // Forms that split, encode or run the words together.
      "https://example.com/logout;jsessionid=ABC123",
      "https://example.com/index.php?route=account/logout",
      "https://example.com/?q=user/logout",
      "https://example.com/index.php?option=com_users&task=user.logout",
      "https://example.com/users/sign_out",
      "https://example.com/UserLogout.aspx",
      "https://example.com/dologout",
      "https://example.com/account%2Flogout",
      "https://example.com/signoff",
      "https://example.com/unsub",
      // One-time tokens in the path, and a token used as a query key.
      "https://example.com/magic-login/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl", // pragma: allowlist secret
      "https://example.com/login/token/9f86d081884c7d659a2feaa0", // pragma: allowlist secret
      "https://example.com/index.php?9f86d081884c7d659a2feaa0c55ad015=1", // pragma: allowlist secret
      "https://example.com/magic-login/k3j4h5g6f7d8s9a0q1w2e3r4t5", // pragma: allowlist secret
      "https://example.com/login/k3j4h5g6f7d8s9a0q1w2e3r4t5", // pragma: allowlist secret
      "https://example.com/go?t=k3j4h5g6f7d8s9a0q1w2e3r4t5", // pragma: allowlist secret
      "https://example.com/items?action=deleteItem&id=5",
      "https://example.com/token/abc",
    ]) {
      expect(looksLikeAnAction(url), url).toBe(true);
    }
  });

  test("pages whose slug merely mentions an action, and plain ids, are still pages", () => {
    for (const url of [
      "https://example.com/blog/how-to-remove-stains",
      "https://example.com/help/when-to-cancel-a-plan",
      "https://example.com/where-to-buy",
      "https://example.com/blog/things-i-like",
      "https://example.com/products?id=4",
      "https://example.com/products?id=550e8400-e29b-41d4-a716-446655440000",
      "https://example.com/posts/550e8400-e29b-41d4-a716-446655440000",
      "https://example.com/p/507f1f77bcf86cd799439011",
      "https://example.com/blog?page=2&sort=new",
      "https://example.com/sale?utm_campaign=spring-sale-2024-email",
      "https://example.com/stores?lang_code=en&postal_code=2000",
      "https://example.com/catalog-outlet",
      "https://example.com/blog/how-to-verify-your-domain",
      "https://example.com/blog/unlock-the-power-of-ai",
      "https://example.com/sig-sauer-p320",
      "https://example.com/blog/password-managers-compared",
      "https://example.com/docs/getting-started",
      "https://example.com/",
    ]) {
      expect(looksLikeAnAction(url), url).toBe(false);
    }
  });
});

describe("linkTextLooksLikeAnAction", () => {
  test("rel=nofollow on action text", () => {
    expect(linkTextLooksLikeAnAction("Log out", true)).toBe(true);
    expect(linkTextLooksLikeAnAction("  Delete ", true)).toBe(true);
    expect(linkTextLooksLikeAnAction("Unsubscribe from all our emails", true)).toBe(true);
  });

  test("action text a page links normally, and ordinary nofollow text, are not", () => {
    // A product page linked as "Buy now" is still a page; its URL decides.
    expect(linkTextLooksLikeAnAction("Buy now", false)).toBe(false);
    expect(linkTextLooksLikeAnAction("Log out", false)).toBe(false);
    expect(linkTextLooksLikeAnAction("Pricing", true)).toBe(false);
    expect(linkTextLooksLikeAnAction("", true)).toBe(false);
  });
});

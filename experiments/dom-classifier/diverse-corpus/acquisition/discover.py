#!/usr/bin/env python3
"""Discover real same-host public links from cloud-run homepage seeds.

This is metadata-only acquisition planning: response bodies are parsed in
memory and never written or printed. Every candidate retains its seed URL and
the fetched response URL for provenance. It does not crawl links recursively.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import ipaddress
import json
import re
import socket
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

PRIVATE = {"account", "accounts", "admin", "auth", "authorize", "billing", "cart", "checkout", "dashboard", "invite", "login", "logout", "oauth", "profile", "register", "reset-password", "settings", "signin", "sign-in", "signup", "sign-up", "unsubscribe", "verify", "wp-admin"}
ATTACHMENTS = (".7z", ".csv", ".doc", ".docx", ".gif", ".jpeg", ".jpg", ".mov", ".mp3", ".mp4", ".pdf", ".png", ".ppt", ".pptx", ".svg", ".tar", ".txt", ".webm", ".webp", ".xls", ".xlsx", ".xml", ".zip")
MARKERS = (("docs_support", {"api", "docs", "documentation", "faq", "help", "support", "guides", "manual", "reference"}), ("pricing", {"plans", "pricing", "packages"}), ("about", {"about", "company", "mission", "story", "team"}), ("contact", {"contact", "demo", "request-demo"}), ("blog_news", {"blog", "article", "articles", "news", "press", "journal", "post", "posts"}), ("product", {"product", "products", "features", "solutions", "platform", "integrations"}), ("listing", {"search", "category", "categories", "tag", "tags", "directory", "catalog"}))

def host_ip_is_public(host: str) -> bool:
    try:
        for info in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM):
            address = ipaddress.ip_address(info[4][0])
            if address.is_private or address.is_loopback or address.is_link_local or address.is_reserved:
                return False
    except (OSError, ValueError):
        return False
    return True

class NoRedirect(HTTPRedirectHandler):
    def http_error_301(self, request, fp, code, msg, headers): return fp
    def http_error_302(self, request, fp, code, msg, headers): return fp
    def http_error_303(self, request, fp, code, msg, headers): return fp
    def http_error_307(self, request, fp, code, msg, headers): return fp
    def http_error_308(self, request, fp, code, msg, headers): return fp

def same_site(host: str, seed_host: str) -> bool:
    return host == seed_host or host.removeprefix("www.") == seed_host.removeprefix("www.")

def clean(raw: str, base_url: str, seed_host: str) -> str | None:
    try: p = urlsplit(urljoin(base_url, raw.strip()))
    except ValueError: return None
    host = (p.hostname or "").lower().rstrip(".")
    if p.scheme.lower() != "https" or not same_site(host, seed_host) or p.username or p.password or not host:
        return None
    path = p.path or "/"
    parts = {x.lower() for x in path.split("/") if x}
    if parts & PRIVATE or path.lower().endswith(ATTACHMENTS) or any(x.startswith("@") for x in parts):
        return None
    return urlunsplit(("https", host, path, "", ""))

def family(path: str) -> str:
    parts = {x for x in re.split(r"[-_/]+", path.strip("/").lower()) if x}
    if not parts: return "homepage"
    for name, markers in MARKERS:
        if parts & markers: return name
    return "inner_other"

class Links(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True); self.hrefs: list[str] = []
    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "a":
            href = dict(attrs).get("href")
            if href: self.hrefs.append(href)

def fetch(seed: dict[str, object], timeout: float, max_bytes: int) -> tuple[list[dict[str, object]], dict[str, object]]:
    source = str(seed["url"]); parsed = urlsplit(source); host = (parsed.hostname or "").lower().rstrip(".")
    if not host or not host_ip_is_public(host): return [], {"seed": source, "status": "private_or_unresolvable"}
    try:
        opener = build_opener(NoRedirect()); final = source
        for _ in range(4):
            if not host_ip_is_public(urlsplit(final).hostname or ""): return [], {"seed": source, "status": "private_redirect"}
            request = Request(final, headers={"User-Agent": "SquirrelScan-public-corpus-discovery/1.0"})
            with opener.open(request, timeout=timeout) as response:
                if 300 <= response.status < 400:
                    location = response.headers.get("location")
                    next_url = clean(location or "", final, host)
                    if not next_url: return [], {"seed": source, "status": "cross_host_redirect"}
                    final = next_url; continue
                content_type = response.headers.get("content-type", "")
                if response.status < 200 or response.status >= 400 or "html" not in content_type.lower():
                    return [], {"seed": source, "status": "non_html", "httpStatus": response.status}
                body = response.read(max_bytes + 1); break
        else: return [], {"seed": source, "status": "redirect_limit"}
        if len(body) > max_bytes: body = body[:max_bytes]
        parser = Links(); parser.feed(body.decode("utf-8", "replace"))
        seen: set[str] = set(); rows: list[dict[str, object]] = []
        for href in parser.hrefs:
            url = clean(href, final, host)
            if not url or url == source or url in seen: continue
            seen.add(url)
            rows.append({"url": url, "seedUrl": source, "fetchedUrl": final, "sourceBucket": seed.get("sourceBucket", "cloud-runs"), "familyHint": family(urlsplit(url).path), "candidateId": "cand_" + hashlib.sha256(url.encode()).hexdigest()[:32]})
        return rows, {"seed": source, "status": "ok", "httpStatus": response.status, "links": len(rows)}
    except Exception as error:
        return [], {"seed": source, "status": type(error).__name__}

def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--seeds", type=Path, required=True); ap.add_argument("--output", type=Path, required=True); ap.add_argument("--summary", type=Path, required=True); ap.add_argument("--workers", type=int, default=16); ap.add_argument("--timeout", type=float, default=12); ap.add_argument("--max-bytes", type=int, default=2_000_000)
    args = ap.parse_args()
    seeds = [json.loads(line) for line in args.seeds.read_text(encoding="utf-8").splitlines() if line.strip()]
    all_rows: list[dict[str, object]] = []; statuses: list[dict[str, object]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(args.workers, 32))) as pool:
        for rows, status in pool.map(lambda seed: fetch(seed, args.timeout, args.max_bytes), seeds):
            all_rows.extend(rows); statuses.append(status)
    unique = {str(row["url"]): row for row in all_rows}
    rows = sorted(unique.values(), key=lambda row: (str(row["seedUrl"]), str(row["familyHint"]), str(row["url"])))
    args.output.parent.mkdir(parents=True, exist_ok=True); args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows), encoding="utf-8")
    summary = {"seedCount": len(seeds), "successfulHtmlSeeds": sum(x.get("status") == "ok" for x in statuses), "candidateCount": len(rows), "candidateHosts": len({urlsplit(str(row["url"])).hostname for row in rows}), "families": dict(Counter(str(row["familyHint"]) for row in rows)), "statuses": dict(Counter(str(x.get("status")) for x in statuses))}
    args.summary.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8"); print(json.dumps(summary, sort_keys=True)); return 0

if __name__ == "__main__": raise SystemExit(main())

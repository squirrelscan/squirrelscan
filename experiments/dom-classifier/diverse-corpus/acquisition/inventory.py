#!/usr/bin/env python3
"""Build a redacted acquisition inventory from public HTTPS URL candidates.

The output contains no page bodies. It is a deterministic queue planner: source
provenance is supplied by the caller, private/auth paths are rejected, and page
families are path hints only until a capture is quality-reviewed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

PRIVATE = {"account", "admin", "auth", "billing", "cart", "checkout", "dashboard", "invite", "login", "oauth", "profile", "register", "reset-password", "settings", "signin", "signup", "verify", "wp-admin"}
FAMILY_MARKERS = (
    ("docs_support", {"api", "docs", "documentation", "faq", "help", "support", "guides", "manual", "reference"}),
    ("pricing", {"plans", "pricing", "packages"}),
    ("about", {"about", "company", "mission", "story", "team"}),
    ("contact", {"contact", "demo", "request-demo"}),
    ("blog_news", {"blog", "article", "articles", "news", "press", "journal", "post", "posts"}),
    ("product", {"product", "products", "features", "solutions", "platform", "integrations"}),
)

def clean(raw: str) -> tuple[str, str, str] | None:
    p = urlsplit(raw.strip())
    host = (p.hostname or "").lower().rstrip(".")
    if p.scheme.lower() != "https" or not host or p.username or p.password:
        return None
    path = p.path or "/"
    parts = {x.lower() for x in path.split("/") if x}
    if parts & PRIVATE or any(x.startswith("@")==True for x in parts):
        return None
    return urlunsplit(("https", host, path, "", "")), host, path

def family(path: str) -> str:
    parts = {x for x in re.split(r"[-_/]+", path.strip("/").lower()) if x}
    if not parts: return "homepage"
    for name, markers in FAMILY_MARKERS:
        if parts & markers: return name
    return "inner_other"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path, required=True, help="JSONL rows with url and sourceBucket")
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--exclude-host", action="append", default=[])
    args = ap.parse_args()
    rows = []
    seen = set()
    excluded = Counter()
    for line in args.input.read_text(encoding="utf-8").splitlines():
        if not line.strip(): continue
        value = json.loads(line)
        parsed = clean(str(value.get("url", "")))
        if not parsed:
            excluded["unsafe_url"] += 1; continue
        url, host, path = parsed
        if host in set(args.exclude_host):
            excluded["existing_host"] += 1; continue
        if url in seen: excluded["duplicate_url"] += 1; continue
        seen.add(url)
        source = str(value.get("sourceBucket", "public_seed"))
        rows.append({"url": url, "sourceBucket": source, "familyHint": family(path), "candidateId": "cand_" + hashlib.sha256(url.encode()).hexdigest()[:32]})
    rows.sort(key=lambda row: (row["sourceBucket"], row["familyHint"], row["url"]))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows), encoding="utf-8")
    print(json.dumps({"rows": len(rows), "hosts": len({urlsplit(row['url']).hostname for row in rows}), "families": dict(Counter(row["familyHint"] for row in rows)), "excluded": dict(excluded)}, sort_keys=True))
    return 0

if __name__ == "__main__": raise SystemExit(main())

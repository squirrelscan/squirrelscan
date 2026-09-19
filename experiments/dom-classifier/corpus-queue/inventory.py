#!/usr/bin/env python3
"""Build a bounded private URL queue for fresh DOM captures.

Metadata-first by design: reads campaign URL metadata and the existing private
provenance count, without scanning or decompressing the crawl content store.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import ipaddress
import json
import re
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

SEED = "dom-classifier-corpus-expansion-2026-09-18-v2"
PRIVATE_SEGMENTS = {
    "account", "accounts", "admin", "auth", "authorize", "billing", "cart",
    "checkout", "dashboard", "invite", "login", "logout", "oauth", "profile",
    "register", "reset-password", "settings", "signin", "sign-in", "signup",
    "sign-up", "unsubscribe", "verify", "wp-admin",
}
ATTACHMENT_SUFFIXES = {
    ".7z", ".csv", ".doc", ".docx", ".gif", ".jpeg", ".jpg", ".mov", ".mp3",
    ".mp4", ".pdf", ".png", ".ppt", ".pptx", ".svg", ".tar", ".txt", ".webm",
    ".webp", ".xls", ".xlsx", ".xml", ".zip",
}
TYPE_MARKERS = (
    ("docs_support", {"api", "docs", "documentation", "faq", "help", "support", "guides", "manual"}),
    ("pricing", {"plans", "pricing", "packages"}),
    ("about", {"about", "company", "mission", "story", "team"}),
    ("contact", {"contact", "demo", "book-a-demo", "request-demo"}),
    ("blog_news", {"blog", "articles", "posts", "journal", "news", "press", "media", "announcements"}),
    ("product", {"product", "products", "features", "solutions", "platform", "integrations"}),
)

def digest(value: str, length: int = 20) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]

def registrable_key(host: str) -> str:
    labels = [part for part in host.lower().split(".") if part]
    if len(labels) <= 2:
        return ".".join(labels)
    if len(labels[-1]) == 2 and labels[-2] in {"ac", "co", "com", "edu", "gov", "net", "org"}:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])

def safe_url(raw: object) -> tuple[str, str, str] | None:
    if not isinstance(raw, str):
        return None
    try:
        parsed = urlsplit(raw.strip())
    except ValueError:
        return None
    host = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme.lower() != "https" or not host or parsed.username or parsed.password:
        return None
    if host in {"producthunt.com", "www.producthunt.com"} or host.endswith(".producthunt.com"):
        return None
    if host in {"localhost", "localhost.localdomain"} or host.endswith((".localhost", ".local")):
        return None
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and (address.is_private or address.is_loopback or address.is_link_local or address.is_reserved):
        return None
    path = parsed.path or "/"
    segments = {part.lower() for part in path.split("/") if part}
    if segments & PRIVATE_SEGMENTS or path.lower().endswith(tuple(ATTACHMENT_SUFFIXES)):
        return None
    if any(part.startswith("@") for part in segments) or segments & {"me", "user", "users", "members"}:
        return None
    return urlunsplit(("https", host, path, "", "")), host, path

def page_type(path: str) -> str:
    clean = path.strip("/").lower()
    if not clean:
        return "homepage"
    parts = {part for part in re.split(r"[-_/]+", clean) if part}
    for kind, markers in TYPE_MARKERS:
        if parts & markers:
            return kind
    return "inner_other"

def load_candidates(path: Path) -> tuple[list[dict[str, object]], Counter[str]]:
    candidates: list[dict[str, object]] = []
    counts: Counter[str] = Counter()
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        return candidates, counts
    for item in data:
        counts["campaign_rows_seen"] += 1
        clean = safe_url(item.get("url") if isinstance(item, dict) else None)
        if not clean:
            counts["campaign_rows_excluded"] += 1
            continue
        url, host, path_part = clean
        candidates.append({
            "url": url, "host": host, "domain": registrable_key(host), "path": path_part,
            "pageType": page_type(path_part), "source": "producthunt-month-target-metadata",
            "domEvidence": "metadata_candidate_only", "corpusRef": "ph_target_" + digest(url, 32),
        })
    return candidates, counts

def stable(row: dict[str, object]) -> str:
    return digest(f"{SEED}:{row['domain']}:{row['url']}", 64)

def choose(rows: list[dict[str, object]], homepages: int, inner_pages: int) -> list[dict[str, object]]:
    unique = {str(row["url"]): row for row in rows}
    deduped = list(unique.values())
    homes: list[dict[str, object]] = []
    used_home: set[str] = set()
    for row in sorted((r for r in deduped if r["pageType"] == "homepage"), key=stable):
        if str(row["domain"]) in used_home:
            continue
        used_home.add(str(row["domain"]))
        homes.append(row)
        if len(homes) >= homepages:
            break
    kinds = sorted({str(row["pageType"]) for row in deduped if row["pageType"] != "homepage"})
    pools = {kind: sorted((r for r in deduped if r["pageType"] == kind), key=stable) for kind in kinds}
    inners: list[dict[str, object]] = []
    used_inner: set[str] = set()
    while len(inners) < inner_pages:
        progressed = False
        for kind in kinds:
            pool = pools[kind]
            while pool and str(pool[0]["domain"]) in used_inner:
                pool.pop(0)
            if not pool:
                continue
            row = pool.pop(0)
            inners.append(row)
            used_inner.add(str(row["domain"]))
            progressed = True
            if len(inners) >= inner_pages:
                break
        if not progressed:
            break
    if len(inners) < inner_pages:
        for row in sorted((r for r in deduped if r["pageType"] != "homepage"), key=stable):
            if row in inners or str(row["domain"]) in used_inner:
                continue
            inners.append(row)
            used_inner.add(str(row["domain"]))
            if len(inners) >= inner_pages:
                break
    return homes + inners

def provenance_count(path: Path | None) -> int:
    if not path or not path.exists():
        return 0
    return sum(1 for line in path.open(encoding="utf-8") if line.strip())

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--month-targets", type=Path, required=True)
    parser.add_argument("--existing-provenance", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--homepages", type=int, default=100)
    parser.add_argument("--inner-pages", type=int, default=100)
    args = parser.parse_args()
    rows, counts = load_candidates(args.month_targets)
    selected = choose(rows, args.homepages, args.inner_pages)
    counts["candidate_urls_after_normalization"] = len({str(r["url"]) for r in rows})
    counts["candidate_domains"] = len({str(r["domain"]) for r in rows})
    counts["selected_total"] = len(selected)
    counts["selected_homepages"] = sum(r["pageType"] == "homepage" for r in selected)
    counts["selected_inner_pages"] = len(selected) - counts["selected_homepages"]
    counts["selected_domains"] = len({str(r["domain"]) for r in selected})
    counts["preserved_provenance_rows"] = provenance_count(args.existing_provenance)
    counts["preserved_body_checks"] = 0
    args.output_dir.mkdir(parents=True, exist_ok=True)
    queue_path = args.output_dir / "queue.jsonl"
    with queue_path.open("w", encoding="utf-8") as stream:
        for row in selected:
            stream.write(json.dumps({"url": row["url"], "corpusRef": row["corpusRef"]}, separators=(",", ":")) + "\n")
    inventory = {
        "schemaVersion": 2, "seed": SEED,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": {"monthTargets": str(args.month_targets), "existingProvenance": str(args.existing_provenance) if args.existing_provenance else None, "readOnly": True, "metadataOnly": True, "crawlBodiesOpened": False, "freshNetwork": False},
        "counts": dict(sorted(counts.items())),
        "selectedPageTypes": dict(sorted(Counter(str(r["pageType"]) for r in selected).items())),
        "selectedDomains": sorted({str(r["domain"]) for r in selected}),
        "selectedMetadata": [{"url": r["url"], "domain": r["domain"], "pageType": r["pageType"], "source": r["source"], "domEvidence": r["domEvidence"]} for r in selected],
        "notes": ["URLs are normalized anonymous HTTPS candidates with query strings and fragments removed.", "The existing provenance file contributes a bounded count only; it has no URL mapping, so no DOM-preserved claim is made.", "Campaign metadata is candidate evidence, not proof that a DOM body is preserved.", "No crawl database or content-store body was opened in this metadata-first run."],
    }
    (args.output_dir / "inventory.json").write_text(json.dumps(inventory, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"queue": str(queue_path), "counts": dict(sorted(counts.items())), "types": inventory["selectedPageTypes"]}, sort_keys=True))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

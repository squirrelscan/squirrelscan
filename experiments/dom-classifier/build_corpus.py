#!/usr/bin/env python3
"""Build a private, reproducible DOM-region annotation corpus.

The program intentionally emits no source HTML and never writes to the crawl stores.
It uses only SQLite read-only connections and gzip-decompresses content-store entries
after verifying their SHA-256 keys.  Public code lives here; data belongs in a private
directory such as $DOM_CLASSIFIER_DATA_ROOT/<date>.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import html
import json
import random
import re
import sqlite3
import subprocess
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit


TAXONOMY = [
    "site_header", "footer", "navigation", "main_content", "article_header",
    "card", "aside", "form", "consent_banner", "unknown",
]
ALLOWED_ROLES = {
    "banner", "complementary", "contentinfo", "form", "main", "navigation",
    "region", "search", "dialog", "alertdialog", "article", "list", "listitem",
    "tablist", "menu", "menubar", "toolbar", "feed",
}
CONTAINER_TAGS = {
    "article", "aside", "dialog", "footer", "form", "header", "main", "nav",
    "section", "figure", "table", "ul", "ol", "div", "details", "fieldset",
}
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
SKIP_TAGS = {"script", "style", "template", "noscript", "svg", "canvas", "iframe", "object", "embed"}
SENSITIVE_TEXT = re.compile(
    r"(?ix)(?:\b(?:api[_ -]?key|secret|token|password|passwd|authorization)\b\s*[:=]\s*)[^\s,;]{4,}"
    r"|(?:bearer\s+)[a-z0-9._~+/=-]{8,}"
    r"|(?:\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})"
    r"|(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)"
    r"|(?:\b(?:\+?\d[\d(). -]{7,}\d)\b)"
    r"|(?:\bhttps?://[^\s<>{}\[\]]+)"
)
PACKET_ROOT_FIELDS = {"candidateId", "pageId", "siteId", "pageProvenance", "node"}
PROVENANCE_FIELDS = {
    "capturedAt", "capturedAtEpochMs", "captureMode", "captureEvidence",
    "contentHashVerified", "sourceHashPresent",
}
NODE_FIELDS = {
    "tag", "roles", "context", "ancestorTags", "siblingPosition", "siblingCount",
    "childCount", "childTags", "subtreeTagCounts", "linkCategories", "text",
    "contextText", "textLength", "textWordCount", "linkCount", "locator",
    "semanticAncestorChain", "classTokens", "idTokens", "repeatedSiblingPatternCount",
    "shapeFingerprint", "emptyText", "semanticAttributes", "srcCategory",
    "structureSummary", "mediaDescendants",
}
SEMANTIC_ANCESTOR_FIELDS = {"tag", "role"}
LINK_CATEGORIES = {"none", "mailto", "tel", "anchor", "unsafe", "relative", "same_site", "external", "other"}
SAFE_TAG = re.compile(r"^[a-z][a-z0-9-]{0,40}$")
# Attributes that describe an element a user cannot read as text.  Their values
# are author-written and can hold names, emails or phone numbers, so they go
# through sanitize_text exactly like node text does.
SEMANTIC_ATTRIBUTE_FIELDS = {"title", "aria-label", "role", "alt", "type", "name", "placeholder"}
MEDIA_DESCENDANT_FIELDS = {"tag", "attributes", "srcCategory"}
MEDIA_DESCENDANT_LIMIT = 6
# A src is reported only as a category.  A first-party host identifies the site,
# which packets deliberately hide, so a hostname must never appear here.  This
# mirrors `embedProviders` in extract-dom.ts; if that file adds a provider and
# this set is not updated the validator reports unallowed_value, which fails
# closed rather than leaking.
SRC_CATEGORIES = {
    "same-site", "other-third-party",
    "youtube", "vimeo", "wistia", "loom", "dailymotion", "brightcove", "jwplayer",
    "spotify", "soundcloud", "twitter", "facebook", "instagram", "tiktok",
    "linkedin", "pinterest", "reddit", "google", "google-analytics",
    "google-tag-manager", "google-ads", "stripe", "paypal", "recaptcha",
    "hcaptcha", "cloudflare", "typeform", "calendly", "hubspot", "intercom",
    "disqus", "zendesk", "drift", "mailchimp", "klaviyo", "shopify",
    "squarespace", "wix", "wordpress", "gravatar", "github", "codepen",
    "jsfiddle", "codesandbox", "figma", "canva", "airtable", "notion",
    "cloudinary", "imgix", "unsplash", "giphy", "imgur", "aws", "openstreetmap",
    "mapbox", "trustpilot", "algolia", "onetrust", "cookiebot", "usercentrics",
    "vidyard",
}
# "div*4,a*3,img": tag names with optional counts, nothing else.
STRUCTURE_SUMMARY = re.compile(r"^(?:[a-z][a-z0-9-]{0,40}(?:\*[1-9][0-9]{0,5})?(?:,[a-z][a-z0-9-]{0,40}(?:\*[1-9][0-9]{0,5})?)*)?$")


def sensitive_matches(value: str) -> int:
    """Return the number of sensitive-looking values in a string without retaining it."""
    return sum(1 for _ in SENSITIVE_TEXT.finditer(value))


def packet_validation_failures(record: object) -> Counter[str]:
    """Validate an annotation-packet record without reporting its private contents.

    The record has a deliberately closed shape. The recursive walk checks every
    serialized string, including context text and strings in nested objects, so a
    future extractor field cannot silently bypass the privacy review.
    """
    failures: Counter[str] = Counter()

    def fail(path: str, reason: str) -> None:
        failures[f"{path}:{reason}"] += 1

    def scan_strings(value: object, path: str) -> None:
        if isinstance(value, str):
            if sensitive_matches(value):
                fail(path, "sensitive_string")
        elif isinstance(value, list):
            for index, item in enumerate(value):
                scan_strings(item, f"{path}[{index}]")
        elif isinstance(value, dict):
            for key, item in value.items():
                if isinstance(key, str):
                    if sensitive_matches(key):
                        fail(f"{path}.<field>", "sensitive_string")
                    # Do not put an untrusted field name in the aggregate report.
                    scan_strings(item, f"{path}.<field>")

    def check_string(value: object, path: str) -> None:
        if not isinstance(value, str):
            fail(path, "expected_string")

    def check_string_list(value: object, path: str) -> None:
        if not isinstance(value, list):
            fail(path, "expected_array")
            return
        for index, item in enumerate(value):
            check_string(item, f"{path}[{index}]")

    def check_count_map(value: object, path: str, allowed_keys: set[str] | None = None) -> None:
        if not isinstance(value, dict):
            fail(path, "expected_object")
            return
        for key, count in value.items():
            if not isinstance(key, str):
                fail(path, "non_string_key")
                continue
            if allowed_keys is not None and key not in allowed_keys:
                fail(path, "unallowed_key")
            elif allowed_keys is None and not SAFE_TAG.fullmatch(key):
                fail(path, "unallowed_key")
            check_string(key, f"{path}.<key>")
            if not isinstance(count, int) or isinstance(count, bool) or count < 0:
                fail(path, "invalid_count")

    if not isinstance(record, dict):
        fail("$", "expected_object")
        return failures
    scan_strings(record, "$")
    for key in record:
        if key not in PACKET_ROOT_FIELDS:
            fail("$", "unallowed_field")
    for key in PACKET_ROOT_FIELDS:
        if key not in record:
            fail(f"$.{key}", "missing_required_field")
    for key in ("candidateId", "pageId", "siteId"):
        if key not in record:
            continue
        else:
            check_string(record[key], f"$.{key}")

    provenance = record.get("pageProvenance")
    if not isinstance(provenance, dict):
        fail("$.pageProvenance", "expected_object")
    else:
        for key in ("capturedAt", "captureMode", "contentHashVerified"):
            if key not in provenance:
                fail(f"$.pageProvenance.{key}", "missing_required_field")
        for key, value in provenance.items():
            if key not in PROVENANCE_FIELDS:
                fail("$.pageProvenance", "unallowed_field")
            elif isinstance(value, str):
                check_string(value, f"$.pageProvenance.{key}")
            elif value is not None and not isinstance(value, (int, bool)):
                fail(f"$.pageProvenance.{key}", "invalid_scalar")

    node = record.get("node")
    if not isinstance(node, dict):
        fail("$.node", "expected_object")
        return failures
    for key in node:
        if key not in NODE_FIELDS:
            fail("$.node", "unallowed_field")
    for key in NODE_FIELDS:
        if key not in node:
            fail(f"$.node.{key}", "missing_required_field")
    for key in ("tag", "context", "text", "contextText", "locator", "shapeFingerprint"):
        if key not in node:
            fail(f"$.node.{key}", "missing_required_field")
        else:
            check_string(node[key], f"$.node.{key}")
    for key in ("roles", "ancestorTags", "childTags", "classTokens", "idTokens"):
        if key not in node:
            fail(f"$.node.{key}", "missing_required_field")
        else:
            check_string_list(node[key], f"$.node.{key}")
    check_count_map(node.get("subtreeTagCounts"), "$.node.subtreeTagCounts")
    check_count_map(node.get("linkCategories"), "$.node.linkCategories", LINK_CATEGORIES)

    def check_semantic_attributes(value: object, path: str) -> None:
        """Closed key set and string values.  scan_strings already reports a
        sensitive value at this path, so the check here is shape only."""
        if not isinstance(value, dict):
            fail(path, "expected_object")
            return
        for key, item in value.items():
            if not isinstance(key, str):
                fail(path, "non_string_key")
                continue
            if key not in SEMANTIC_ATTRIBUTE_FIELDS:
                fail(path, "unallowed_key")
            check_string(item, f"{path}.<key>")

    def check_src_category(value: object, path: str) -> None:
        if value is None:
            return
        if not isinstance(value, str):
            fail(path, "expected_string")
        elif value not in SRC_CATEGORIES:
            # Never echo the value: an unallowed one is most likely a hostname.
            fail(path, "unallowed_value")

    if not isinstance(node.get("emptyText"), bool):
        fail("$.node.emptyText", "expected_boolean")
    summary = node.get("structureSummary")
    if not isinstance(summary, str):
        fail("$.node.structureSummary", "expected_string")
    elif not STRUCTURE_SUMMARY.fullmatch(summary):
        fail("$.node.structureSummary", "unallowed_value")
    check_semantic_attributes(node.get("semanticAttributes"), "$.node.semanticAttributes")
    check_src_category(node.get("srcCategory"), "$.node.srcCategory")

    media = node.get("mediaDescendants")
    if not isinstance(media, list):
        fail("$.node.mediaDescendants", "expected_array")
    else:
        if len(media) > MEDIA_DESCENDANT_LIMIT:
            fail("$.node.mediaDescendants", "too_many_items")
        for index, item in enumerate(media):
            path = f"$.node.mediaDescendants[{index}]"
            if not isinstance(item, dict):
                fail(path, "expected_object")
                continue
            for key in item:
                if key not in MEDIA_DESCENDANT_FIELDS:
                    fail(path, "unallowed_field")
            for key in MEDIA_DESCENDANT_FIELDS:
                if key not in item:
                    fail(f"{path}.{key}", "missing_required_field")
            item_tag = item.get("tag")
            if not isinstance(item_tag, str):
                fail(f"{path}.tag", "expected_string")
            elif not SAFE_TAG.fullmatch(item_tag):
                fail(f"{path}.tag", "unallowed_value")
            check_semantic_attributes(item.get("attributes"), f"{path}.attributes")
            check_src_category(item.get("srcCategory"), f"{path}.srcCategory")

    chain = node.get("semanticAncestorChain")
    if not isinstance(chain, list):
        fail("$.node.semanticAncestorChain", "expected_array")
    else:
        for index, ancestor in enumerate(chain):
            path = f"$.node.semanticAncestorChain[{index}]"
            if not isinstance(ancestor, dict):
                fail(path, "expected_object")
                continue
            for key in ancestor:
                if key not in SEMANTIC_ANCESTOR_FIELDS:
                    fail(path, "unallowed_field")
            for key in SEMANTIC_ANCESTOR_FIELDS:
                if key not in ancestor:
                    fail(f"{path}.{key}", "missing_required_field")
                elif ancestor[key] is not None:
                    check_string(ancestor[key], f"{path}.{key}")
    return failures


def validate_packet_files(packets_dir: Path) -> dict[str, object]:
    """Read packet JSONL files without modifying them and return aggregate failures."""
    failures: Counter[str] = Counter()
    records_checked = 0
    files_checked = 0
    for path in sorted(packets_dir.glob("*.jsonl")):
        files_checked += 1
        with path.open(encoding="utf-8") as file:
            for line in file:
                if not line.strip():
                    continue
                records_checked += 1
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    failures["$:invalid_json"] += 1
                    continue
                failures.update(packet_validation_failures(record))
    if files_checked == 0:
        failures["$:no_packet_files"] += 1
    return {
        "filesChecked": files_checked,
        "recordsChecked": records_checked,
        "failureCount": sum(failures.values()),
        "failures": dict(sorted(failures.items())),
    }


def digest(value: str, length: int = 20) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def readonly_connect(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def run_dom_helper(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    """Run the production parser helper in this public worktree, failing closed."""
    helper = Path(__file__).with_name("extract-dom.ts")
    payload = "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows)
    result = subprocess.run(
        ["bun", str(helper)], input=payload, text=True, capture_output=True, check=False, timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(f"production DOM helper failed: {result.stderr.strip()[:500]}")
    return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]


def registrable_domains(hosts: list[str]) -> dict[str, str]:
    rows = run_dom_helper([{"kind": "domain", "host": host} for host in hosts])
    domains = {str(row["host"]): str(row["domain"]) for row in rows}
    if len(domains) != len(set(hosts)):
        raise RuntimeError("production tldts resolver returned an incomplete result")
    return domains


_domain_cache: dict[str, str] = {}


def registrable_domain(host: str) -> str:
    if host not in _domain_cache:
        _domain_cache.update(registrable_domains([host]))
    return _domain_cache[host]


def iso_time(value: int | None) -> str | None:
    if not value:
        return None
    # Crawl timestamps are milliseconds. Keep the original value in page provenance too.
    return dt.datetime.fromtimestamp(value / 1000, tz=dt.timezone.utc).isoformat().replace("+00:00", "Z")


def sanitize_text(value: str, limit: int = 280) -> str:
    value = html.unescape(value)
    value = SENSITIVE_TEXT.sub("[REDACTED]", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value[:limit]


def href_category(raw: str | None, page_url: str) -> str:
    if not raw:
        return "none"
    # Allowlist, mirroring hrefCategory in extract-dom.ts: a denylist of
    # javascript:/data: silently missed vbscript: and anything added later.
    # Control characters and spaces are stripped first because browsers ignore
    # them when reading the scheme, so "java\tscript:" navigates as javascript:.
    value = re.sub(r"[\x00-\x20]", "", raw).lower()
    if raw.strip().startswith("#"):
        return "anchor"
    scheme_match = re.match(r"^([a-z][a-z0-9+.-]*):", value)
    if not scheme_match:
        return "relative"
    scheme = scheme_match.group(1)
    if scheme in {"mailto", "tel"}:
        return scheme
    if scheme not in {"http", "https"}:
        return "unsafe"
    raw = raw.strip()
    try:
        target, base = urlsplit(raw), urlsplit(page_url)
    except ValueError:
        return "other"
    if not target.scheme and not target.netloc:
        return "relative"
    if target.hostname and target.hostname == base.hostname:
        return "same_site"
    if target.hostname:
        return "external"
    return "other"


def candidate_score(node: dict[str, object]) -> int:
    text_length = len(sanitize_text(str(node["text"]), 900))
    score = 0
    if str(node["tag"]) in {"header", "footer", "nav", "main", "article", "aside", "form", "dialog"}:
        score += 7
    if list(node["roles"]):
        score += 5
    if str(node["tag"]) in CONTAINER_TAGS:
        score += 2
    if 40 <= text_length <= 1100:
        score += 2
    if 2 <= int(node["childCount"]) <= 18:
        score += 1
    if text_length > 2200 and str(node["tag"]) in {"div", "main", "article", "section"}:
        score -= 12
    return score


def sanitize_attributes(value: object) -> dict[str, str]:
    """Attribute values are author-written prose and get the same redaction as text.

    An `alt`, `title`, `aria-label` or `placeholder` routinely carries a person's
    name, an email address or a phone number, so it cannot be copied through.
    """
    if not isinstance(value, dict):
        return {}
    return {
        key: sanitize_text(str(item), limit=200)
        for key, item in value.items()
        if isinstance(key, str) and key in SEMANTIC_ATTRIBUTE_FIELDS
    }


def candidate_record(node: dict[str, object], page: dict[str, object], salt: str, order: int) -> dict[str, object]:
    safe_node = dict(node)
    text = sanitize_text(str(safe_node.pop("text")))
    context_text = sanitize_text(str(safe_node.pop("contextText", "")), limit=180)
    weak_signals = safe_node.pop("weakSignals", {})
    safe_node["text"] = text
    safe_node["textLength"] = len(text)
    safe_node["contextText"] = context_text
    # Redact before the signature below, so the fingerprint covers what is kept.
    safe_node["semanticAttributes"] = sanitize_attributes(safe_node.get("semanticAttributes"))
    media = safe_node.get("mediaDescendants")
    safe_node["mediaDescendants"] = [
        {
            "tag": str(item.get("tag", "")),
            "attributes": sanitize_attributes(item.get("attributes")),
            "srcCategory": item.get("srcCategory"),
        }
        for item in (media if isinstance(media, list) else [])[:MEDIA_DESCENDANT_LIMIT]
        if isinstance(item, dict)
    ]
    signature = json.dumps({key: value for key, value in safe_node.items() if key not in {"text", "textLength"}}, sort_keys=True)
    safe_node["shapeFingerprint"] = digest(signature, 24)
    return {
        "candidateId": f"dom_{digest(salt + str(page['pageId']) + str(order) + signature)}",
        "pageId": page["pageId"],
        "siteId": page["siteId"],
        "pageProvenance": page["pageProvenance"],
        "node": safe_node,
        "weakSignals": {"node": weak_signals, "page": page.get("pageSignals", {})},
    }


def query_pages(project: Path) -> list[dict[str, object]]:
    try:
        with readonly_connect(project) as db:
            rows = db.execute(
                """SELECT url, normalized_url, final_url, fetched_at, content_hash, fetcher_id, source_hash
                   FROM pages WHERE status BETWEEN 200 AND 299 AND lower(coalesce(content_type,'')) LIKE 'text/html%'
                   AND content_hash <> '' ORDER BY fetched_at DESC"""
            ).fetchall()
    except sqlite3.Error:
        return []
    return [dict(zip(("url", "normalized_url", "final_url", "fetched_at", "content_hash", "fetcher_id", "source_hash"), row)) for row in rows]


def load_html(store: sqlite3.Connection, content_hash: str) -> str | None:
    row = store.execute("SELECT content, content_type FROM content WHERE hash = ?", (content_hash,)).fetchone()
    if not row or row[1] != "text/html":
        return None
    try:
        raw = gzip.decompress(row[0])
    except (OSError, EOFError):
        return None
    if hashlib.sha256(raw).hexdigest() != content_hash:
        return None
    return raw.decode("utf-8", errors="replace")


def choose_pages(projects_root: Path, store: sqlite3.Connection, seed: str, target_sites: int) -> tuple[list[dict[str, object]], dict[str, int]]:
    projects = sorted(projects_root.glob("*/project.db"), key=lambda path: digest(seed + str(path)))
    selected: list[dict[str, object]] = []
    seen_hashes: set[str] = set()
    seen_domains: set[str] = set()
    counters = Counter()
    for project in projects:
        if len(selected) >= target_sites:
            break
        rows = query_pages(project)
        counters["projects_scanned"] += 1
        for row in rows:
            content_hash = str(row["content_hash"])
            if content_hash in seen_hashes:
                counters["duplicate_source_bodies"] += 1
                continue
            body = load_html(store, content_hash)
            if not body or len(body) < 600:
                counters["unusable_bodies"] += 1
                continue
            url = str(row["final_url"] or row["normalized_url"] or row["url"])
            host = urlsplit(url).hostname or project.parent.name
            site_domain = registrable_domain(host)
            if site_domain in seen_domains:
                counters["duplicate_domains"] += 1
                continue
            fetcher_id = row["fetcher_id"]
            # This is a stored fetcher metadata classification, not proof of network source.
            capture_mode = "source" if fetcher_id == "fetch" else "unknown"
            selected.append({
                "html": body,
                "contentHash": content_hash,
                "siteId": f"site_{digest(seed + site_domain)}",
                "pageId": f"page_{digest(seed + content_hash)}",
                # This raw URL is held only in memory to classify links. It is never emitted.
                "url": url,
                "sourceRow": {
                    "project": project.parent.name,
                    "host": host,
                    "registrableDomain": site_domain,
                    "urlPathHash": digest(urlsplit(url).path or "/"),
                    "urlHadQuery": bool(urlsplit(url).query),
                    "contentHash": content_hash,
                    "fetchedAtEpochMs": row["fetched_at"],
                    "fetcherId": fetcher_id,
                    "sourceHash": row["source_hash"],
                },
                "pageProvenance": {
                    "capturedAt": iso_time(int(row["fetched_at"]) if row["fetched_at"] else None),
                    "capturedAtEpochMs": row["fetched_at"],
                    "captureMode": capture_mode,
                    "captureEvidence": f"fetcher_id={fetcher_id}" if fetcher_id else None,
                    "contentHashVerified": True,
                    "sourceHashPresent": bool(row["source_hash"]),
                },
            })
            seen_hashes.add(content_hash)
            seen_domains.add(site_domain)
            break
    return selected, dict(counters)


def make_packets(records: list[dict[str, object]], seed: str, packets_dir: Path) -> dict[str, int]:
    packets_dir.mkdir(parents=True, exist_ok=True)
    # 375 disjoint base candidates; 25-record circular overlaps create three 150-record packets.
    base = records[:375]
    if len(base) < 375:
        raise RuntimeError(f"Need at least 375 deduplicated candidates; collected {len(base)}")
    groups = [base[index * 125:(index + 1) * 125] for index in range(3)]
    for index, group in enumerate(groups):
        overlap = groups[(index + 1) % 3][:25]
        packet = group + overlap
        random.Random(f"{seed}:packet:{index}").shuffle(packet)
        path = packets_dir / f"luna-shard-{index + 1:02d}.jsonl"
        with path.open("w", encoding="utf-8") as file:
            for record in packet:
                # Weak parser signals are retained privately for later modeling but hidden
                # from annotators, so semantic chrome hints cannot become pseudo-labels.
                packet_record = {key: value for key, value in record.items() if key != "weakSignals"}
                file.write(json.dumps(packet_record, ensure_ascii=False, separators=(",", ":")) + "\n")
    return {"packetCount": 3, "recordsPerPacket": 150, "baseCandidates": 375, "overlapPerPacket": 25}


def make_split_groups(records: list[dict[str, object]], output: Path) -> dict[str, int]:
    """Freeze connected domain/template groups for a leakage-safe later split.

    A template signature is deliberately text-free and quantizes page-level candidate
    structure. Pages sharing a domain or a signature become one connected split group.
    This sidecar is not exposed to annotators and does not influence their labels.
    """
    by_page: dict[str, list[dict[str, object]]] = {}
    for record in records:
        by_page.setdefault(str(record["pageId"]), []).append(record)
    parent = {page_id: page_id for page_id in by_page}

    def find(item: str) -> str:
        while parent[item] != item:
            parent[item] = parent[parent[item]]
            item = parent[item]
        return item

    def union(left: str, right: str) -> None:
        left, right = find(left), find(right)
        if left != right:
            parent[right] = left

    by_domain: dict[str, list[str]] = {}
    by_template: dict[str, list[str]] = {}
    template_ids: dict[str, str] = {}
    for page_id, page_records in by_page.items():
        tags = Counter(str(record["node"]["tag"]) for record in page_records)
        contexts = Counter(str(record["node"]["context"]) for record in page_records)
        bucket = lambda count: "0" if count == 0 else "1" if count == 1 else "2_3" if count < 4 else "4_7" if count < 8 else "8_plus"
        profile = {"tags": {tag: bucket(count) for tag, count in sorted(tags.items())}, "contexts": {context: bucket(count) for context, count in sorted(contexts.items())}}
        template_id = f"tmpl_{digest(json.dumps(profile, sort_keys=True), 20)}"
        template_ids[page_id] = template_id
        by_domain.setdefault(str(page_records[0]["siteId"]), []).append(page_id)
        by_template.setdefault(template_id, []).append(page_id)
    for group in list(by_domain.values()) + list(by_template.values()):
        for page_id in group[1:]:
            union(group[0], page_id)
    group_ids = {page_id: f"split_{digest(find(page_id), 20)}" for page_id in by_page}
    with output.open("w", encoding="utf-8") as file:
        for record in records:
            page_id = str(record["pageId"])
            file.write(json.dumps({"candidateId": record["candidateId"], "pageId": page_id, "siteId": record["siteId"], "templateFamilyId": template_ids[page_id], "splitGroupId": group_ids[page_id]}, separators=(",", ":")) + "\n")
    return {"splitGroups": len(set(group_ids.values())), "templateFamilies": len(by_template), "grouping": "connected components of registrable-domain and quantized text-free template-family links"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--projects-root", type=Path)
    parser.add_argument("--content-store", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--validate-packets", type=Path, metavar="DIR", help="read and validate existing packet JSONL files without modifying them")
    parser.add_argument("--seed", default="dom-classifier-2026-09-18-v1")
    parser.add_argument("--sites", type=int, default=55)
    parser.add_argument("--candidates", type=int, default=480)
    args = parser.parse_args()
    if args.validate_packets:
        if args.projects_root or args.content_store or args.output:
            parser.error("--validate-packets cannot be combined with corpus-building options")
        result = validate_packet_files(args.validate_packets)
        print(json.dumps(result, sort_keys=True))
        return 0 if result["failureCount"] == 0 else 1
    if not args.projects_root or not args.content_store or not args.output:
        parser.error("--projects-root, --content-store, and --output are required when building a corpus")
    if args.candidates < 400 or args.candidates > 800:
        parser.error("--candidates must be between 400 and 800")
    args.output.mkdir(parents=True, exist_ok=True)
    with readonly_connect(args.content_store) as store:
        pages, selection_stats = choose_pages(args.projects_root, store, args.seed, args.sites)
    all_candidates: list[dict[str, object]] = []
    fingerprints: set[str] = set()
    candidates_by_page: list[list[dict[str, object]]] = []
    requests = [{"kind": "page", "pageId": page["pageId"], "siteId": page["siteId"], "pageProvenance": page["pageProvenance"], "url": page["url"], "html": page["html"]} for page in pages]
    parsed_pages = {str(result["pageId"]): result for result in run_dom_helper(requests)}
    if len(parsed_pages) != len(pages):
        raise RuntimeError("production DOM helper did not return every selected page")
    for page in pages:
        parsed = parsed_pages[str(page["pageId"])]
        page["pageSignals"] = parsed["pageSignals"]
        nodes = [node for node in parsed["candidates"] if candidate_score(node) >= 4]
        # Deterministic local prioritization only; it is not a label and is omitted from packets.
        nodes.sort(key=lambda node: (-candidate_score(node), str(node["locator"])))
        page_candidates: list[dict[str, object]] = []
        for order, node in enumerate(nodes):
            record = candidate_record(node, page, args.seed, order)
            page_candidates.append(record)
        candidates_by_page.append(page_candidates)
    # Round-robin makes domain diversity a corpus property, not an accident of DOM size.
    positions = [0] * len(candidates_by_page)
    while len(all_candidates) < args.candidates:
        advanced = False
        for index, page_candidates in enumerate(candidates_by_page):
            while positions[index] < len(page_candidates):
                record = page_candidates[positions[index]]
                positions[index] += 1
                fingerprint = str(record["node"]["shapeFingerprint"])
                if fingerprint in fingerprints:
                    continue
                fingerprints.add(fingerprint)
                all_candidates.append(record)
                advanced = True
                break
            if len(all_candidates) >= args.candidates:
                break
        if not advanced:
            break
    if len(all_candidates) < 375:
        raise RuntimeError(f"Only {len(all_candidates)} structure-deduplicated candidates available")
    packet_records = [{key: value for key, value in record.items() if key != "weakSignals"} for record in all_candidates]
    prewrite_failures: Counter[str] = Counter()
    for record in packet_records:
        prewrite_failures.update(packet_validation_failures(record))
    if prewrite_failures:
        raise RuntimeError(f"Refusing to write packets with privacy validation failures: {json.dumps(dict(sorted(prewrite_failures.items())), sort_keys=True)}")
    # The private corpus includes a larger candidate pool; packets have no heuristic labels.
    corpus_path = args.output / "candidates.jsonl"
    with corpus_path.open("w", encoding="utf-8") as file:
        for record in all_candidates:
            file.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    # Kept private alongside the corpus, separate from annotation packets. It retains all
    # source-row fields used in selection but never records a raw URL or query string.
    provenance_path = args.output / "page-provenance.jsonl"
    with provenance_path.open("w", encoding="utf-8") as file:
        for page in pages:
            file.write(json.dumps({"pageId": page["pageId"], "siteId": page["siteId"], "sourceRow": page["sourceRow"], "pageProvenance": page["pageProvenance"]}, ensure_ascii=False, separators=(",", ":")) + "\n")
    packet_stats = make_packets(all_candidates, args.seed, args.output / "packets")
    packet_privacy = validate_packet_files(args.output / "packets")
    if packet_privacy["failureCount"]:
        raise RuntimeError(f"Packet privacy validation failed after writing: {json.dumps(packet_privacy, sort_keys=True)}")
    split_stats = make_split_groups(all_candidates, args.output / "split-groups.jsonl")
    site_ids = {str(page["siteId"]) for page in pages}
    corpus_site_ids = {str(record["siteId"]) for record in all_candidates}
    privacy_checks = {
        "candidateRecordsCheckedBeforeWrite": len(packet_records),
        "packetScan": packet_privacy,
        "validation": "recursive field allowlist and sensitive-string scan across every packet string",
    }
    manifest = {
        "schemaVersion": 2,
        "corpusVersion": "dom-regions-v2",
        "annotationVersionExpected": "dom-role-v2",
        "createdAt": dt.datetime.now(tz=dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "seed": args.seed,
        "input": {"projectsRoot": str(args.projects_root), "contentStore": str(args.content_store), "readOnly": True},
        "selection": {"requestedSites": args.sites, "selectedPages": len(pages), "contributingPages": len({str(record["pageId"]) for record in all_candidates}), "emptySelectedPages": len(pages) - len({str(record["pageId"]) for record in all_candidates}), "selectedRegistrableDomains": len(site_ids), "registrableDomainsInCorpus": len(corpus_site_ids), "onePagePerRegistrableDomain": len(pages) == len(site_ids), "sampling": "deterministic one-page-per-domain selection; not stratified", "domainResolver": "tldts (crawler dependency)", **selection_stats},
        "corpus": {"candidateRecords": len(all_candidates), "uniqueShapeFingerprints": len(fingerprints), "dedup": "source body SHA-256 then fingerprint over structural metadata, sanitized context text, locator, and curated class/id tokens; not text-free", **split_stats},
        "provenance": {"modePolicy": "captureMode=source only classifies stored fetcher_id=fetch metadata; it is not independent proof of network source", "historicalReplayClaimed": False},
        "annotation": {"taxonomy": TAXONOMY, "goldLabelsPresent": False, "heuristicLabelsPresent": False, **packet_stats},
        "privacyChecks": privacy_checks,
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (args.output / "stats.json").write_text(json.dumps({"tags": Counter(r["node"]["tag"] for r in all_candidates), "contexts": Counter(r["node"]["context"] for r in all_candidates)}, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())

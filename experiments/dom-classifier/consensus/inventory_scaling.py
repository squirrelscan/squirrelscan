#!/usr/bin/env python3
"""Aggregate a private capture packet without printing URLs or node text."""
from __future__ import annotations
import argparse, json
from collections import Counter
from pathlib import Path

DECORATIVE = {"rect", "circle", "g", "font", "svg", "path", "canvas", "style", "script"}

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--captures", type=Path, required=True)
    ap.add_argument("--splits", type=Path, required=True, help="JSONL assignments containing pageId, split, and group fields")
    args = ap.parse_args()
    assignments = {x["pageId"]: x for x in map(json.loads, args.splits.read_text().splitlines()) if x.get("pageId")}
    pages = []
    for path in sorted(args.captures.glob("*.json")):
        item = json.loads(path.read_text())
        if item.get("id") in assignments:
            pages.append((item, assignments[item["id"]]))
    out = {"pages": len(pages), "splits": {}, "groups": {"unique": len({a.get("connectedGroupId") for _, a in pages}), "maxPages": 0}}
    groups = Counter(a.get("connectedGroupId") for _, a in pages)
    out["groups"]["maxPages"] = max(groups.values(), default=0)
    for split in ("train", "validation", "test"):
        selected = [p for p, a in pages if a.get("split") == split]
        nodes = [n for p in selected for n in p.get("nodes", [])]
        useful = [n for n in nodes if (n.get("text") or "").strip() and n.get("tag") not in DECORATIVE]
        out["splits"][split] = {
            "pages": len(selected), "nodes": len(nodes),
            "nonEmptyTextNodes": sum(bool((n.get("text") or "").strip()) for n in nodes),
            "usefulNodes": len(useful),
            "uniqueTagTextSignatures": len({(n.get("tag"), (n.get("text") or "").strip()) for n in useful}),
            "divSectionNodes": sum(n.get("tag") in {"div", "section"} for n in nodes),
            "divSectionUsefulNodes": sum(n.get("tag") in {"div", "section"} for n in useful),
            "pageCapsRawNodes": {str(cap): sum(min(len(p.get("nodes", [])), cap) for p in selected) for cap in (50, 100, 200)},
            "pageCapsUsefulNodes": {str(cap): sum(min(sum(1 for n in p.get("nodes", []) if (n.get("text") or "").strip() and n.get("tag") not in DECORATIVE), cap) for p in selected) for cap in (50, 100, 200)},
        }
    print(json.dumps(out, sort_keys=True))

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Freeze diverse-corpus groups and splits before any labels are read."""

import argparse, hashlib, json
from collections import defaultdict
from pathlib import Path

SPLITS = ("train", "validation", "test")
TARGET = {"train": 70, "validation": 15, "test": 15}


def h(s):
    return "sha256:" + hashlib.sha256(s.encode()).hexdigest()


def rows(p):
    return [json.loads(x) for x in p.read_text().splitlines() if x]


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--source", type=Path, required=True)
    a.add_argument("--captures", type=Path, required=True)
    a.add_argument("--output", type=Path, required=True)
    x = a.parse_args()
    if x.output.exists():
        raise ValueError(
            "frozen output already exists; split assignments are immutable"
        )
    pages = rows(x.source)
    parent = {}

    def find(v):
        parent.setdefault(v, v)
        if parent[v] != v:
            parent[v] = find(parent[v])
        return parent[v]

    def union(a, b):
        a, b = find(a), find(b)
        if a != b:
            parent[max(a, b)] = min(a, b)

    bytext = defaultdict(list)
    for p in pages:
        if not all(
            isinstance(p.get(k), str)
            for k in ("pageId", "captureHash", "domainGroup", "path")
        ):
            raise ValueError("source row lacks frozen capture identity/domain")
        cap = json.loads((x.captures / p["path"]).read_text())
        text = " ".join(
            str(n.get("text", "")).strip().lower()
            for n in cap.get("nodes", [])
            if isinstance(n, dict)
            and str(n.get("tag", "")).lower() in {"main", "article", "body"}
        )
        normalized = " ".join(text.split())
        p["normalizedMainTextHash"] = h(normalized)
        # Empty/absent landmarks carry no evidence of shared content.  Keeping them
        # out of the equivalence map prevents unrelated pages from becoming one
        # giant connected group while still grouping identical non-empty text.
        if normalized:
            bytext[p["normalizedMainTextHash"]].append(p["domainGroup"].lower())
    for ds in bytext.values():
        for d in ds[1:]:
            union(ds[0], d)
    groups = defaultdict(list)
    for p in pages:
        groups[find(p["domainGroup"].lower())].append(p)
    totals = defaultdict(int)
    assigned = {}
    for g, ps in sorted(
        groups.items(), key=lambda t: (hashlib.sha256(t[0].encode()).hexdigest(), t[0])
    ):
        split = min(
            SPLITS,
            key=lambda s: (
                max(0, totals[s] + len(ps) - len(pages) * TARGET[s] / 100),
                totals[s],
                SPLITS.index(s),
            ),
        )
        assigned[g] = split
        totals[split] += len(ps)
    out = []
    for p in pages:
        g = find(p["domainGroup"].lower())
        out.append({**p, "connectedGroupId": g, "split": assigned[g]})
    x.output.parent.mkdir(parents=True, exist_ok=True)
    x.output.write_text("\n".join(json.dumps(p, sort_keys=True) for p in out) + "\n")
    print(
        json.dumps(
            {"pages": len(out), "groups": len(groups), "counts": dict(totals)},
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()

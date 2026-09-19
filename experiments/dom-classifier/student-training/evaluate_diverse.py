#!/usr/bin/env python3
"""Frozen, split-scoped scoring of independent Luna silver labels."""

import argparse, json
from collections import defaultdict
from pathlib import Path

AXES = {
    "node": ("componentType", "regions", "purposes"),
    "page": ("pageTypes", "contentKinds"),
}


def vocabulary():
    x = json.loads((Path(__file__).parents[1] / "taxonomy.json").read_text())[
        "allowedLabels"
    ]
    return {
        "componentType": x["componentTypes"],
        "regions": x["regions"],
        "purposes": x["purposes"],
        "pageTypes": x["pageTypes"],
        "contentKinds": x["contentKinds"],
    }


def rows(p):
    return [json.loads(x) for x in p.read_text().splitlines() if x]


def key(r):
    k = r.get("recordType"), r.get("pageId"), r.get("nodeId"), r.get("captureHash")
    if (
        k[0] not in AXES
        or not isinstance(k[1], str)
        or not isinstance(k[3], str)
        or (k[0] == "node" and not isinstance(k[2], str))
        or (k[0] == "page" and k[2] is not None)
    ):
        raise ValueError("invalid record identity")
    return k


def obs(r, a):
    x = r.get("observedAxes", {}).get(a)
    if not isinstance(x, dict) or x.get("complete") not in (True, False):
        return None
    if not isinstance(x.get("labels"), list) or not all(
        isinstance(v, str) for v in x["labels"]
    ):
        raise ValueError("invalid observed labels")
    return x["complete"], set(x["labels"])


def got(r, a):
    x = r.get(a, {})
    if a == "componentType":
        return (
            {x["prediction"]}
            if isinstance(x, dict) and isinstance(x.get("prediction"), str)
            else set()
        )
    return set(x.get("positiveLabels", []) if isinstance(x, dict) else [])


def score(ls, ps):
    vocab = vocabulary()
    out = {}
    for a in sum(AXES.values(), ()):
        exact = []
        partial = []
        per = defaultdict(lambda: [0, 0, 0])
        for r in ls:
            if a not in AXES[r["recordType"]]:
                continue
            x = obs(r, a)
            if not x:
                continue
            full, want = x
            have = got(ps[key(r)], a)
            if not full:
                if want:
                    partial.append((len(want & have), len(want)))
                continue
            exact.append(have == want)
            for label in want | have:
                per[label][0] += label in want and label in have
                per[label][1] += label in have and label not in want
                per[label][2] += label in want and label not in have
        tp = sum(v[0] for v in per.values())
        fp = sum(v[1] for v in per.values())
        fn = sum(v[2] for v in per.values())
        p = tp / (tp + fp) if tp + fp else None
        rec = tp / (tp + fn) if tp + fn else None
        f = lambda p, r: (
            2 * p * r / (p + r)
            if p is not None and r is not None and p + r
            else (0.0 if p == 0 and r == 0 else None)
        )
        labels = {}
        for k in vocab[a]:
            v = per[k]
            support = v[0] + v[2]
            precision = v[0] / (v[0] + v[1]) if v[0] + v[1] else None
            recall = v[0] / (v[0] + v[2]) if support else None
            labels[k] = {
                "support": support,
                "precision": precision,
                "recall": recall,
                "f1": 0.0 if support and v[0] == 0 else f(precision, recall),
            }
        supported = [v["f1"] for v in labels.values() if v["support"]]
        out[a] = {
            "completeExamples": len(exact),
            "exactSetAccuracy": sum(exact) / len(exact) if exact else None,
            "microPrecision": p,
            "microRecall": rec,
            "microF1": 0.0 if tp == 0 and (fp or fn) else f(p, rec),
            "macroF1": sum(supported) / len(supported) if supported else None,
            "perLabel": labels,
            "partialPositiveOnly": {
                "examples": len(partial),
                "labels": sum(b for a, b in partial),
                "recall": sum(a for a, b in partial) / sum(b for a, b in partial)
                if partial
                else None,
            },
        }
    return out


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--labels", type=Path, required=True)
    a.add_argument("--predictions", type=Path, required=True)
    a.add_argument("--output", type=Path, required=True)
    a.add_argument("--split", default="test", choices=("train", "validation", "test"))
    a.add_argument("--exclude-page-ids", type=Path)
    x = a.parse_args()
    excluded = (
        set(json.loads(x.exclude_page_ids.read_text()).get("overlapPageIds", []))
        if x.exclude_page_ids
        else set()
    )
    l = [
        r
        for r in rows(x.labels)
        if r.get("split") == x.split and r.get("pageId") not in excluded
    ]
    p = [
        r
        for r in rows(x.predictions)
        if r.get("split") == x.split and r.get("pageId") not in excluded
    ]
    idx = {key(r): r for r in p}
    if (
        len(idx) != len(p)
        or len({key(r) for r in l}) != len(l)
        or set(idx) != {key(r) for r in l}
    ):
        raise ValueError("labels and predictions must have exact unique identity joins")
    if any(r.get("source") != "luna" or r.get("gold") is not False for r in l):
        raise ValueError(
            "evaluation labels must be independent Luna silver, never gold"
        )
    x.output.write_text(
        json.dumps(
            {
                "split": x.split,
                "excludedPageIds": len(excluded),
                "records": len(l),
                "metrics": score(l, idx),
                "limits": [
                    "independent Luna silver, not human gold",
                    "incomplete axes contribute positive-only recall and never negatives",
                    "no threshold tuning",
                ],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()

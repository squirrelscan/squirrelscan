#!/usr/bin/env python3
"""Build the private blind consensus batch and deterministic join manifest.

The source packets are private. This utility never reads Jev targets while
selecting rows and emits bounded text/DOM inputs plus explicit incomplete
positive-only axes for the independent Luna pass.
"""
from __future__ import annotations
import hashlib, json
import os
from pathlib import Path

ROOT = Path(os.environ["DOM_CLASSIFIER_DATA_ROOT"]) / "2026-09-19"
SRC = ROOT / "dom-role-text-dataset-v1"
OUT = ROOT / "consensus-v1"

def rows(name):
    return [json.loads(x) for x in (SRC / name).read_text().splitlines() if x.strip()]

def choose(xs, n, split):
    ys = [x for x in xs if x.get("split") == split]
    return sorted(ys, key=lambda x: hashlib.sha256(f"consensus-v1|{split}|{x['pageId']}|{x.get('nodeId','page')}".encode()).hexdigest())[:n]

def capture_hashes():
    out = {}
    for p in (ROOT.parent / "2026-09-18/human-ui-v1/captures").glob("*.json"):
        d = json.loads(p.read_text())
        out[d["id"]] = d.get("captureHash")
    return out

def emit():
    if OUT.exists() and any(OUT.iterdir()):
        raise RuntimeError(f"refusing to overwrite existing private consensus output: {OUT}")
    OUT.mkdir(parents=True, exist_ok=True)
    # Train has DOM node packets; val/test are page packets held apart from
    # model-selection outputs. Jev softTargets are never read or copied.
    picks = [("train", choose(rows("node-train-weak.jsonl"), 40, "train")),
             ("validation", choose(rows("validation-provisional-diagnostic.jsonl"), 40, "validation")),
             ("test", choose(rows("test-provisional-diagnostic.jsonl"), 40, "test"))]
    captures = capture_hashes()
    all_rows = []
    for split, selected in picks:
        path = OUT / f"luna-{split}-blind.jsonl"
        with path.open("w") as f:
            for x in selected:
                r = {
                    "schemaVersion": 1, "recordType": x.get("recordType"),
                    "split": split, "pageId": x["pageId"],
                    "nodeId": x.get("nodeId"),
                    "captureHash": captures.get(x["pageId"]),
                    "snapshotHash": x.get("provenance", {}).get("snapshotHash"),
                    "input": x["input"],
                    "observedAxes": {
                        "componentType": {"complete": False, "labels": []},
                        "regions": {"complete": False, "labels": []},
                        "purposes": {"complete": False, "labels": []},
                        "pageTypes": {"complete": False, "labels": []},
                        "contentKinds": {"complete": False, "labels": []},
                    },
                    "label": "unknown", "source": "luna",
                    "model": "gpt-5.6-luna", "gold": False,
                    "promptVersion": "dom-role-consensus-v1",
                    "promptHash": "pending-independent-luna-pass",
                    "annotationStatus": "blind_queue_pending_label",
                }
                f.write(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n")
                all_rows.append(r)
    manifest = {
        "schemaVersion": 1, "batch": "consensus-v1", "selectionSeed": "consensus-v1",
        "counts": {"train": 40, "validation": 40, "test": 40},
        "testLabelsHeldSeparately": True, "teacherOutputsExcludedAtSelection": True,
        "source": str(SRC), "model": "gpt-5.6-luna", "gold": False,
        "promptVersion": "dom-role-consensus-v1", "status": "queue_pending_label",
        "joinKey": ["split", "pageId", "nodeId", "captureHash"],
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

if __name__ == "__main__": emit()

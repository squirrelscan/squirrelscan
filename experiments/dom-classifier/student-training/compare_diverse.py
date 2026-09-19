#!/usr/bin/env python3
"""Reproduce aggregate comparisons on immutable independent synthetic labels.

Prediction files are generated separately from frozen artifacts. This command
does not fit models, select checkpoints, or tune thresholds.
"""

import argparse
import hashlib
import json
from pathlib import Path

from evaluate_diverse import key, score
from evaluate_luna import tag_baseline


def rows(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def digest(path):
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def baseline_predictions(packets):
    result = []
    for row in packets:
        prediction = {
            field: row.get(field)
            for field in ("recordType", "pageId", "nodeId", "captureHash", "split")
        }
        baseline = tag_baseline(row)
        axes = (
            ("componentType", "regions", "purposes")
            if row["recordType"] == "node"
            else ("pageTypes", "contentKinds")
        )
        for axis in axes:
            prediction[axis] = (
                {"prediction": baseline[axis]}
                if axis == "componentType"
                else {"positiveLabels": sorted(baseline[axis])}
            )
        result.append(prediction)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--labels", type=Path, required=True)
    parser.add_argument("--packets", type=Path, required=True)
    parser.add_argument(
        "--prediction",
        action="append",
        required=True,
        help="name=/private/predictions.jsonl",
    )
    parser.add_argument("--teacher-records", action="append", type=Path, default=[])
    parser.add_argument("--prior-overlap", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("comparison artifact already exists")
    labels, packets = rows(args.labels), rows(args.packets)
    identities = {key(row) for row in packets}
    if (
        len(identities) != len(packets)
        or len({key(row) for row in labels}) != len(labels)
        or {key(row) for row in labels} != identities
    ):
        raise ValueError(
            "labels must exactly and uniquely cover the frozen blind packets"
        )
    packet_index = {key(row): row for row in packets}
    for label in labels:
        packet = packet_index[key(label)]
        if (
            label.get("source") != "luna"
            or label.get("gold") is not False
            or label.get("inputSha256") != packet["inputSha256"]
            or label.get("split") != packet["split"]
        ):
            raise ValueError("label provenance, split, or input hash mismatch")
    models = {"semantic_tag_baseline": baseline_predictions(packets)}
    hashes = {"labels": digest(args.labels), "packets": digest(args.packets)}
    if args.teacher_records:
        teacher = []
        for path in args.teacher_records:
            hashes[f"teacher:{path.name}"] = digest(path)
            for row in rows(path):
                if key(row) not in identities:
                    continue
                if row.get("source") != "jev" or row.get("gold") is not False:
                    raise ValueError(
                        "teacher comparison requires synthetic Jev records"
                    )
                packet = packet_index[key(row)]
                if any(
                    row.get(field) != packet.get(field)
                    for field in ("inputSha256", "input", "split", "taxonomyRevision")
                ):
                    raise ValueError(
                        "teacher input or split differs from frozen packet"
                    )
                if (
                    row.get("provenance", {}).get("promptRevision")
                    != "dom-suggestions-v4"
                ):
                    raise ValueError("teacher comparison requires Jev v4 provenance")
                prediction = {
                    field: row.get(field)
                    for field in (
                        "recordType",
                        "pageId",
                        "nodeId",
                        "captureHash",
                        "split",
                    )
                }
                for axis, target in row["softTargets"].items():
                    if axis == "componentType":
                        prediction[axis] = {
                            "prediction": max(
                                target["distribution"],
                                key=lambda item: item["probability"],
                            )["label"]
                        }
                    else:
                        prediction[axis] = {
                            "positiveLabels": sorted(
                                item["label"]
                                for item in target
                                if item["yesProbability"] >= 0.5
                            )
                        }
                teacher.append(prediction)
        models["jev_teacher"] = teacher
    for value in args.prediction:
        name, raw = value.split("=", 1)
        if name in models:
            raise ValueError("duplicate prediction name")
        path = Path(raw)
        models[name] = rows(path)
        hashes[name] = digest(path)
    overlap = set(json.loads(args.prior_overlap.read_text())["overlapPageIds"])
    results = {}
    for name, predictions in models.items():
        index = {key(row): row for row in predictions}
        if len(index) != len(predictions) or set(index) != identities:
            raise ValueError(f"{name} predictions do not exactly cover frozen packets")
        for identity, prediction in index.items():
            if prediction.get("split") != packet_index[identity]["split"]:
                raise ValueError(f"{name} prediction split mismatch")
        results[name] = {}
        for subset, selected in (
            ("test", [r for r in labels if r["split"] == "test"]),
            (
                "test_excluding_prior_training_domains",
                [
                    r
                    for r in labels
                    if r["split"] == "test" and r["pageId"] not in overlap
                ],
            ),
            ("validation", [r for r in labels if r["split"] == "validation"]),
        ):
            results[name][subset] = {
                "pages": len({r["pageId"] for r in selected}),
                "records": len(selected),
                "metrics": score(selected, index),
            }
    result = {
        "format": "squirrelscan-diverse-comparison-v1",
        "taxonomyRevision": "dom-taxonomy-v2",
        "inputHashes": hashes,
        "results": results,
        "limits": [
            "Agreement with independent Luna synthetic labels, not measured human accuracy.",
            "All 500 pages are inner pages from cloud-run sites; Product Hunt data remains separate.",
            "Domain and exact-content grouping do not guarantee unseen-template evaluation.",
            "Sparse support for rare labels and multilingual text limits conclusions.",
            "Exploratory comparison: the frozen-encoder alternative was added after inspecting sparse results and local fine-tuning runtime; test labels are excluded from fitting.",
            "Tag baseline has no page-type/content predictions; empty sets are explicit baseline outputs.",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()

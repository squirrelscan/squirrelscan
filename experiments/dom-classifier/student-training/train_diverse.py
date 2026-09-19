#!/usr/bin/env python3
"""Train the frozen sparse text/DOM student on a diverse synthetic snapshot.

The input JSONL is assembled separately from a frozen capture manifest and
Jev-v4 sidecars. It may contain only train-split Jev soft targets. Luna labels
are intentionally not accepted here: they are independent silver evaluation
records, not teacher targets.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

TAXONOMY_REVISION = "dom-taxonomy-v2"
JEV_MODEL = "jev-1.13.0"
JEV_PROMPT = "dom-suggestions-v4"
FROZEN_CONFIG = {
    "word": {"ngram_range": (1, 2), "min_df": 1, "max_features": 40_000, "sublinear_tf": True},
    "char": {"analyzer": "char_wb", "ngram_range": (3, 5), "min_df": 2, "max_features": 60_000, "sublinear_tf": True},
    "C": 2.0,
    "multilabelThreshold": 0.5,
    "randomState": 260919,
}


def load_student():
    path = Path(__file__).with_name("student.py")
    spec = importlib.util.spec_from_file_location("diverse_sparse_student", path)
    if not spec or not spec.loader:
        raise RuntimeError("cannot load sparse student")
    module = importlib.util.module_from_spec(spec)
    # Register the module before execution so joblib can resolve ConstantBinary
    # and other classes when the saved model is loaded in a later process.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def sha256_text(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode()).hexdigest()


def require_records_bound(manifest: dict[str, Any], manifest_path: Path, records_path: Path) -> None:
    entries = manifest.get("trainingFiles")
    if not isinstance(entries, list):
        raise ValueError("frozen manifest must list trainingFiles with hashes")
    matches = [entry for entry in entries if isinstance(entry, dict) and (manifest_path.parent / str(entry.get("path", ""))).resolve() == records_path.resolve()]
    if len(matches) != 1 or matches[0].get("sha256") != sha256(records_path):
        raise ValueError("training records file is not hash-bound in frozen manifest")


def validate_train_rows(rows: list[dict[str, Any]], manifest: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    entries = manifest.get("trainingRecords")
    if not isinstance(entries, list):
        raise ValueError("frozen manifest must list trainingRecords identities")
    expected = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("trainingRecords entries must be objects")
        kind, page_id, node_id, capture_hash, split, input_hash = (entry.get(key) for key in ("recordType", "pageId", "nodeId", "captureHash", "split", "inputSha256"))
        key = (kind, page_id, node_id, capture_hash)
        if kind not in {"node", "page"} or not isinstance(page_id, str) or not isinstance(capture_hash, str) or split not in {"train", "validation", "test"} or not isinstance(input_hash, str) or key in expected:
            raise ValueError("trainingRecords contains an invalid or duplicate identity")
        expected[key] = entry
    if not rows:
        raise ValueError("training records are empty")
    nodes: list[dict[str, Any]] = []
    pages: list[dict[str, Any]] = []
    keys: set[tuple[str, str, str | None, str]] = set()
    for row in rows:
        if row.get("split") != "train" or row.get("source") != "jev" or row.get("gold") is not False:
            raise ValueError("training records must be train-split Jev synthetic rows")
        if row.get("taxonomyRevision") != TAXONOMY_REVISION:
            raise ValueError("training record has an unexpected taxonomy revision")
        if not isinstance(row.get("input"), str) or not row["input"]:
            raise ValueError("training record lacks serialized text/DOM input")
        if not isinstance(row.get("softTargets"), dict) or not row["softTargets"]:
            raise ValueError("training record lacks Jev soft targets")
        teacher = row.get("teacherIdentity")
        if (
            not isinstance(teacher, dict)
            or not isinstance(teacher.get("id"), str)
            or teacher.get("modelId") != JEV_MODEL
            or teacher.get("modelRevision") != JEV_MODEL
            or teacher.get("promptRevision") != JEV_PROMPT
            or not isinstance(teacher.get("snapshotHash"), str)
        ):
            raise ValueError("training record lacks complete Jev-v4 teacher provenance")
        kind, page_id, node_id, capture_hash = row.get("recordType"), row.get("pageId"), row.get("nodeId"), row.get("captureHash")
        if kind not in {"node", "page"} or not isinstance(page_id, str) or not isinstance(capture_hash, str):
            raise ValueError("training record lacks stable identity")
        if kind == "node" and not isinstance(node_id, str):
            raise ValueError("node training record lacks nodeId")
        if kind == "page" and node_id is not None:
            raise ValueError("page training record must not have nodeId")
        key = (kind, page_id, node_id, capture_hash)
        if key in keys:
            raise ValueError("duplicate training record identity")
        if key not in expected or expected[key]["split"] != "train" or expected[key]["inputSha256"] != sha256_text(row["input"]):
            raise ValueError("training record is absent, wrong-split, stale, or input-unbound in frozen manifest")
        keys.add(key)
        (nodes if kind == "node" else pages).append(row)
    if not nodes or not pages:
        raise ValueError("training needs both node and page records")
    return nodes, pages


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--records", type=Path, required=True, help="manifest-bound train-only Jev JSONL")
    parser.add_argument("--manifest", type=Path, required=True, help="frozen diverse capture manifest")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("output already exists; frozen model artifacts are immutable")
    manifest = json.loads(args.manifest.read_text())
    if manifest.get("taxonomyRevision") != TAXONOMY_REVISION:
        raise ValueError("frozen manifest taxonomy revision is not dom-taxonomy-v2")
    require_records_bound(manifest, args.manifest, args.records)
    nodes, pages = validate_train_rows(read_jsonl(args.records), manifest)
    student = load_student()
    student.CONFIG = FROZEN_CONFIG
    model = student.train(nodes, pages)
    args.output.mkdir(parents=True, mode=0o700)
    model_path = args.output / "student.joblib"
    student.joblib.dump(model, model_path)
    metadata = {
        "format": "squirrelscan-diverse-sparse-student-v1",
        "taxonomyRevision": TAXONOMY_REVISION,
        "manifestSha256": sha256(args.manifest),
        "trainingRecordsSha256": sha256(args.records),
        "trainingRows": {"nodes": len(nodes), "pages": len(pages)},
        "featurePolicy": "only supplied sanitized text/DOM serializers; no screenshots, geometry, URLs, or selectors",
        "supervision": "Jev-v4 synthetic soft targets; missing axes excluded rather than negative; Luna is excluded from training",
        "frozenConfig": FROZEN_CONFIG,
        "runTimestampUtc": datetime.now(timezone.utc).isoformat(),
        "artifactSha256": sha256(model_path),
        "testAccessed": False,
    }
    (args.output / "metadata.json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"artifactSha256": metadata["artifactSha256"], "pages": len(pages), "nodes": len(nodes)}, sort_keys=True))


if __name__ == "__main__":
    main()

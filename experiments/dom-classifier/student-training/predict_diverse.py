#!/usr/bin/env python3
"""Run a saved sparse student on supplied text/DOM records only."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import joblib


STUDENT_MODULE = "diverse_sparse_student"


def load_student_module() -> Any:
    path = Path(__file__).with_name("student.py")
    spec = importlib.util.spec_from_file_location(STUDENT_MODULE, path)
    if not spec or not spec.loader:
        raise RuntimeError("cannot load sparse student compatibility module")
    module = importlib.util.module_from_spec(spec)
    sys.modules[STUDENT_MODULE] = module
    # Older artifacts created while student.py was executed directly pickle
    # ConstantBinary under __main__.  Point that name at the real class before
    # loading, while retaining the stable module name used by new artifacts.
    spec.loader.exec_module(module)
    sys.modules.setdefault("student", module)
    setattr(sys.modules[__name__], "ConstantBinary", module.ConstantBinary)
    setattr(sys.modules["__main__"], "ConstantBinary", module.ConstantBinary)
    return module


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def validate_rows(rows: list[dict[str, Any]]) -> None:
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("input"), str) or not row["input"]:
            raise ValueError("prediction record needs supplied text/DOM input")
        kind = row.get("recordType")
        if kind not in {"node", "page"} or not isinstance(row.get("pageId"), str) or not isinstance(row.get("captureHash"), str):
            raise ValueError("prediction record identity is invalid")
        if kind == "node" and not isinstance(row.get("nodeId"), str):
            raise ValueError("node prediction record needs nodeId")
        if kind == "page" and row.get("nodeId") is not None:
            raise ValueError("page prediction record must not have nodeId")


def sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True, help="saved student.joblib")
    parser.add_argument("--records", type=Path, required=True, help="JSONL text/DOM records")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("prediction output already exists")
    rows = read_jsonl(args.records)
    validate_rows(rows)
    module = load_student_module()
    metadata_path = args.model.with_name("metadata.json")
    if metadata_path.exists():
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        expected = metadata.get("artifactSha256")
        if isinstance(expected, str) and len(expected) == 64:
            expected = "sha256:" + expected
        if expected and expected != sha256(args.model):
            raise ValueError("student artifact hash does not match metadata")
    model = joblib.load(args.model)
    if not isinstance(model, dict) or model.get("format") != "squirrelscan-sparse-student-v1":
        raise ValueError("unsupported sparse student artifact")
    predictions = module.predict(model, rows)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in predictions), encoding="utf-8")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Local-only inference for a manifest-bound pretrained student artifact."""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
from typing import Any

import torch
from transformers import AutoTokenizer

MODULE = Path(__file__).with_name("trainer.py")
SPEC = importlib.util.spec_from_file_location("pretrained_student_trainer", MODULE)
trainer = importlib.util.module_from_spec(SPEC)
import sys
sys.modules[SPEC.name] = trainer
SPEC.loader.exec_module(trainer)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return trainer.read_jsonl(path)


def validate_prediction_rows(rows: list[dict[str, Any]]) -> None:
    for row in rows:
        if not isinstance(row.get("input"), str) or not row["input"]:
            raise ValueError("prediction record needs sanitized input")
        if row.get("recordType") not in {"node", "page"} or not isinstance(row.get("pageId"), str) or not isinstance(row.get("captureHash"), str):
            raise ValueError("prediction record identity is invalid")
        if row["recordType"] == "node" and not isinstance(row.get("nodeId"), str):
            raise ValueError("node prediction record needs nodeId")
        if row["recordType"] == "page" and row.get("nodeId") is not None:
            raise ValueError("page prediction record must not have nodeId")


def prediction_rows(model: Any, tokenizer: Any, rows: list[dict[str, Any]], specs: tuple[Any, ...], device: torch.device) -> list[dict[str, Any]]:
    if len(rows) > trainer.FROZEN_HYPERPARAMETERS["batchSize"]:
        size = trainer.FROZEN_HYPERPARAMETERS["batchSize"]
        return [item for start in range(0, len(rows), size) for item in prediction_rows(model, tokenizer, rows[start:start + size], specs, device)]
    if not rows:
        return []
    model.eval()
    tokens = tokenizer([row["input"] for row in rows], truncation=True, max_length=trainer.FROZEN_HYPERPARAMETERS["maxLength"], padding="max_length", return_tensors="pt")
    with torch.no_grad():
        logits = model(tokens["input_ids"].to(device), tokens["attention_mask"].to(device))
    result = []
    for index, row in enumerate(rows):
        item = {key: row.get(key) for key in ("recordType", "pageId", "nodeId", "captureHash", "split")}
        for spec in specs:
            if spec.axis not in (trainer.NODE_AXES if row["recordType"] == "node" else trainer.PAGE_AXES):
                continue
            values = logits[spec.axis][index]
            if spec.multi_label:
                probabilities = {label: float(value) for label, value in zip(spec.labels, torch.sigmoid(values).cpu())}
                item[spec.axis] = {"probabilities": probabilities, "positiveLabels": [label for label, value in probabilities.items() if value >= 0.5]}
            else:
                probabilities = {label: float(value) for label, value in zip(spec.labels, torch.softmax(values, dim=0).cpu())}
                item[spec.axis] = {"probabilities": probabilities, "prediction": max(probabilities, key=probabilities.get)}
        result.append(item)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--records", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", default="auto", choices=("auto", "cpu", "mps"))
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("prediction output already exists")
    metadata = json.loads((args.artifact / "metadata.json").read_text(encoding="utf-8"))
    if metadata.get("taxonomyRevision") != trainer.TAXONOMY_REVISION or metadata.get("promptRevision") != trainer.PROMPT_REVISION:
        raise ValueError("artifact taxonomy or prompt revision is incompatible")
    specs = tuple(trainer.HeadSpec(item["axis"], tuple(item["labels"]), bool(item["multiLabel"])) for item in metadata.get("heads", []))
    expected = {"componentType", *trainer.MULTI_AXES}
    if {spec.axis for spec in specs} != expected:
        raise ValueError("artifact has an invalid set of heads")
    taxonomy = trainer.taxonomy()
    for spec in specs:
        if tuple(spec.labels) != taxonomy[spec.axis] or spec.multi_label != (spec.axis in trainer.MULTI_AXES):
            raise ValueError("artifact head vocabulary or mode is incompatible")
    device = trainer.device_for(args.device)
    model = trainer.PretrainedStudent(specs, str(args.cache_dir)).to(device)
    model.load_state_dict(torch.load(args.artifact / "model.pt", map_location=device))
    rows = read_jsonl(args.records)
    validate_prediction_rows(rows)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in prediction_rows(model, AutoTokenizer.from_pretrained(trainer.MODEL_ID, revision=trainer.MODEL_REVISION, cache_dir=str(args.cache_dir), local_files_only=True), rows, specs, device)), encoding="utf-8")


if __name__ == "__main__":
    main()

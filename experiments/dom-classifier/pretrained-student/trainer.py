#!/usr/bin/env python3
"""Manifest-bound RoBERTa fine-tuning for Jev-v4 synthetic DOM records.

Training reads only explicitly supplied train and validation JSONL files. Test
records are never opened here; evaluate a frozen artifact in a separate run.
Inputs are already-sanitized text/DOM serializations, never screenshots,
geometry, URLs, selectors, human labels, or Luna evaluation records.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import time
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional, Tuple

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader
from transformers import AutoModel, AutoTokenizer

MODEL_ID = "FacebookAI/roberta-base"
MODEL_REVISION = "e2da8e2f811d1448a5b465c236feacd80ffbac7b"  # pragma: allowlist secret
TAXONOMY_REVISION = "dom-taxonomy-v2"
PROMPT_REVISION = "dom-suggestions-v4"
FROZEN_HYPERPARAMETERS = {
    "epochs": 3,
    "maxLength": 192,
    "batchSize": 8,
    "learningRate": 2e-5,
    "weightDecay": 0.01,
    "seed": 260919,
}
MULTI_AXES = ("regions", "purposes", "pageTypes", "contentKinds")
NODE_AXES = ("componentType", "regions", "purposes")
PAGE_AXES = ("pageTypes", "contentKinds")


def sha256_file(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def sha256_text(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode()).hexdigest()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    try:
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    except json.JSONDecodeError as error:
        raise ValueError(f"invalid JSONL in {path}") from error


def taxonomy() -> dict[str, tuple[str, ...]]:
    path = Path(__file__).resolve().parents[1] / "taxonomy.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("taxonomyRevision") != TAXONOMY_REVISION:
        raise ValueError("taxonomy revision does not match pretrained student contract")
    labels = value.get("allowedLabels")
    if not isinstance(labels, dict):
        raise ValueError("taxonomy has no allowedLabels")
    result = {
        "componentType": tuple(labels.get("componentTypes", [])),
        "regions": tuple(labels.get("regions", [])),
        "purposes": tuple(labels.get("purposes", [])),
        "pageTypes": tuple(labels.get("pageTypes", [])),
        "contentKinds": tuple(labels.get("contentKinds", [])),
    }
    if any(not values or len(set(values)) != len(values) for values in result.values()):
        raise ValueError("taxonomy has an invalid head vocabulary")
    return result


RecordKey = Tuple[str, str, Optional[str], str]


def record_key(row: dict[str, Any]) -> RecordKey:
    return (str(row.get("recordType")), str(row.get("pageId")), row.get("nodeId"), str(row.get("captureHash")))


def manifest_entries(manifest: dict[str, Any]) -> dict[RecordKey, dict[str, Any]]:
    if manifest.get("taxonomyRevision") != TAXONOMY_REVISION:
        raise ValueError("manifest taxonomyRevision must be dom-taxonomy-v2")
    raw = manifest.get("trainingRecords")
    if not isinstance(raw, list):
        raise ValueError("manifest.trainingRecords must be an array")
    entries: dict[RecordKey, dict[str, Any]] = {}
    for entry in raw:
        if not isinstance(entry, dict):
            raise ValueError("manifest training record is invalid")
        kind, page_id, node_id, capture_hash, split, input_hash = (
            entry.get("recordType"), entry.get("pageId"), entry.get("nodeId"), entry.get("captureHash"), entry.get("split"), entry.get("inputSha256"),
        )
        if (
            kind not in {"node", "page"}
            or not isinstance(page_id, str)
            or not isinstance(capture_hash, str)
            or split not in {"train", "validation", "test"}
            or not isinstance(input_hash, str)
            or (kind == "node" and not isinstance(node_id, str))
            or (kind == "page" and node_id is not None)
        ):
            raise ValueError("manifest training identity is invalid")
        key = (kind, page_id, node_id, capture_hash)
        if key in entries:
            raise ValueError("manifest training identity is duplicated")
        entries[key] = entry
    return entries


def require_file_bound(manifest: dict[str, Any], manifest_path: Path, path: Path) -> None:
    files = manifest.get("trainingFiles")
    if not isinstance(files, list):
        raise ValueError("manifest.trainingFiles must be an array")
    matches = [
        entry for entry in files
        if isinstance(entry, dict)
        and (manifest_path.parent / str(entry.get("path", ""))).resolve() == path.resolve()
    ]
    if len(matches) != 1 or matches[0].get("sha256") != sha256_file(path):
        raise ValueError(f"{path.name} is not hash-bound in manifest.trainingFiles")


def validate_rows(rows: list[dict[str, Any]], entries: dict[RecordKey, dict[str, Any]], split: str, labels: dict[str, tuple[str, ...]]) -> list[dict[str, Any]]:
    if not rows:
        raise ValueError(f"{split} records are empty")
    seen: set[RecordKey] = set()
    for row in rows:
        if not isinstance(row, dict) or row.get("split") != split:
            raise ValueError(f"record is not in the requested {split} split")
        if row.get("source") != "jev" or row.get("gold") is not False:
            raise ValueError("pretrained training accepts Jev synthetic records only")
        if row.get("taxonomyRevision") != TAXONOMY_REVISION:
            raise ValueError("record taxonomy revision is invalid")
        if not isinstance(row.get("input"), str) or not row["input"]:
            raise ValueError("record input is required")
        if not isinstance(row.get("softTargets"), dict):
            raise ValueError("record softTargets are required")
        provenance = row.get("provenance")
        if not isinstance(provenance, dict) or provenance.get("promptRevision") != PROMPT_REVISION:
            raise ValueError("record must record Jev v4 prompt provenance")
        key = record_key(row)
        if key in seen or key not in entries:
            raise ValueError("record identity is duplicate or absent from manifest")
        expected = entries[key]
        if expected.get("split") != split or expected.get("inputSha256") != sha256_text(row["input"]):
            raise ValueError("record split or input hash does not match manifest")
        if row["recordType"] not in {"node", "page"}:
            raise ValueError("record type is invalid")
        if row["recordType"] == "node" and not isinstance(row.get("nodeId"), str):
            raise ValueError("node record has no nodeId")
        if row["recordType"] == "page" and row.get("nodeId") is not None:
            raise ValueError("page record has a nodeId")
        validate_targets(row, labels)
        seen.add(key)
    return rows


def validate_probability(value: Any) -> float:
    if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 or value > 1:
        raise ValueError("soft target probability must be between zero and one")
    return float(value)


def validate_targets(row: dict[str, Any], labels: dict[str, tuple[str, ...]]) -> None:
    targets = row["softTargets"]
    applicable = NODE_AXES if row["recordType"] == "node" else PAGE_AXES
    if any(axis not in applicable for axis in targets):
        raise ValueError("record has a target axis that is inapplicable to its recordType")
    if not targets:
        raise ValueError("record has no Jev soft targets")
    for axis in MULTI_AXES:
        if axis not in targets:
            continue
        values = targets[axis]
        if not isinstance(values, list):
            raise ValueError(f"{axis} soft target must be an array")
        observed: set[str] = set()
        for item in values:
            if not isinstance(item, dict) or item.get("label") not in labels[axis] or item.get("label") in observed:
                raise ValueError(f"{axis} soft target label is invalid")
            validate_probability(item.get("yesProbability"))
            observed.add(item["label"])
    if "componentType" in targets:
        value = targets["componentType"]
        distribution = value.get("distribution") if isinstance(value, dict) else None
        if not isinstance(distribution, list) or not distribution:
            raise ValueError("componentType needs a non-empty distribution")
        observed: set[str] = set()
        total = 0.0
        for item in distribution:
            if not isinstance(item, dict) or item.get("label") not in labels["componentType"] or item.get("label") in observed:
                raise ValueError("componentType label is invalid")
            total += validate_probability(item.get("probability"))
            observed.add(item["label"])
        if abs(total - 1.0) > 0.011:
            raise ValueError("componentType probabilities must sum to one")


@dataclass(frozen=True)
class HeadSpec:
    axis: str
    labels: tuple[str, ...]
    multi_label: bool


class PretrainedStudent(nn.Module):
    def __init__(self, heads: Iterable[HeadSpec], cache_dir: str) -> None:
        super().__init__()
        self.encoder = AutoModel.from_pretrained(MODEL_ID, revision=MODEL_REVISION, cache_dir=cache_dir, local_files_only=True)
        self.encoder.gradient_checkpointing_enable()
        self.specs = tuple(heads)
        hidden = int(self.encoder.config.hidden_size)
        self.heads = nn.ModuleDict({spec.axis: nn.Linear(hidden, len(spec.labels)) for spec in self.specs})

    def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor) -> dict[str, torch.Tensor]:
        encoded = self.encoder(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state[:, 0, :]
        return {axis: head(encoded) for axis, head in self.heads.items()}


def build_targets(rows: list[dict[str, Any]], specs: tuple[HeadSpec, ...]) -> dict[str, torch.Tensor]:
    result: dict[str, torch.Tensor] = {}
    for spec in specs:
        if spec.multi_label:
            values = torch.full((len(rows), len(spec.labels)), -1.0)
            index = {label: position for position, label in enumerate(spec.labels)}
            for row_index, row in enumerate(rows):
                for item in row["softTargets"].get(spec.axis, []):
                    values[row_index, index[item["label"]]] = float(item["yesProbability"])
        else:
            values = torch.full((len(rows), len(spec.labels)), -1.0)
            index = {label: position for position, label in enumerate(spec.labels)}
            for row_index, row in enumerate(rows):
                target = row["softTargets"].get("componentType")
                if target:
                    values[row_index].zero_()
                    for item in target["distribution"]:
                        values[row_index, index[item["label"]]] = float(item["probability"])
        result[spec.axis] = values
    return result


def collate(tokenizer: Any, rows: list[dict[str, Any]]) -> dict[str, Any]:
    tokens = tokenizer([row["input"] for row in rows], truncation=True, max_length=FROZEN_HYPERPARAMETERS["maxLength"], padding="max_length", return_tensors="pt")
    return {"input_ids": tokens["input_ids"], "attention_mask": tokens["attention_mask"], "rows": rows}


def masked_loss(logits: dict[str, torch.Tensor], targets: dict[str, torch.Tensor], specs: tuple[HeadSpec, ...], device: torch.device) -> torch.Tensor:
    losses: list[torch.Tensor] = []
    for spec in specs:
        source = targets[spec.axis]
        if not source.ge(0).any():
            continue
        target = source.to(device)
        observed = target.ge(0)
        if spec.multi_label:
            # Fixed shapes avoid one MPS graph/cache allocation per mask size.
            element_loss = nn.functional.binary_cross_entropy_with_logits(logits[spec.axis], target.clamp_min(0), reduction="none")
            losses.append((element_loss * observed).sum() / observed.sum().clamp_min(1))
        else:
            row_mask = observed.any(dim=1)
            per_row = -(target.clamp_min(0) * torch.log_softmax(logits[spec.axis], dim=1)).sum(dim=1)
            losses.append((per_row * row_mask).sum() / row_mask.sum().clamp_min(1))
    if not losses:
        raise ValueError("batch has no observed Jev target axes")
    return torch.stack(losses).mean()


def average_loss(model: PretrainedStudent, loader: DataLoader, specs: tuple[HeadSpec, ...], device: torch.device) -> float:
    model.eval()
    losses: list[float] = []
    with torch.no_grad():
        for batch in loader:
            logits = model(batch["input_ids"].to(device), batch["attention_mask"].to(device))
            losses.append(float(masked_loss(logits, build_targets(batch["rows"], specs), specs, device).cpu()))
    return sum(losses) / len(losses)


def device_for(value: str) -> torch.device:
    if value == "auto":
        return torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    return torch.device(value)


def train(train_rows: list[dict[str, Any]], validation_rows: list[dict[str, Any]], cache_dir: str, device: torch.device) -> tuple[PretrainedStudent, tuple[HeadSpec, ...], list[float]]:
    labels = taxonomy()
    specs = tuple(HeadSpec(axis, labels[axis], axis in MULTI_AXES) for axis in ("componentType", *MULTI_AXES))
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, revision=MODEL_REVISION, cache_dir=cache_dir, local_files_only=True)
    train_loader = DataLoader(train_rows, batch_size=FROZEN_HYPERPARAMETERS["batchSize"], shuffle=True, collate_fn=lambda batch: collate(tokenizer, batch))
    validation_loader = DataLoader(validation_rows, batch_size=FROZEN_HYPERPARAMETERS["batchSize"], shuffle=False, collate_fn=lambda batch: collate(tokenizer, batch))
    model = PretrainedStudent(specs, cache_dir).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=FROZEN_HYPERPARAMETERS["learningRate"], weight_decay=FROZEN_HYPERPARAMETERS["weightDecay"])
    losses: list[float] = []
    for _epoch in range(FROZEN_HYPERPARAMETERS["epochs"]):
        model.train()
        for batch_number, batch in enumerate(train_loader, 1):
            optimizer.zero_grad(set_to_none=True)
            logits = model(batch["input_ids"].to(device), batch["attention_mask"].to(device))
            loss = masked_loss(logits, build_targets(batch["rows"], specs), specs, device)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            if batch_number % 25 == 0:
                if device.type == "mps":
                    torch.mps.empty_cache()
                print(json.dumps({"epoch": _epoch + 1, "batch": batch_number, "batches": len(train_loader)}), flush=True)
        validation = average_loss(model, validation_loader, specs, device)
        losses.append(validation)
        print(json.dumps({"epoch": _epoch + 1, "validationLoss": validation}), flush=True)
    return model, specs, losses


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--train-records", type=Path, required=True)
    parser.add_argument("--validation-records", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", default="auto", choices=("auto", "cpu", "mps"))
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("output already exists; model artifacts are immutable")
    random.seed(FROZEN_HYPERPARAMETERS["seed"])
    np.random.seed(FROZEN_HYPERPARAMETERS["seed"])
    torch.manual_seed(FROZEN_HYPERPARAMETERS["seed"])
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    entries = manifest_entries(manifest)
    require_file_bound(manifest, args.manifest, args.train_records)
    require_file_bound(manifest, args.manifest, args.validation_records)
    labels = taxonomy()
    train_rows = validate_rows(read_jsonl(args.train_records), entries, "train", labels)
    validation_rows = validate_rows(read_jsonl(args.validation_records), entries, "validation", labels)
    device = device_for(args.device)
    started = time.perf_counter()
    model, specs, validation_losses = train(train_rows, validation_rows, str(args.cache_dir), device)
    fit_seconds = time.perf_counter() - started
    args.output.mkdir(parents=True, mode=0o700)
    model_path = args.output / "model.pt"
    torch.save(model.state_dict(), model_path)
    metadata = {
        "format": "squirrelscan-pretrained-student-v1",
        "encoder": {"modelId": MODEL_ID, "revision": MODEL_REVISION, "fineTuned": True},
        "taxonomyRevision": TAXONOMY_REVISION,
        "promptRevision": PROMPT_REVISION,
        "heads": [{"axis": spec.axis, "labels": list(spec.labels), "multiLabel": spec.multi_label} for spec in specs],
        "hyperparameters": FROZEN_HYPERPARAMETERS,
        "device": str(device),
        "runtimeSettings": {"padding": "fixed_192", "maskedLoss": "fixed_shape", "gradientCheckpointing": True, "mpsCacheClearInterval": 25},
        "fitSeconds": fit_seconds,
        "modelBytes": model_path.stat().st_size,
        "manifestSha256": sha256_file(args.manifest),
        "trainingFiles": {"train": sha256_file(args.train_records), "validation": sha256_file(args.validation_records)},
        "trainingRows": {"train": len(train_rows), "validation": len(validation_rows)},
        "validationLossByEpoch": validation_losses,
        "checkpointPolicy": "fixed_final_epoch",
        "selectedEpoch": FROZEN_HYPERPARAMETERS["epochs"],
        "testAccessed": False,
        "inputPolicy": "sanitized supplied text/DOM only; no screenshots, geometry, URLs, selectors, human labels, or Luna records",
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    metadata_path = args.output / "metadata.json"
    metadata_path.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(model_path, 0o600)
    os.chmod(metadata_path, 0o600)
    print(json.dumps({"output": str(args.output), "validationLoss": validation_losses[-1], "testAccessed": False}, sort_keys=True))


if __name__ == "__main__":
    main()

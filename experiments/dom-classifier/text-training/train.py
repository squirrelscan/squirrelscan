"""Run the bounded frozen-encoder text/DOM probe.

The legacy v2 route is deliberately one single-role silver task.  It is kept
separate from the modern partial-label axes so a legacy role is never invented
from missing modern labels or used to flatten them.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import random
import time
from typing import Any, Iterable

import numpy as np
import torch
from sklearn.metrics import accuracy_score, f1_score
from torch.utils.data import DataLoader, TensorDataset
from transformers import AutoTokenizer

from model import HeadSpec, MODEL_ID, MODEL_REVISION, MultiAxisTextProbe
from data import SERIALIZER_VERSION, TAXONOMY, TextExample, load_v2, serializer_hash


def select_device(value: str) -> torch.device:
    if value != "auto":
        return torch.device(value)
    return torch.device("mps" if torch.backends.mps.is_available() else "cpu")


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def batches(records: list[TextExample], tokenizer: Any, label_to_id: dict[str, int], batch_size: int) -> DataLoader:
    examples = []
    for record in records:
        if len(record.labels) != 1:
            raise ValueError("legacy probe requires exactly one explicit silver role")
        tokenized = tokenizer(record.input_text, truncation=True, max_length=128)
        examples.append({"input_ids": tokenized["input_ids"], "attention_mask": tokenized["attention_mask"], "legacyRole": label_to_id[record.labels[0]]})
    def collate(rows: list[dict[str, Any]]) -> dict[str, torch.Tensor]:
        padded = tokenizer.pad({key: [row[key] for row in rows] for key in ("input_ids", "attention_mask")}, return_tensors="pt")
        padded["legacyRole"] = torch.tensor([row["legacyRole"] for row in rows], dtype=torch.long)
        return padded
    return DataLoader(examples, batch_size=batch_size, shuffle=False, collate_fn=collate)


@torch.no_grad()
def cache_embeddings(model: MultiAxisTextProbe, loader: DataLoader, device: torch.device) -> tuple[torch.Tensor, torch.Tensor]:
    """Encode each frozen split exactly once before fitting the small head."""
    model.eval()
    embeddings: list[torch.Tensor] = []
    labels: list[torch.Tensor] = []
    for batch in loader:
        embeddings.append(model.encode(batch["input_ids"].to(device), batch["attention_mask"].to(device)).cpu())
        labels.append(batch["legacyRole"])
    return torch.cat(embeddings), torch.cat(labels)


@torch.no_grad()
def evaluate_head(head: torch.nn.Module, embeddings: torch.Tensor, labels: torch.Tensor, device: torch.device) -> dict[str, Any]:
    head.eval()
    expected: list[int] = []
    predicted: list[int] = []
    for vector, target in DataLoader(TensorDataset(embeddings, labels), batch_size=64):
        logits = head(vector.to(device))
        expected.extend(target.tolist())
        predicted.extend(logits.argmax(dim=1).cpu().tolist())
    class_support = {TAXONOMY[index]: expected.count(index) for index in range(len(TAXONOMY))}
    return {
        "support": len(expected),
        "accuracy": float(accuracy_score(expected, predicted)),
        "observedClassMacroF1": float(f1_score(expected, predicted, average="macro", zero_division=0)),
        "all10MacroF1": float(f1_score(expected, predicted, labels=list(range(len(TAXONOMY))), average="macro", zero_division=0)),
        "classSupport": class_support,
    }


@torch.no_grad()
def write_predictions(output: Path, records_by_split: dict[str, list[TextExample]], embeddings: dict[str, tuple[torch.Tensor, torch.Tensor]], head: torch.nn.Module, labels: tuple[str, ...], device: torch.device) -> None:
    """Private diagnostics; candidate IDs never enter model serialization."""
    lines: list[str] = []
    head.eval()
    for split, records in records_by_split.items():
        vectors, targets = embeddings[split]
        probabilities = torch.softmax(head(vectors.to(device)), dim=1).cpu()
        for record, target, probability in zip(records, targets.tolist(), probabilities.tolist()):
            lines.append(json.dumps({"candidateId": record.candidate_id, "split": split, "label": labels[target], "prediction": labels[int(np.argmax(probability))], "labelOrder": list(labels), "probabilities": probability}, sort_keys=True))
    (output / "predictions.jsonl").write_text("\n".join(lines) + "\n")


def train(records_by_split: dict[str, list[TextExample]], output: Path, *, device: torch.device, epochs: int, batch_size: int, cache_dir: str | None, provenance: dict[str, Any]) -> dict[str, Any]:
    observed_train = {record.labels[0] for record in records_by_split["train"] if len(record.labels) == 1}
    if len(observed_train) < 2:
        raise ValueError("legacy silver train split needs at least two observed classes")
    labels = TAXONOMY
    label_to_id = {value: index for index, value in enumerate(labels)}
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, revision=MODEL_REVISION, cache_dir=cache_dir)
    loaders = {name: batches(records, tokenizer, label_to_id, batch_size) for name, records in records_by_split.items()}
    model = MultiAxisTextProbe((HeadSpec("legacyRole", labels),), cache_dir=cache_dir).to(device)
    encoded = {name: cache_embeddings(model, loader, device) for name, loader in loaders.items()}
    optimizer = torch.optim.AdamW(model.heads.parameters(), lr=1e-3, weight_decay=0.01)
    best_state: dict[str, torch.Tensor] | None = None
    best_validation = float("-inf")
    for _ in range(epochs):
        model.heads.train()
        train_vectors, train_labels = encoded["train"]
        for vector, target in DataLoader(TensorDataset(train_vectors, train_labels), batch_size=batch_size, shuffle=True):
            optimizer.zero_grad()
            logits = {"legacyRole": model.heads["legacyRole"](vector.to(device))}
            loss, _ = model.masked_loss(logits, {"legacyRole": target.to(device)})
            loss.backward()
            optimizer.step()
        validation = evaluate_head(model.heads["legacyRole"], *encoded["validation"], device)["observedClassMacroF1"]
        if validation > best_validation:
            best_validation = float(validation)
            best_state = {name: value.detach().cpu().clone() for name, value in model.heads["legacyRole"].state_dict().items()}
    assert best_state is not None
    model.heads["legacyRole"].load_state_dict(best_state)
    model.save_probe(output / "probe")
    config_path = output / "probe" / "probe-config.json"
    probe_config = json.loads(config_path.read_text())
    probe_config["training"] = provenance
    config_path.write_text(json.dumps(probe_config, indent=2, sort_keys=True) + "\n")
    # A reload test is part of the actual run, preventing a non-portable head artifact.
    reloaded = MultiAxisTextProbe.load_probe(output / "probe", cache_dir=cache_dir).to(device)
    before = model.heads["legacyRole"](encoded["test"][0].to(device))
    after = reloaded.heads["legacyRole"](encoded["test"][0].to(device))
    if not torch.equal(before, after):
        raise RuntimeError("reloaded probe head changed predictions")
    write_predictions(output, records_by_split, encoded, reloaded.heads["legacyRole"], labels, device)
    result = {
        "kind": "frozen-encoder-trained-head probe",
        "encoder": {"modelId": MODEL_ID, "revision": MODEL_REVISION, "frozen": True, "maxLength": 128},
        "task": "legacy single-role silver classification; separate from modern multi-axis labels",
        "notHumanAccuracy": True,
        "splitNote": "reused frozen v2 holdout; it is not pristine because an earlier structural baseline evaluated it",
        "splits": {name: evaluate_head(reloaded.heads["legacyRole"], *encoded[name], device) for name in loaders},
        "labels": list(labels),
        "observedTrainLabels": sorted(observed_train),
        "epochs": epochs,
        "batchSize": batch_size,
        "device": str(device),
        "provenance": provenance,
    }
    (output / "metrics.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--v2-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache-dir")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--epochs", type=int, default=40, help="fixed before the holdout run; validation selects only epoch")
    parser.add_argument("--batch-size", type=int, default=4)
    args = parser.parse_args()
    random.seed(2307); np.random.seed(2307); torch.manual_seed(2307)
    records = {name: list(rows) for name, rows in load_v2(args.v2_root).splits.items()}
    if args.output.exists() and any(args.output.iterdir()):
        raise ValueError(f"refusing to overwrite existing output: {args.output}")
    args.output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    provenance = {
        "seed": 2307,
        "serializerVersion": SERIALIZER_VERSION,
        "serializerHash": serializer_hash(),
        "sourceFiles": {
            "candidates": file_sha256(args.v2_root / "candidates.jsonl"),
            "annotations": file_sha256(args.v2_root / "labels" / "annotations.jsonl"),
            "frozenSplitManifest": file_sha256(args.v2_root / "training" / "split-manifest.json"),
        },
    }
    result = train(records, args.output, device=select_device(args.device), epochs=args.epochs, batch_size=args.batch_size, cache_dir=args.cache_dir, provenance=provenance)
    result["elapsedSeconds"] = round(time.monotonic() - started, 3)
    (args.output / "metrics.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()

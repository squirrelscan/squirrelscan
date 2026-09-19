#!/usr/bin/env python3
"""Run a diagnostic WebClasSeg functional-component checkpoint on captures.

The upstream model was trained on its `path_class` serialization. Capture
selectors do not contain that field, so this runner uses an explicitly marked
tag-path approximation and must not be used for metrics or automatic labels.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from itertools import islice
from pathlib import Path
from time import perf_counter
from typing import Any, Iterable

MODEL_ID = "gerbejon/roberta-html-nodes-fc-classifier-v2"
MODEL_REVISION = "8b5710fb9a2c9ad479aebfc338c47f581882131a"  # pragma: allowlist secret
TOKENIZER_ID = "FacebookAI/roberta-base"
TOKENIZER_REVISION = "e2da8e2f811d1448a5b465c236feacd80ffbac7b"  # pragma: allowlist secret
MODEL_LICENSE = "not declared on the checkpoint card/Hub metadata (checked 2026-09-19)"
CLASS_TO_WEAK_REGION_HINT = {"footer": "footer", "header": "site_header", "maincontent": "main_content"}
CLASS_TO_WEAK_PURPOSE_HINT = {"nav": "navigation"}


def require_private_path(path: Path, private_root: Path) -> Path:
    resolved = path.expanduser().resolve()
    try:
        resolved.relative_to(private_root)
    except ValueError as error:
        raise ValueError(f"path must be inside --private-root: {resolved}") from error
    return resolved


def approximate_path_class(selector: str) -> str:
    """Turn a capture CSS selector into a tag-only path, retaining no IDs/classes.

    This is *not* upstream `path_class`; it merely gives a bounded test input to
    establish that the released checkpoint loads and returns probabilities.
    """
    tokens = []
    for segment in selector.split(">"):
        tag = segment.strip().split(":", 1)[0].split(".", 1)[0].split("#", 1)[0].strip().lower()
        if tag and tag.replace("-", "").isalnum():
            tokens.append(tag)
    return " ".join(tokens[:64])


def capture_nodes(captures: Path) -> Iterable[tuple[dict[str, Any], dict[str, Any]]]:
    for path in sorted(captures.glob("*.json")):
        capture = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(capture, dict) or not isinstance(capture.get("id"), str):
            raise ValueError(f"invalid capture JSON: {path}")
        nodes = capture.get("nodes")
        if not isinstance(nodes, list):
            continue
        for node in nodes:
            if isinstance(node, dict) and isinstance(node.get("id"), str) and isinstance(node.get("selector"), str):
                path_value = approximate_path_class(node["selector"])
                if path_value:
                    yield capture, node


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private-root", type=Path, required=True)
    parser.add_argument("--captures", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=25, help="maximum nodes; 0 = all")
    args = parser.parse_args()
    if args.limit < 0:
        parser.error("--limit must be non-negative")
    root = args.private_root.expanduser().resolve()
    captures, output, cache = (require_private_path(path, root) for path in (args.captures, args.output, args.cache_dir))
    from transformers import AutoModelForSequenceClassification, AutoTokenizer
    import torch

    # The checkpoint ships no tokenizer files; the base RoBERTa tokenizer is the
    # only defensible default, recorded in every output record.
    tokenizer = AutoTokenizer.from_pretrained(TOKENIZER_ID, revision=TOKENIZER_REVISION, cache_dir=str(cache))
    model = AutoModelForSequenceClassification.from_pretrained(MODEL_ID, revision=MODEL_REVISION, cache_dir=str(cache))
    model.eval()
    labels = {int(key): value for key, value in model.config.id2label.items()}
    selected = list(islice(capture_nodes(captures), args.limit or None))
    if not selected:
        parser.error("no usable nodes found")
    started = perf_counter()
    records = []
    with torch.inference_mode():
        for capture, node in selected:
            serialized = approximate_path_class(node["selector"])
            inputs = tokenizer([serialized], return_tensors="pt", truncation=True, max_length=512)
            probabilities = model(**inputs).logits.softmax(dim=-1)[0].tolist()
            order = sorted(range(len(probabilities)), key=probabilities.__getitem__, reverse=True)
            top = [{"label": labels[index], "confidence": round(probabilities[index], 6)} for index in order[:3]]
            top_label = top[0]["label"]
            records.append({
                "schemaVersion": 1,
                "kind": "diagnostic_component_format_suggestion",
                "captureId": capture["id"],
                "contentHash": capture.get("contentHash"),
                "nodeId": node["id"],
                "model": {"id": MODEL_ID, "revision": MODEL_REVISION, "license": MODEL_LICENSE},
                "tokenizer": {"id": TOKENIZER_ID, "revision": TOKENIZER_REVISION},
                "input": {"serializer": "capture-selector-tag-path-approximation-not-upstream-path_class", "sha256": hashlib.sha256(serialized.encode()).hexdigest(), "tokens": len(serialized.split())},
                "functionalClass": {"top": top, "confidenceMeaning": "uncalibrated model softmax; diagnostic ranking only"},
                "weakRegionHint": CLASS_TO_WEAK_REGION_HINT.get(top_label),
                "weakPurposeHint": CLASS_TO_WEAK_PURPOSE_HINT.get(top_label),
                "humanReviewRequired": True,
                "notPredicted": ["function", "componentType", "purpose", "pageType"],
            })
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise FileExistsError(f"refusing to overwrite existing output: {output}")
    with output.open("x", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")
    seconds = perf_counter() - started
    print(json.dumps({"nodes": len(records), "seconds": round(seconds, 3), "secondsPerNode": round(seconds / len(records), 3), "output": str(output)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

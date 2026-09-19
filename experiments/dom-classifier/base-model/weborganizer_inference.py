#!/usr/bin/env python3
"""Run the pinned WebOrganizer page-format baseline over private capture JSON.

This produces weak page-format evidence only.  It does not predict DOM region,
function, component-type, or page-purpose labels, and it never reads annotations
or Jev suggestions.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from time import perf_counter
from typing import Any, Iterable

MODEL_ID = "WebOrganizer/FormatClassifier-NoURL"
MODEL_REVISION = "74d5efb924e1843e84b28b59c26f6ceaa873dc16"  # pragma: allowlist secret
MODEL_LICENSE = "not declared on the model card (checked 2026-09-19)"
MAX_INPUT_CHARS = 24_000

# These are deliberately suggestions, never a replacement for the labeler's
# larger PAGE_TYPES taxonomy.  Omitted labels mean no defensible direct mapping.
WEAK_PAGE_TYPE_MAP: dict[str, str] = {
    "About (Org.)": "about",
    "Documentation": "docs_article",
    "FAQ": "faq",
    "Legal Notices": "legal",
    "News Article": "news_article",
    "Product Page": "product_detail",
    "Tutorial": "tutorial",
    "User Review": "review",
}


def require_private_path(path: Path, private_root: Path) -> Path:
    """Limit reads and writes to the caller-supplied private experiment root."""
    resolved = path.expanduser().resolve()
    try:
        resolved.relative_to(private_root)
    except ValueError as error:
        raise ValueError(f"path must be inside --private-root: {resolved}") from error
    return resolved


def capture_text(capture: dict[str, Any]) -> str:
    """Reconstruct bounded page text from non-container capture nodes.

    Capture text is separately truncated, so a body/root node is normally just
    early chrome. Prefer visible leaves and retain a de-duplicated fallback for
    direct content. This remains capture-derived reconstruction, not source HTML.
    """
    title = capture.get("title")
    nodes = capture.get("nodes")
    snippets: list[str] = []
    if isinstance(nodes, list):
        parent_ids = {node.get("parentId") for node in nodes if isinstance(node, dict) and isinstance(node.get("parentId"), str)}
        seen: set[str] = set()
        for node in nodes:
            if not isinstance(node, dict) or node.get("id") in parent_ids:
                continue
            rect = node.get("rect")
            text = node.get("text")
            if not isinstance(text, str) or not text.strip() or not isinstance(rect, dict):
                continue
            if not isinstance(rect.get("width"), (int, float)) or not isinstance(rect.get("height"), (int, float)) or rect["width"] <= 0 or rect["height"] <= 0:
                continue
            normalized = " ".join(text.split())
            if normalized not in seen:
                seen.add(normalized)
                snippets.append(normalized)
        if not snippets:
            for node in nodes:
                if isinstance(node, dict) and isinstance(node.get("text"), str) and node["text"].strip():
                    normalized = " ".join(node["text"].split())
                    if normalized not in seen:
                        seen.add(normalized)
                        snippets.append(normalized)
    pieces = [piece.strip() for piece in [title, *snippets] if isinstance(piece, str) and piece.strip()]
    return "\n\n".join(pieces)[:MAX_INPUT_CHARS]


def load_captures(captures: Path) -> Iterable[tuple[Path, dict[str, Any]]]:
    for path in sorted(captures.glob("*.json")):
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or not isinstance(value.get("id"), str):
            raise ValueError(f"invalid capture JSON: {path}")
        yield path, value


def prediction_record(capture: dict[str, Any], text: str, labels: dict[int, str], probabilities: list[float]) -> dict[str, Any]:
    order = sorted(range(len(probabilities)), key=probabilities.__getitem__, reverse=True)
    top = [{"label": labels[index], "confidence": round(probabilities[index], 6)} for index in order[:3]]
    label = top[0]["label"]
    # Do not emit source URLs, page text, nodes, selectors, or screenshots.
    return {
        "schemaVersion": 1,
        "kind": "weak_page_format_suggestion",
        "captureId": capture["id"],
        "contentHash": capture.get("contentHash"),
        "model": {"id": MODEL_ID, "revision": MODEL_REVISION, "license": MODEL_LICENSE},
        "input": {"source": "capture title plus root/body text", "characters": len(text), "sha256": hashlib.sha256(text.encode()).hexdigest()},
        "format": {"top": top, "confidenceMeaning": "uncalibrated model softmax; do not use as a probability of correctness"},
        "pageTypeSuggestion": WEAK_PAGE_TYPE_MAP.get(label),
        "pageTypeSuggestionProvenance": "weak deterministic mapping from top page-format class; human review required",
        "notPredicted": ["region", "function", "componentType", "purpose"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private-root", type=Path, required=True)
    parser.add_argument("--captures", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=0, help="maximum capture files (0 = all)")
    parser.add_argument("--cache-dir", type=Path, required=True, help="outside-Git Hugging Face cache")
    args = parser.parse_args()
    if args.limit < 0:
        parser.error("--limit must be non-negative")
    private_root = args.private_root.expanduser().resolve()
    captures = require_private_path(args.captures, private_root)
    output = require_private_path(args.output, private_root)
    cache_dir = require_private_path(args.cache_dir, private_root)
    if not captures.is_dir():
        parser.error("--captures must be a directory")

    os.environ["HF_HOME"] = str(cache_dir)
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, revision=MODEL_REVISION, cache_dir=str(cache_dir), trust_remote_code=True)
    model = AutoModelForSequenceClassification.from_pretrained(
        MODEL_ID, revision=MODEL_REVISION, cache_dir=str(cache_dir), trust_remote_code=True, use_memory_efficient_attention=False,
    )
    model.eval()
    labels = {int(key): value for key, value in model.config.id2label.items()}
    records: list[dict[str, Any]] = []
    started = perf_counter()
    selected = list(load_captures(captures))[: args.limit or None]
    if not selected:
        parser.error("no capture JSON files found")
    with torch.inference_mode():
        for _, capture in selected:
            text = capture_text(capture)
            if not text:
                raise ValueError(f"capture {capture['id']} has no usable title/root text")
            inputs = tokenizer([text], return_tensors="pt", truncation=True, max_length=8192)
            probabilities = model(**inputs).logits.softmax(dim=-1)[0].tolist()
            records.append(prediction_record(capture, text, labels, probabilities))
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise FileExistsError(f"refusing to overwrite existing output: {output}")
    with output.open("x", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")
    elapsed = perf_counter() - started
    print(json.dumps({"captures": len(records), "seconds": round(elapsed, 3), "secondsPerCapture": round(elapsed / len(records), 3), "output": str(output)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Score complete, already-extracted DOM candidates with a private model artifact."""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
from time import perf_counter
from typing import Any

TAXONOMY = (
    "site_header", "footer", "navigation", "main_content", "article_header",
    "card", "aside", "form", "consent_banner", "unknown",
)
PRIVATE_ROOT = Path(os.environ["DOM_CLASSIFIER_DATA_ROOT"]).resolve()


def assert_private_path(path: Path) -> Path:
    """Refuse paths outside the designated private experiment store."""
    resolved = path.expanduser().resolve()
    try:
        resolved.relative_to(PRIVATE_ROOT)
    except ValueError as error:
        raise ValueError(f"private DOM-classifier paths must be under {PRIVATE_ROOT}") from error
    return resolved


def _bounded_tokens(values: Any, prefix: str, limit: int = 12) -> dict[str, float]:
    result: dict[str, float] = {}
    if not isinstance(values, list):
        return result
    for value in values[:limit]:
        if isinstance(value, str) and value:
            result[f"{prefix}={value.lower()[:48]}"] = 1.0
    return result


def candidate_features(candidate: dict[str, Any]) -> dict[str, float]:
    """Return structural features only; labels and provenance cannot enter this mapping."""
    node = candidate.get("node")
    if not isinstance(node, dict):
        raise ValueError("candidate is missing its node object")
    features: dict[str, float] = {}
    tag = node.get("tag")
    context = node.get("context")
    if isinstance(tag, str):
        features[f"tag={tag.lower()[:48]}"] = 1.0
    if isinstance(context, str):
        features[f"context={context.lower()[:48]}"] = 1.0
    features.update(_bounded_tokens(node.get("roles"), "role"))
    features.update(_bounded_tokens(node.get("ancestorTags"), "ancestor"))
    features.update(_bounded_tokens(node.get("childTags"), "child"))

    for key in ("subtreeTagCounts", "linkCategories"):
        values = node.get(key)
        if isinstance(values, dict):
            for name, count in sorted(values.items())[:32]:
                if isinstance(name, str) and isinstance(count, (int, float)):
                    features[f"{key}:{name.lower()[:48]}"] = math.log1p(max(0.0, float(count)))
    for key in ("textLength", "siblingPosition", "siblingCount", "childCount"):
        value = node.get(key, 0)
        if isinstance(value, (int, float)):
            features[f"num:{key}"] = math.log1p(max(0.0, float(value)))
    # The text itself, URL, identifiers, label, label source, annotator, and QA
    # fields intentionally never become model features.
    return features


def semantic_heuristic(candidate: dict[str, Any]) -> str:
    """A transparent shared-DOM semantic baseline with a conservative fallback."""
    node = candidate.get("node", {})
    if not isinstance(node, dict):
        return "unknown"
    tag = str(node.get("tag", "")).lower()
    roles = {str(role).lower() for role in node.get("roles", []) if isinstance(role, str)}
    context = str(node.get("context", "")).lower()
    text = str(node.get("text", "")).lower()
    if tag == "footer" or "contentinfo" in roles:
        return "footer"
    if tag == "nav" or roles.intersection({"navigation", "menu", "menubar", "tablist"}):
        return "navigation"
    if tag == "form" or roles.intersection({"form", "search"}):
        return "form"
    if tag == "aside" or "complementary" in roles:
        return "aside"
    if tag == "header" or "banner" in roles:
        return "article_header" if context == "article" else "site_header"
    if tag == "main" or "main" in roles or context in {"main", "article"}:
        return "main_content"
    if roles.intersection({"dialog", "alertdialog"}) and any(word in text for word in ("cookie", "consent", "privacy")):
        return "consent_banner"
    return "unknown"


def apply_temperature(probabilities: list[float], temperature: float) -> list[float]:
    if temperature <= 0:
        raise ValueError("temperature must be positive")
    adjusted = [max(value, 1e-12) ** (1.0 / temperature) for value in probabilities]
    total = sum(adjusted)
    return [value / total for value in adjusted]


def score_candidate(artifact: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    vector = artifact["vectorizer"].transform([candidate_features(candidate)])
    probabilities = artifact["model"].predict_proba(vector)[0].tolist()
    calibrated = apply_temperature(probabilities, float(artifact["temperature"]))
    labels = list(artifact["classes"])
    winner = max(range(len(labels)), key=calibrated.__getitem__)
    confidence = calibrated[winner]
    forced = labels[winner]
    prediction = forced if confidence >= float(artifact["abstentionThreshold"]) else "unknown"
    entropy = -sum(value * math.log(value) for value in calibrated if value > 0)
    return {
        "candidateId": candidate.get("candidateId"),
        "prediction": prediction,
        "forcedPrediction": forced,
        "confidence": confidence,
        "uncertaintyEntropy": entropy,
        "probabilities": dict(zip(labels, calibrated)),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--input", type=Path, required=True, help="private JSONL of full candidate records")
    parser.add_argument("--output", type=Path, required=True, help="private prediction JSONL")
    args = parser.parse_args()
    model_path, input_path, output_path = (assert_private_path(path) for path in (args.model, args.input, args.output))
    import joblib

    artifact = joblib.load(model_path)
    started = perf_counter()
    rows = [json.loads(line) for line in input_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(score_candidate(artifact, row), separators=(",", ":")) + "\n")
    elapsed_ms = (perf_counter() - started) * 1000
    print(json.dumps({"candidates": len(rows), "latencyMsPerCandidate": elapsed_ms / max(1, len(rows))}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Sparse text/DOM student for the v1 Product Hunt weak-label corpus.

This is deliberately an offline experiment.  It consumes only the supplied text
serializers (including the DOM fields already present in node input), never page
geometry or screenshots.  Teacher probabilities are training weights, not gold.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import joblib
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import FeatureUnion

CONFIG = {
    "word": {"ngram_range": (1, 2), "min_df": 1, "max_features": 40_000, "sublinear_tf": True},
    "char": {"analyzer": "char_wb", "ngram_range": (3, 5), "min_df": 2, "max_features": 60_000, "sublinear_tf": True},
    "C": 2.0,
    "multilabelThreshold": 0.5,
    "randomState": 2307,
}


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open() as source:
        return [json.loads(line) for line in source if line.strip()]


def apply_jev_v3(base_rows: list[dict[str, Any]], v3_rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Replace, never duplicate, matching v2 weak targets with Jev-v3 targets.

    v3 uses a capture hash for the stored capture and a snapshot hash for the
    serializer snapshot.  The base export calls the latter ``snapshotHash``.
    Both page/node ID and that snapshot hash must match before any replacement.
    """
    index = {(row["pageId"], row.get("nodeId"), row.get("provenance", {}).get("snapshotHash")): row for row in base_rows}
    replacements: dict[tuple[str, str | None, str | None], dict[str, Any]] = {}
    for row in v3_rows:
        key = (row.get("pageId"), row.get("nodeId"), row.get("snapshotHash"))
        if key not in index:
            raise ValueError("Jev-v3 row does not match a train serializer snapshot")
        axes = row.get("axisProbabilities", {})
        target: dict[str, Any] = {}
        if row.get("nodeId") is None:
            target = {axis: values for axis, values in axes.items() if axis in ("pageTypes", "contentKinds")}
        else:
            target = {axis: values for axis, values in axes.items() if axis in ("regions", "purposes")}
            component = row.get("componentTypeChoice")
            if component:
                target["componentType"] = {"choice": component.get("choice"), "confidence": component.get("confidence"), "distribution": component.get("distribution", [])}
        if not target:
            raise ValueError("Jev-v3 row contains no compatible observed axis")
        replacements[key] = target
    merged = []
    for row in base_rows:
        key = (row["pageId"], row.get("nodeId"), row.get("provenance", {}).get("snapshotHash"))
        if key in replacements:
            copy = dict(row)
            copy["softTargets"] = replacements[key]
            merged.append(copy)
        else:
            merged.append(row)
    return merged, len(replacements)


def capture_hash(row: dict[str, Any]) -> str | None:
    provenance = row.get("provenance", {})
    return provenance.get("captureHash") or provenance.get("snapshotHash")


def record_key(row: dict[str, Any]) -> tuple[str, ...]:
    """Stable key for independent labels; a node id alone is not globally safe."""
    if row.get("recordType") == "node":
        value = capture_hash(row)
        if not value:
            raise ValueError("node record lacks captureHash/snapshotHash")
        return ("node", str(row["pageId"]), str(row["nodeId"]), str(value))
    return ("page", str(row["pageId"]), str(capture_hash(row) or ""))


def build_vectorizer() -> FeatureUnion:
    return FeatureUnion([
        ("word", TfidfVectorizer(**CONFIG["word"])),
        ("char", TfidfVectorizer(**CONFIG["char"])),
    ])


@dataclass
class ConstantBinary:
    probability: float

    def predict_proba(self, matrix: Any) -> np.ndarray:
        return np.tile([1 - self.probability, self.probability], (matrix.shape[0], 1))


def fit_binary(matrix: Any, probabilities: list[float]) -> LogisticRegression | ConstantBinary:
    """Fit BCE to soft targets by expanding each observed target into 0/1 rows.

    p=0 and p=1 are explicit weak negatives/positives.  A missing axis is not
    passed here at all, so it can never become an accidental negative.
    """
    values = np.asarray(probabilities, dtype=float)
    if not np.all(np.isfinite(values)) or np.any((values < 0) | (values > 1)):
        raise ValueError("probabilities must be in [0, 1]")
    positive = values.sum()
    negative = len(values) - positive
    if positive < 1e-9 or negative < 1e-9:
        return ConstantBinary(float(positive > negative))
    from scipy.sparse import vstack
    expanded = vstack([matrix, matrix])
    labels = np.concatenate([np.ones(len(values), dtype=int), np.zeros(len(values), dtype=int)])
    weights = np.concatenate([values, 1 - values])
    classifier = LogisticRegression(C=CONFIG["C"], max_iter=500, solver="liblinear", random_state=CONFIG["randomState"])
    classifier.fit(expanded, labels, sample_weight=weights)
    return classifier


def observed_multilabel_targets(rows: list[dict[str, Any]], axis: str) -> dict[str, list[tuple[int, float]]]:
    result: dict[str, list[tuple[int, float]]] = {}
    for index, row in enumerate(rows):
        for item in row.get("softTargets", {}).get(axis, []):
            label, probability = item.get("label"), item.get("yesProbability")
            if isinstance(label, str) and isinstance(probability, (int, float)):
                result.setdefault(label, []).append((index, float(probability)))
    return result


def fit_multilabel(matrix: Any, rows: list[dict[str, Any]], axis: str) -> dict[str, Any]:
    heads: dict[str, Any] = {}
    for label, observed in sorted(observed_multilabel_targets(rows, axis).items()):
        indices, probabilities = zip(*observed)
        heads[label] = fit_binary(matrix[list(indices)], list(probabilities))
    if not heads:
        raise ValueError(f"no observed weak targets for {axis}")
    return heads


def fit_component(matrix: Any, rows: list[dict[str, Any]]) -> tuple[list[str], dict[str, Any]]:
    observed: dict[str, list[tuple[int, float]]] = {}
    for index, row in enumerate(rows):
        target = row.get("softTargets", {}).get("componentType", {})
        for item in target.get("distribution", []):
            label, probability = item.get("label"), item.get("probability")
            if isinstance(label, str) and isinstance(probability, (int, float)):
                observed.setdefault(label, []).append((index, float(probability)))
    if not observed:
        raise ValueError("no observed weak componentType distributions")
    labels = sorted(observed)
    return labels, {label: fit_binary(matrix[[i for i, _ in entries]], [p for _, p in entries]) for label, entries in observed.items()}


def probability(head: Any, matrix: Any) -> np.ndarray:
    return head.predict_proba(matrix)[:, 1]


def predict(model: dict[str, Any], rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # Validation files intentionally interleave page and node records.  Keep the
    # two fitted feature spaces separate rather than assuming the first row's type.
    if not rows:
        return []
    by_kind = {kind: [row["input"] for row in rows if row["recordType"] == kind] for kind in ("node", "page")}
    matrices = {kind: model["vectorizers"][kind].transform(inputs) for kind, inputs in by_kind.items() if inputs}
    positions = {"node": 0, "page": 0}
    result = []
    for row in rows:
        kind = row["recordType"]
        index = positions[kind]
        positions[kind] += 1
        matrix = matrices[kind]
        output: dict[str, Any] = {"recordType": row["recordType"], "pageId": row["pageId"], "split": row.get("split"), "captureHash": row.get("captureHash") or capture_hash(row)}
        if row["recordType"] == "node":
            output["nodeId"] = row["nodeId"]
            component = {label: float(probability(head, matrix[index : index + 1])[0]) for label, head in model["heads"]["componentType"].items()}
            output["componentType"] = {"probabilities": component, "prediction": max(component, key=component.get)}
            for axis in ("regions", "purposes"):
                scores = {label: float(probability(head, matrix[index : index + 1])[0]) for label, head in model["heads"][axis].items()}
                output[axis] = {"probabilities": scores, "positiveLabels": sorted(label for label, score in scores.items() if score >= model["config"]["multilabelThreshold"])}
        else:
            for axis in ("pageTypes", "contentKinds"):
                scores = {label: float(probability(head, matrix[index : index + 1])[0]) for label, head in model["heads"][axis].items()}
                output[axis] = {"probabilities": scores, "positiveLabels": sorted(label for label, score in scores.items() if score >= model["config"]["multilabelThreshold"])}
        result.append(output)
    return result


def diagnostic_agreement(rows: list[dict[str, Any]], predictions: list[dict[str, Any]]) -> dict[str, Any]:
    """Agreement to the same Jev source is a diagnostic, never quality evidence."""
    errors: dict[str, list[float]] = {}
    component_errors: list[float] = []
    component_top1: list[bool] = []
    for row, prediction in zip(rows, predictions):
        teacher_component = row.get("softTargets", {}).get("componentType", {}).get("distribution", [])
        if teacher_component and "componentType" in prediction:
            teacher_scores = {item["label"]: float(item["probability"]) for item in teacher_component if isinstance(item.get("label"), str) and isinstance(item.get("probability"), (int, float))}
            student_scores = prediction["componentType"]["probabilities"]
            shared = sorted(set(teacher_scores) & set(student_scores))
            component_errors.extend(abs(teacher_scores[label] - student_scores[label]) for label in shared)
            if shared:
                component_top1.append(prediction["componentType"]["prediction"] == max(shared, key=teacher_scores.get))
        for axis in ("regions", "purposes", "pageTypes", "contentKinds"):
            for item in row.get("softTargets", {}).get(axis, []):
                label, target = item.get("label"), item.get("yesProbability")
                if label in prediction.get(axis, {}).get("probabilities", {}) and isinstance(target, (int, float)):
                    errors.setdefault(axis, []).append(abs(float(target) - prediction[axis]["probabilities"][label]))
    result = {axis: {"observedTargets": len(values), "meanAbsoluteProbabilityError": float(np.mean(values))} for axis, values in errors.items()}
    result["componentType"] = {"observedTargets": len(component_errors), "meanAbsoluteProbabilityError": float(np.mean(component_errors)), "teacherTop1Agreement": float(np.mean(component_top1))}
    return result


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def train(train_nodes: list[dict[str, Any]], train_pages: list[dict[str, Any]]) -> dict[str, Any]:
    if any(row.get("split") != "train" for row in train_nodes + train_pages):
        raise ValueError("training inputs must contain only train split rows")
    vectorizers = {"node": build_vectorizer(), "page": build_vectorizer()}
    node_matrix = vectorizers["node"].fit_transform([row["input"] for row in train_nodes])
    page_matrix = vectorizers["page"].fit_transform([row["input"] for row in train_pages])
    _, component_heads = fit_component(node_matrix, train_nodes)
    return {"format": "squirrelscan-sparse-student-v1", "config": CONFIG, "vectorizers": vectorizers, "heads": {
        "componentType": component_heads,
        "regions": fit_multilabel(node_matrix, train_nodes, "regions"),
        "purposes": fit_multilabel(node_matrix, train_nodes, "purposes"),
        "pageTypes": fit_multilabel(page_matrix, train_pages, "pageTypes"),
        "contentKinds": fit_multilabel(page_matrix, train_pages, "contentKinds"),
    }}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--jev-v3", type=Path, help="supplementary train-only Jev-v3 rows; matched targets replace v2 targets")
    parser.add_argument("--validation", action="store_true", help="write only same-teacher diagnostic predictions for validation")
    args = parser.parse_args()
    root = args.dataset
    nodes = read_jsonl(root / "node-train-weak.jsonl")
    pages = read_jsonl(root / "page-train-weak.jsonl")
    v3_replacements = 0
    if args.jev_v3:
        merged, v3_replacements = apply_jev_v3(nodes + pages, read_jsonl(args.jev_v3))
        nodes = [row for row in merged if row["recordType"] == "node"]
        pages = [row for row in merged if row["recordType"] == "page"]
    model = train(nodes, pages)
    args.output.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, args.output / "student.joblib")
    metadata = {"datasetManifestSha256": sha256(root / "manifest.json"), "trainingRows": {"nodes": len(nodes), "pages": len(pages)}, "jevV3TargetReplacements": v3_replacements, "jevV3Sha256": sha256(args.jev_v3) if args.jev_v3 else None, "featurePolicy": "only supplied text/DOM serializers; no screenshots or geometry", "supervision": "Jev weak probability targets; missing axes excluded", "frozenConfig": CONFIG, "runTimestampUtc": datetime.now(timezone.utc).isoformat(), "artifactSha256": sha256(args.output / "student.joblib"), "testAccessed": False}
    (args.output / "metadata.json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n")
    if args.validation:
        validation = read_jsonl(root / "validation-provisional-diagnostic.jsonl")
        predictions = predict(model, validation)
        (args.output / "validation-predictions.jsonl").write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in predictions))
        metadata["validationDiagnosticAgreement"] = diagnostic_agreement(validation, predictions)
        (args.output / "metadata.json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n")
        (args.output / "public-summary.json").write_text(json.dumps({"scope": "offline sparse text/DOM student", "supervision": "same-source Jev weak labels", "validation": metadata["validationDiagnosticAgreement"], "claims": ["diagnostic agreement only", "not human accuracy", "held-out test not accessed"]}, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()

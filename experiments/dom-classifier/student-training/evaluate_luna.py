"""Score a frozen sparse student against validated independent Luna labels only."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import joblib

from student import predict


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require_manifest_bound_labels(manifest: dict[str, Any], manifest_path: Path, labels_path: Path) -> str:
    """Bind the exact approved file, not merely a mutable manifest status."""
    entries = manifest.get("labelFiles")
    if not isinstance(entries, list):
        raise ValueError("validated manifest must list immutable labelFiles")
    resolved = labels_path.resolve()
    matches = [entry for entry in entries if isinstance(entry, dict) and (manifest_path.parent / str(entry.get("path", ""))).resolve() == resolved]
    if len(matches) != 1:
        raise ValueError("labels path is not uniquely bound in validated manifest")
    expected = matches[0].get("sha256")
    actual = "sha256:" + sha256(labels_path)
    if expected != actual:
        raise ValueError("labels file hash does not match validated manifest")
    return actual


def key(row: dict[str, Any]) -> tuple[str, ...]:
    if row.get("recordType") == "node":
        return ("node", str(row["pageId"]), str(row["nodeId"]), str(row["captureHash"]))
    if row.get("recordType") == "page":
        return ("page", str(row["pageId"]), str(row["captureHash"]))
    raise ValueError("recordType must be node or page")


def labels_for(row: dict[str, Any], axis: str) -> set[str] | str | None:
    observed_axes = row.get("observedAxes", {})
    if not isinstance(observed_axes, dict):
        raise ValueError("observedAxes must be an object")
    allowed = {"componentType", "regions", "purposes"} if row.get("recordType") == "node" else {"pageTypes", "contentKinds"}
    if set(observed_axes) - allowed:
        raise ValueError("observedAxes contains an axis not valid for recordType")
    observed = observed_axes.get(axis)
    if not isinstance(observed, dict) or observed.get("complete") is not True:
        return None
    labels = observed.get("labels")
    if axis == "componentType":
        if isinstance(labels, list) and len(labels) == 1 and isinstance(labels[0], str):
            labels = labels[0]
        if not isinstance(labels, str):
            raise ValueError("complete componentType must have one string label")
        return labels
    if not isinstance(labels, list) or not all(isinstance(label, str) for label in labels):
        raise ValueError(f"complete {axis} must have a list of string labels")
    return set(labels)


def positive_only_labels(row: dict[str, Any], axis: str) -> set[str]:
    """Partial labels are positive observations, never implied negative labels."""
    observed = row.get("observedAxes", {}).get(axis)
    if not isinstance(observed, dict) or observed.get("complete") is not False:
        return set()
    labels = observed.get("labels", [])
    if not isinstance(labels, list) or not all(isinstance(label, str) for label in labels):
        raise ValueError("incomplete axis labels must be a list of strings")
    return set(labels)


def tag_baseline(row: dict[str, Any]) -> dict[str, Any]:
    """A deliberately small DOM-tag baseline, reported on the same frozen rows."""
    first = row["input"].split("\n", 2)[1] if row["recordType"] == "node" and "\n" in row["input"] else ""
    tag = first.removeprefix("tag=").strip()
    # General semantic-tag baseline, fixed independently of this corpus.  It
    # intentionally uses only the tag token already present in the serializer.
    component = {
        "nav": "navigation_menu", "button": "button", "a": "link",
        "input": "input", "select": "select", "textarea": "input",
        "img": "image", "picture": "media", "video": "media",
        "form": "form", "table": "table", "main": "layout_container",
        "header": "banner", "footer": "layout_container", "article": "article",
        "aside": "content_section", "section": "content_section",
        "p": "text", "span": "text", "label": "text", "li": "text",
        "h1": "heading", "h2": "heading", "h3": "heading", "h4": "heading",
        "h5": "heading", "h6": "heading", "ul": "list", "ol": "list",
    }.get(tag, "unknown")
    regions = {"main": {"main_content"}, "header": {"site_header"}, "footer": {"footer"}}.get(tag, set())
    return {"componentType": component, "regions": regions, "purposes": set(), "pageTypes": set(), "contentKinds": set()}


def evaluate(rows: list[dict[str, Any]], predictions: list[dict[str, Any]], baseline: bool = False) -> dict[str, Any]:
    if len(rows) != len(predictions):
        raise ValueError("label and prediction counts differ")
    results: dict[str, list[bool]] = {axis: [] for axis in ("componentType", "regions", "purposes", "pageTypes", "contentKinds")}
    positive_claims: dict[str, list[tuple[int, int]]] = {axis: [] for axis in ("regions", "purposes", "pageTypes", "contentKinds")}
    for row, prediction in zip(rows, predictions):
        if key(row) != key(prediction):
            raise ValueError("prediction/label key mismatch; do not align independent labels by position")
        candidate = tag_baseline(row) if baseline else prediction
        for axis in results:
            target = labels_for(row, axis)
            if target is None:
                if axis in positive_claims:
                    claimed = positive_only_labels(row, axis)
                    if claimed:
                        predicted = set(candidate.get(axis, set()) if baseline else candidate.get(axis, {}).get("positiveLabels", []))
                        positive_claims[axis].append((len(claimed), len(claimed & predicted)))
                continue
            if baseline:
                actual = candidate.get(axis, None if axis == "componentType" else set())
            else:
                actual_axis = candidate.get(axis, {})
                actual = actual_axis.get("prediction") if axis == "componentType" else actual_axis.get("positiveLabels", [])
            results[axis].append(actual == target if axis == "componentType" else set(actual) == target)
    output = {axis: {"completeExamples": len(values), "exactSetAccuracy": sum(values) / len(values) if values else None} for axis, values in results.items()}
    for axis, claims in positive_claims.items():
        total = sum(count for count, _ in claims)
        hits = sum(count for _, count in claims)
        output[axis]["positiveOnlyObservedLabels"] = total
        output[axis]["positiveOnlyRecall"] = hits / total if total else None
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--model-metadata", type=Path, required=True)
    parser.add_argument("--labels", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    if manifest.get("status") != "validated":
        raise ValueError("independent labels must have manifest status 'validated'")
    metadata = json.loads(args.model_metadata.read_text())
    actual_hash = sha256(args.model)
    if metadata.get("artifactSha256") != actual_hash:
        raise ValueError("model artifact hash does not match frozen metadata")
    label_hash = require_manifest_bound_labels(manifest, args.manifest, args.labels)
    rows = read_jsonl(args.labels)
    if not rows or any(row.get("provisional") is True or row.get("source") != "luna" or "input" not in row for row in rows):
        raise ValueError("labels must be non-provisional Luna rows with serialized input")
    if len({key(row) for row in rows}) != len(rows):
        raise ValueError("duplicate independent-label keys")
    model = joblib.load(args.model)
    model_predictions = predict(model, rows)
    args.output.write_text(json.dumps({"labelManifest": str(args.manifest), "labelSha256": label_hash, "model": "sparse-student-v1", "modelArtifactSha256": actual_hash, "student": evaluate(rows, model_predictions), "tagBaseline": evaluate(rows, model_predictions, baseline=True), "limits": ["exact-set scores include only explicitly complete axes", "positive-only axes report recall only", "independent Luna labels are not human gold"]}, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()

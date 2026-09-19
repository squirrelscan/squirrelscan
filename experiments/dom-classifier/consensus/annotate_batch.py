#!/usr/bin/env python3
"""Join declared private decisions to blind packets by identity, never position.

This utility does not infer how a decision was made. It preserves the declared
labeling method and refuses to call any result independent unless that method is
explicitly ``independent_reasoned_review``.
"""
from __future__ import annotations
import argparse, hashlib, json
import os
from pathlib import Path
from typing import Any

ROOT = Path(os.environ["DOM_CLASSIFIER_DATA_ROOT"]) / "2026-09-19"
AXES = ("componentType", "regions", "purposes", "pageTypes", "contentKinds")
ALLOWED = {"componentType": {"button", "link", "input", "checkbox", "radio", "select", "toggle", "heading", "text", "icon", "image", "search", "dropdown", "tabs", "accordion", "pagination", "card", "form", "list", "table", "article", "media", "hero", "navigation_menu", "content_section", "layout_container", "dialog", "drawer", "tooltip", "notification", "banner", "popover", "unknown"}}

def read(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]

def input_hash(row: dict[str, Any]) -> str:
    if not isinstance(row.get("input"), str): raise ValueError("serialized input required")
    return "sha256:" + hashlib.sha256(row["input"].encode()).hexdigest()

def key(row: dict[str, Any]) -> tuple[str, ...]:
    for name in ("recordType", "split", "pageId", "captureHash"):
        if not isinstance(row.get(name), str) or not row[name]: raise ValueError(f"{name} required")
    if row["recordType"] == "node":
        if not isinstance(row.get("nodeId"), str) or not row["nodeId"]: raise ValueError("nodeId required")
        return ("node", row["split"], row["pageId"], row["nodeId"], row["captureHash"], input_hash(row))
    if row["recordType"] != "page" or row.get("nodeId") is not None: raise ValueError("invalid page identity")
    return ("page", row["split"], row["pageId"], row["captureHash"], input_hash(row))

def decision_key(row: dict[str, Any]) -> tuple[str, ...]:
    """Use a reviewer-declared input hash without requiring a copied input payload."""
    required = ("recordType", "split", "pageId", "captureHash", "inputSha256")
    if any(not isinstance(row.get(name), str) or not row[name] for name in required):
        raise ValueError("decision identity fields required")
    if row["recordType"] == "node":
        if not isinstance(row.get("nodeId"), str) or not row["nodeId"]: raise ValueError("nodeId required")
        return ("node", row["split"], row["pageId"], row["nodeId"], row["captureHash"], row["inputSha256"])
    if row["recordType"] != "page" or row.get("nodeId") is not None: raise ValueError("invalid page identity")
    return ("page", row["split"], row["pageId"], row["captureHash"], row["inputSha256"])

def normalize_axis(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not isinstance(value.get("complete"), bool): raise ValueError(f"{name}: complete bool required")
    labels = value.get("labels")
    if name == "componentType":
        if value["complete"] and isinstance(labels, list) and len(labels) == 1: labels = labels[0]
        if value["complete"] and (not isinstance(labels, str) or not labels): raise ValueError("componentType needs one label")
        if not value["complete"] and labels not in (None, []): raise ValueError("incomplete componentType must be empty")
        if value["complete"] and labels not in ALLOWED["componentType"]: raise ValueError("invalid componentType")
        return {"complete": value["complete"], "labels": labels if value["complete"] else None}
    if not isinstance(labels, list) or not all(isinstance(label, str) and label for label in labels): raise ValueError(f"{name}: label array required")
    if len(labels) != len(set(labels)): raise ValueError(f"{name}: duplicate labels")
    return {"complete": value["complete"], "labels": labels}

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--queue", type=Path, default=ROOT / "consensus-v1")
    parser.add_argument("--decisions", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-count", type=int, required=True)
    parser.add_argument("--split", choices=("train", "validation", "test"))
    args = parser.parse_args()
    blind = [row for split in ("train", "validation", "test") for row in read(args.queue / f"luna-{split}-blind.jsonl")]
    source = {key(row): row for row in blind}
    if len(source) != len(blind): raise ValueError("duplicate blind identities")
    decisions: dict[tuple[str, ...], dict[str, Any]] = {}
    for decision in read(args.decisions):
        if args.split and decision.get("split") != args.split: continue
        identity = decision_key(decision)
        if identity not in source or identity in decisions: raise ValueError("unknown or duplicate decision identity")
        if "input" in decision and decision["input"] != source[identity]["input"]: raise ValueError("decision input differs from blind packet")
        if decision.get("labelingMethod") not in {"independent_reasoned_review", "heuristic_rule"}: raise ValueError("declared labelingMethod required")
        decisions[identity] = decision
    if len(decisions) != args.expected_count: raise ValueError(f"expected {args.expected_count} decisions, received {len(decisions)}")
    output = []
    for packet in blind:
        if key(packet) not in decisions: continue
        decision = decisions[key(packet)]
        observed = decision.get("observedAxes")
        if not isinstance(observed, dict) or set(observed) != set(AXES): raise ValueError("exactly five observed axes required")
        if packet["recordType"] == "page" and observed["componentType"] == {"complete": True, "labels": []}:
            # Page packets have no component axis; normalize the explicitly approved empty axis.
            observed = {**observed, "componentType": {"complete": False, "labels": []}}
        relevant = ("componentType", "regions", "purposes") if packet["recordType"] == "node" else ("pageTypes", "contentKinds")
        for axis_name, axis_value in observed.items():
            if axis_name not in relevant and (axis_value.get("complete") or axis_value.get("labels")):
                raise ValueError(f"irrelevant {axis_name} axis must be empty and incomplete")
        method = decision["labelingMethod"]
        output.append({
            **{field: packet.get(field) for field in ("schemaVersion", "recordType", "split", "pageId", "nodeId", "captureHash", "snapshotHash", "input")},
            "inputSha256": input_hash(packet), "observedAxes": {axis: normalize_axis(observed[axis], axis) for axis in relevant},
            "evidence": decision.get("evidence"), "source": "luna" if method == "independent_reasoned_review" else "heuristic",
            "model": decision.get("model"), "promptVersion": decision.get("promptVersion"), "promptHash": decision.get("promptHash"),
            "labelingMethod": method, "gold": False, "annotationStatus": "independent_judgment_unvalidated" if method == "independent_reasoned_review" else "heuristic_provisional",
        })
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in output))
    print(json.dumps({"rows": len(output), "methods": {method: sum(row["labelingMethod"] == method for row in output) for method in ("independent_reasoned_review", "heuristic_rule")}}, sort_keys=True))

if __name__ == "__main__": main()

#!/usr/bin/env python3
"""Freeze a text/DOM-only training dataset from a reviewed-label snapshot.

The snapshot itself is made by ../training-export/cli.ts.  This program adds
deterministic split assignments before reading labels, then writes only private
model records.  It never reads screenshots and it never contacts a service.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
import math
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

SPLITS = ("train", "validation", "test")
SPLIT_RATIOS = {"train": 70, "validation": 15, "test": 15}


def load_serializer(experiment_root: Path):
    spec = importlib.util.spec_from_file_location(
        "approved_text_training_data", experiment_root / "text-training" / "data.py"
    )
    if not spec or not spec.loader:
        raise RuntimeError("cannot load approved text-training serializer")
    module = importlib.util.module_from_spec(spec)
    # dataclasses resolves postponed annotations through sys.modules.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_page_serializer(experiment_root: Path):
    spec = importlib.util.spec_from_file_location(
        "approved_page_capture_text", experiment_root / "base-model" / "weborganizer_inference.py"
    )
    if not spec or not spec.loader:
        raise RuntimeError("cannot load approved page text serializer")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def rows(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    result = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"{path}:{number} must be an object")
        result.append(value)
    return result


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_jsonl(path: Path, values: list[dict[str, Any]]) -> None:
    path.write_text("".join(json.dumps(value, sort_keys=True) + "\n" for value in values), encoding="utf-8")


def digest(value: str) -> str:
    # Captures can retain isolated browser UTF-16 surrogate code units. Keep
    # hashing deterministic without changing the approved serializer text.
    return hashlib.sha256(value.encode("utf-8", "surrogatepass")).hexdigest()


def sha256_file(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_hash(value: Any) -> str:
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":")))


def attach_groups(pages: list[dict[str, Any]], grouping_input: Path) -> None:
    """Attach the exporter-validated eTLD+1 map without reparsing public suffixes."""
    values = json.loads(grouping_input.read_text(encoding="utf-8"))
    if not isinstance(values, list):
        raise ValueError("grouping input must be an array")
    groups: dict[str, str] = {}
    for row in values:
        if not isinstance(row, dict) or not isinstance(row.get("pageId"), str) or not isinstance(row.get("groupId"), str):
            raise ValueError("grouping input row needs pageId and groupId")
        prior = groups.setdefault(row["pageId"], row["groupId"].lower())
        if prior != row["groupId"].lower():
            raise ValueError(f"conflicting documented eTLD+1 for {row['pageId']}")
    for page in pages:
        group = groups.get(page["id"])
        if not isinstance(group, str) or not group:
            raise ValueError(f"missing documented eTLD+1 for snapshot capture {page['id']}")
        page["_etldPlusOne"] = group.lower()


def domain_from_group(page: dict[str, Any]) -> str:
    domain = page.get("_etldPlusOne")
    if not isinstance(domain, str):
        raise ValueError(f"capture {page.get('id')} has no validated eTLD+1 grouping")
    return domain


def effective_annotations(
    source_rows: list[dict[str, Any]], undo_rows: list[dict[str, Any]] | None = None
) -> dict[tuple[str, str, str | None], dict[str, Any]]:
    """Resolve terminal revisions and remove undone actions without resurrection."""
    undone = {
        row.get("actionId")
        for row in undo_rows or []
        if row.get("actionKind") == "annotation" and isinstance(row.get("actionId"), str)
    }
    active_rows = [row for row in source_rows if row.get("id") not in undone]
    latest: dict[tuple[str, str, str | None], dict[str, Any]] = {}
    for row in active_rows:
        page_id, node_id = row.get("pageId"), row.get("nodeId")
        if isinstance(page_id, str) and isinstance(node_id, str):
            capture_hash = row.get("captureHash") if isinstance(row.get("captureHash"), str) else None
            latest[(page_id, node_id, capture_hash)] = row
    return latest


def annotation_target_matches(
    annotations: dict[tuple[str, str, str | None], dict[str, Any]],
    page_id: str,
    node_id: str,
    capture_hash: str | None,
) -> bool:
    return (page_id, node_id, capture_hash) in annotations or (
        page_id,
        node_id,
        None,
    ) in annotations


def ancestor_tags(node: dict[str, Any], nodes: dict[str, dict[str, Any]]) -> list[str]:
    result: list[str] = []
    current = node
    seen: set[str] = set()
    while isinstance(current, dict):
        parent_id = current.get("parentId")
        if not isinstance(parent_id, str) or parent_id in seen:
            break
        seen.add(parent_id)
        parent = nodes.get(parent_id)
        if not parent:
            break
        tag = parent.get("tag")
        if isinstance(tag, str):
            result.append(tag)
        current = parent
    return list(reversed(result))


def runtime_node(page: dict[str, Any], node_id: str) -> dict[str, Any]:
    all_nodes = page.get("nodes")
    if not isinstance(all_nodes, list):
        raise ValueError(f"capture {page.get('id')} nodes is invalid")
    by_id = {node.get("id"): node for node in all_nodes if isinstance(node, dict) and isinstance(node.get("id"), str)}
    node = by_id.get(node_id)
    if not isinstance(node, dict):
        raise ValueError(f"capture {page.get('id')} lacks node {node_id}")
    tag = node.get("tag")
    text = node.get("text")
    if not isinstance(tag, str) or not isinstance(text, str):
        raise ValueError(f"capture {page.get('id')} node {node_id} is missing runtime tag/text")
    return {"tag": tag, "text": text, "ancestorTags": ancestor_tags(node, by_id)}


def prior_v2_domains(v2_root: Path) -> set[str]:
    domains = set()
    for row in rows(v2_root / "page-provenance.jsonl"):
        source = row.get("sourceRow")
        if isinstance(source, dict) and isinstance(source.get("registrableDomain"), str):
            domains.add(source["registrableDomain"].lower())
    return domains


def validate_snapshot(snapshot: Path) -> None:
    manifest_path = snapshot / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for entry in manifest.get("input", {}).get("auditFiles", []):
        path = snapshot / entry["path"]
        if sha256_file(path) != entry.get("sha256"):
            raise ValueError(f"snapshot audit hash mismatch: {entry.get('path')}")
    for entry in manifest.get("captureEntries", []):
        path = snapshot / "audit" / "captures" / f"{entry['pageId']}.json"
        if sha256_file(path) != entry.get("sourceSha256"):
            raise ValueError(f"snapshot capture hash mismatch: {entry.get('pageId')}")


def connected_components(pages: list[dict[str, Any]]) -> tuple[dict[str, str], dict[str, list[str]]]:
    """Connect eTLD+1 groups through exact canonical content hashes."""
    parent: dict[str, str] = {}

    def find(value: str) -> str:
        parent.setdefault(value, value)
        if parent[value] != value:
            parent[value] = find(parent[value])
        return parent[value]

    def union(left: str, right: str) -> None:
        left, right = find(left), find(right)
        if left != right:
            parent[max(left, right)] = min(left, right)

    by_hash: dict[str, list[str]] = defaultdict(list)
    for page in pages:
        domain = domain_from_group(page)
        parent.setdefault(domain, domain)
        for content_hash in (page.get("contentHash"), page.get("_canonicalDomTextHash")):
            if isinstance(content_hash, str) and content_hash:
                by_hash[content_hash.removeprefix("sha256:").lower()].append(domain)
    for domains in by_hash.values():
        for domain in domains[1:]:
            union(domains[0], domain)
    mapping = {domain: find(domain) for domain in sorted(parent)}
    members: dict[str, list[str]] = defaultdict(list)
    for domain, component in mapping.items():
        members[component].append(domain)
    return mapping, dict(members)


def assignments(pages: list[dict[str, Any]], old_domains: set[str]) -> tuple[dict[str, str], dict[str, Any]]:
    domain_component, components = connected_components(pages)
    by_domain_pages: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for page in pages:
        by_domain_pages[domain_from_group(page)].append(page)
    component_sizes = {
        component: sum(len(by_domain_pages[domain]) for domain in domains)
        for component, domains in components.items()
    }
    def overlaps_prior_v2(domain: str) -> bool:
        # The source v2 inventory used public-suffix defaults whereas the
        # reviewed-label export permits private suffixes. Retain the parent
        # platform exclusion as a conservative bridge between those policies.
        return any(domain == old or domain.endswith("." + old) for old in old_domains)

    old_components = {
        component for component, domains in components.items() if any(overlaps_prior_v2(domain) for domain in domains)
    }
    result: dict[str, str] = {component: "train" for component in old_components}
    totals = Counter({"train": sum(component_sizes[c] for c in old_components), "validation": 0, "test": 0})
    target_total = len(pages)
    for component in sorted((c for c in components if c not in old_components), key=lambda c: (digest("dom-role-text-v1|" + c), c)):
        # Minimize quota distance; deterministic tie order prevents label influence.
        split = min(
            SPLITS,
            key=lambda candidate: (
                max(0, totals[candidate] + component_sizes[component] - target_total * SPLIT_RATIOS[candidate] / 100),
                totals[candidate],
                SPLITS.index(candidate),
            ),
        )
        result[component] = split
        totals[split] += component_sizes[component]
    return result, {
        "domainToComponent": domain_component,
        "components": components,
        "oldV2Domains": sorted(old_domains),
        "priorV2OverlapRule": "exact eTLD+1 or subdomain of an old public-suffix-default registrable domain",
        "oldV2ComponentsForcedTrain": sorted(old_components),
        "pageCounts": dict(totals),
    }


def weak_targets(suggestion: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    if suggestion.get("provider") != "typesafe" or not isinstance(suggestion.get("provisional"), bool):
        raise ValueError("weak suggestion must be a provisional Typesafe/Jev record")
    probabilities = suggestion.get("axisProbabilities")
    if isinstance(probabilities, dict):
        for axis, values in sorted(probabilities.items()):
            if axis not in {"regions", "functions", "purposes", "pageTypes", "contentKinds"} or not isinstance(values, list):
                raise ValueError("weak suggestion has unsupported probability axis")
            if any(not isinstance(item, dict) or not isinstance(item.get("label"), str) or isinstance(item.get("yesProbability"), bool) or not isinstance(item.get("yesProbability"), (int, float)) or not math.isfinite(item["yesProbability"]) or not 0 <= item["yesProbability"] <= 1 for item in values):
                raise ValueError("weak suggestion has invalid probability")
            result[axis] = [{"label": item["label"], "yesProbability": item["yesProbability"]} for item in values]
    choice = suggestion.get("componentTypeChoice")
    if isinstance(choice, dict) and isinstance(choice.get("distribution"), list):
        result["componentType"] = {
            "choice": choice.get("choice"),
            "confidence": choice.get("confidence"),
            "distribution": choice["distribution"],
        }
    mapped = suggestion.get("mappedLabels")
    if isinstance(mapped, dict):
        result["mappedPositiveLabels"] = {key: value for key, value in sorted(mapped.items()) if value not in ([], None)}
    return result


def run(snapshot: Path, output: Path, v2_root: Path, experiment_root: Path, grouping_input: Path) -> dict[str, Any]:
    if output.exists():
        raise ValueError("dataset output already exists; frozen outputs are immutable")
    output.mkdir(parents=True, mode=0o700)
    validate_snapshot(snapshot)
    serializer = load_serializer(experiment_root)
    page_serializer = load_page_serializer(experiment_root)
    pages = []
    for path in sorted((snapshot / "audit" / "captures").glob("page_*.json")):
        page = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(page, dict) or not isinstance(page.get("id"), str):
            raise ValueError(f"invalid snapshot capture {path}")
        pages.append(page)
    if not pages:
        raise ValueError("snapshot has no capture manifests")
    attach_groups(pages, grouping_input)
    for page in pages:
        canonical_nodes = []
        all_nodes = page.get("nodes")
        if not isinstance(all_nodes, list):
            raise ValueError(f"capture {page['id']} nodes is invalid")
        by_id = {node.get("id"): node for node in all_nodes if isinstance(node, dict) and isinstance(node.get("id"), str)}
        for node in all_nodes:
            if not isinstance(node, dict) or not isinstance(node.get("tag"), str) or not isinstance(node.get("text"), str):
                continue
            canonical_nodes.append({"tag": node["tag"].lower(), "text": node["text"], "ancestors": ancestor_tags(node, by_id)})
        page["_canonicalDomTextHash"] = "sha256:" + canonical_hash(canonical_nodes)
    component_split, split_meta = assignments(pages, prior_v2_domains(v2_root))
    page_by_id = {page["id"]: page for page in pages}
    page_split = {page["id"]: component_split[split_meta["domainToComponent"][domain_from_group(page)]] for page in pages}
    assignment_rows = [
        {
            "pageId": page["id"], "split": page_split[page["id"]], "etldPlusOne": domain_from_group(page),
            "connectedGroupId": split_meta["domainToComponent"][domain_from_group(page)],
            "contentHash": page.get("contentHash"),
            "canonicalDomTextHash": page.get("_canonicalDomTextHash"),
            "priorV2DomainOverlap": any(domain_from_group(page) == old or domain_from_group(page).endswith("." + old) for old in split_meta["oldV2Domains"]),
        }
        for page in sorted(pages, key=lambda item: item["id"])
    ]
    write_jsonl(output / "split-assignments.jsonl", assignment_rows)

    undo_path = snapshot / "audit" / "review-undos.jsonl"
    undo_rows = rows(undo_path) if undo_path.exists() else []
    annotations = effective_annotations(rows(snapshot / "audit" / "annotations.jsonl"), undo_rows)
    rejection_keys = {
        key for key, row in annotations.items()
        if row.get("decision") in {"reject", "unsure"} or row.get("boundary") != "correct"
    }
    human_by_split: dict[str, list[dict[str, Any]]] = defaultdict(list)
    human_heldout: list[dict[str, Any]] = []
    for row in rows(snapshot / "node-examples.jsonl"):
        if row.get("source") != "human" or row.get("gold") is not False:
            raise ValueError("exported human row provenance is invalid")
        capture = row.get("capture")
        if not isinstance(capture, dict) or not isinstance(capture.get("pageId"), str) or not isinstance(row.get("nodeId"), str):
            raise ValueError("exported human row is missing target identity")
        capture_hash = capture.get("captureHash") if isinstance(capture.get("captureHash"), str) else None
        key = (capture["pageId"], row["nodeId"], capture_hash)
        if key in rejection_keys or (capture["pageId"], row["nodeId"], None) in rejection_keys:
            continue
        page = page_by_id.get(capture["pageId"])
        if not page or capture.get("captureHash") != page.get("captureHash"):
            raise ValueError("human export capture hash does not exactly match snapshot")
        node = runtime_node(page, row["nodeId"])
        labels = row.get("labels")
        if not isinstance(labels, dict) or not labels:
            raise ValueError("exported human row lacks explicit labels")
        record = {
            "recordType": "node", "pageId": capture["pageId"], "nodeId": row["nodeId"], "split": page_split[capture["pageId"]],
            "input": serializer.serialize_candidate({"node": node}), "labels": labels,
            "source": "human", "gold": False, "annotationExposure": "teacher_assisted_or_unknown",
            "provenance": {"annotationId": row.get("annotationId"), "timestamp": row.get("annotationTimestamp"), "captureHash": capture.get("captureHash")},
        }
        if record["split"] == "train":
            human_by_split["train"].append(record)
        else:
            human_heldout.append({**record, "exclusionReason": "heldout_observed_silver_is_not_evaluation_gold"})

    weak_by_split: dict[str, list[dict[str, Any]]] = defaultdict(list)
    pending_by_split: dict[str, list[dict[str, Any]]] = defaultdict(list)
    diagnostics_by_split: dict[str, list[dict[str, Any]]] = defaultdict(list)
    weak_candidates: list[tuple[dict[str, Any], dict[str, Any]]] = []
    input_exclusions: list[dict[str, Any]] = []
    for suggestion in rows(snapshot / "audit" / "model-suggestions.jsonl"):
        page_id, node_id = suggestion.get("pageId"), suggestion.get("nodeId")
        page = page_by_id.get(page_id) if isinstance(page_id, str) else None
        if not page:
            input_exclusions.append({"suggestionId": suggestion.get("id"), "reason": "missing_capture"})
            continue
        if suggestion.get("captureHash") != page.get("captureHash"):
            input_exclusions.append({"suggestionId": suggestion.get("id"), "reason": "stale_capture_hash"})
            continue
        split = page_split[page_id]
        if node_id is None:
            target = weak_targets(suggestion)
            record = {"recordType": "page", "pageId": page_id, "split": split, "input": page_serializer.capture_text(page),
                      "featureSerializer": "weborganizer-capture-text-v1", "softTargets": target,
                      "source": "jev", "gold": False, "provenance": {"suggestionId": suggestion.get("id"), "modelId": suggestion.get("modelId"), "modelRevision": suggestion.get("modelRevision"), "promptRevision": suggestion.get("promptRevision"), "snapshotHash": suggestion.get("snapshotHash")}}
            if split == "train": weak_by_split["page-train"].append(record)
            elif target:
                pending_by_split[split].append({"recordType": "page", "pageId": page_id, "split": split, "input": record["input"], "featureSerializer": record["featureSerializer"], "source": "pending_human_review", "gold": False, "annotationExposure": "queue_without_teacher_output"})
                diagnostics_by_split[split].append(record)
            continue
        if not isinstance(node_id, str):
            continue
        node = runtime_node(page, node_id)
        target = weak_targets(suggestion)
        if not target:
            input_exclusions.append({"suggestionId": suggestion.get("id"), "reason": "empty_weak_target"})
            continue
        record = {"recordType": "node", "pageId": page_id, "nodeId": node_id, "split": split,
                  "input": serializer.serialize_candidate({"node": node}), "softTargets": target,
                  "source": "jev", "gold": False,
                  "provenance": {"suggestionId": suggestion.get("id"), "provider": suggestion.get("provider"), "modelId": suggestion.get("modelId"), "modelRevision": suggestion.get("modelRevision"), "promptRevision": suggestion.get("promptRevision"), "snapshotHash": suggestion.get("snapshotHash")}}
        weak_candidates.append((suggestion, record))

    # Exact same approved node input in different partitions is quarantined from
    # later partitions. This prevents text/DOM memorization without calling a
    # merely similar menu/template a shared component.
    first_split_by_input: dict[str, str] = {}
    cross_split_exclusions: list[dict[str, Any]] = []
    for suggestion, record in sorted(weak_candidates, key=lambda item: (SPLITS.index(item[1]["split"]), item[1]["pageId"], item[1]["nodeId"])):
        key = digest(record["input"])
        prior = first_split_by_input.setdefault(key, record["split"])
        if prior != record["split"]:
            cross_split_exclusions.append({"pageId": record["pageId"], "nodeId": record["nodeId"], "split": record["split"], "duplicateOfSplit": prior, "inputSha256": "sha256:" + key})
            continue
        split = record["split"]
        if split == "train":
            capture_hash = page_by_id[record["pageId"]].get("captureHash")
            if not annotation_target_matches(annotations, record["pageId"], record["nodeId"], capture_hash):
                weak_by_split["node-train"].append(record)
        else:
            capture_hash = page_by_id[record["pageId"]].get("captureHash")
            if not annotation_target_matches(annotations, record["pageId"], record["nodeId"], capture_hash):
                pending_by_split[split].append({"recordType": "node", "pageId": record["pageId"], "nodeId": record["nodeId"], "split": split, "input": record["input"], "source": "pending_human_review", "gold": False, "annotationExposure": "queue_without_teacher_output"})
            diagnostics_by_split[split].append(record)

    for key, value in weak_by_split.items(): write_jsonl(output / f"{key}-weak.jsonl", sorted(value, key=lambda row: (row["pageId"], str(row.get("nodeId")))))
    write_jsonl(output / "node-train-human.jsonl", sorted(human_by_split["train"], key=lambda row: (row["pageId"], row["nodeId"])))
    write_jsonl(output / "heldout-observed-human-silver.jsonl", sorted(human_heldout, key=lambda row: (row["split"], row["pageId"], row["nodeId"])))
    write_jsonl(output / "cross-split-node-input-exclusions.jsonl", cross_split_exclusions)
    write_jsonl(output / "excluded-inputs.jsonl", input_exclusions)
    write_jsonl(output / "page-train-human.jsonl", [])
    for split in ("validation", "test"):
        write_jsonl(output / f"{split}-pending-human-review.jsonl", sorted(pending_by_split[split], key=lambda row: (row["pageId"], str(row.get("nodeId", "")))))
        write_jsonl(output / f"{split}-provisional-diagnostic.jsonl", sorted(diagnostics_by_split[split], key=lambda row: (row["pageId"], str(row.get("nodeId")))))

    files = sorted(path for path in output.iterdir() if path.is_file())
    manifest = {
        "schemaVersion": 1, "datasetVersion": "dom-role-text-v1", "sourceSnapshot": str(snapshot),
        "sourceSnapshotManifestSha256": sha256_file(snapshot / "manifest.json"),
        "featurePolicy": {"modalities": ["text", "DOM"], "screenshotsRead": False, "nodeSerializer": getattr(serializer, "SERIALIZER_VERSION"), "nodeSerializerHash": serializer.serializer_hash(), "pageSerializer": "weborganizer-capture-text-v1", "pageSerializerLimit": page_serializer.MAX_INPUT_CHARS},
        "splitPolicy": {"assignedBeforeLabels": True, "siteKey": "eTLD+1 including subdomains", "duplicateConstraint": "exact canonical contentHash across sites is connected", "templateGuarantee": "No inferred-template holdout is claimed; exact-content and site grouping do not prove template independence.", "priorV2Policy": "Every current eTLD+1 found in v2 page provenance is forced to train, so validation/test exclude known prior-v2 site overlap."},
        "supervision": {"human": {"source": "human", "gold": False, "trainingSplitOnly": True, "evaluationGoldCount": 0, "exposure": "current accepts may be teacher-assisted; they are not blind gold"}, "weak": {"source": "jev", "soft": True, "trainingSplitOnly": True, "omittedAxes": "unobserved; never negative"}, "joinContract": "Do not concatenate human and weak files. For a shared node/axis, use human explicit labels; weak rows remain soft targets only for axes without a human observation. Rejected/unsure/bad-boundary current human targets are absent from weak training."},
        "counts": {"pages": len(pages), "sites": len({domain_from_group(page) for page in pages}), "nodeWeakTrain": len(weak_by_split["node-train"]), "pageWeakTrain": len(weak_by_split["page-train"]), "nodeHumanTrain": len(human_by_split["train"]), "heldoutObservedHumanSilver": len(human_heldout), "validationPendingHumanReview": len(pending_by_split["validation"]), "testPendingHumanReview": len(pending_by_split["test"]), "crossSplitNodeInputExclusions": len(cross_split_exclusions), "inputExclusions": len(input_exclusions), "evaluationGold": 0},
        "splitSummary": split_meta,
        "files": [{"path": path.name, "sha256": sha256_file(path)} for path in files],
    }
    write_json(output / "manifest.json", manifest)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--v2-root", type=Path, required=True)
    parser.add_argument("--experiment-root", type=Path, required=True)
    parser.add_argument("--grouping-input", type=Path, required=True)
    args = parser.parse_args()
    manifest = run(args.snapshot.resolve(), args.output.resolve(), args.v2_root.resolve(), args.experiment_root.resolve(), args.grouping_input.resolve())
    print(json.dumps(manifest["counts"], sort_keys=True))


if __name__ == "__main__":
    main()

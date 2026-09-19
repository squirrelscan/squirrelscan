#!/usr/bin/env python3
"""Aggregate raw Luna decisions while preserving a hard blind-duplicate QA gate."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path
from typing import Any

from inference import TAXONOMY, assert_private_path


def rows(path: Path) -> list[dict[str, Any]]:
    result = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if line.strip():
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{line_number} is not a JSON object")
            result.append(value)
    return result


def label_of(row: dict[str, Any]) -> str:
    value = row.get("label", row.get("finalLabel"))
    if value not in TAXONOMY:
        raise ValueError(f"unsupported Luna label {value!r}")
    return str(value)


def validate_raw(row: dict[str, Any], corpus_version: str, annotation_version: str) -> None:
    if not isinstance(row.get("candidateId"), str):
        raise ValueError("every raw Luna decision needs candidateId")
    label_of(row)
    if row.get("corpusVersion") != corpus_version or row.get("annotationVersion") != annotation_version:
        raise ValueError("raw decision corpusVersion/annotationVersion mismatch")
    if str(row.get("source", row.get("labelSource", ""))).lower() != "luna" or row.get("gold") is not False:
        raise ValueError("raw decisions must retain source=luna and gold=false")
    schema = row.get("schemaVersion")
    if not isinstance(row.get("model", row.get("modelVersion")), str) or not isinstance(row.get("promptVersion"), str) or isinstance(schema, bool) or not isinstance(schema, (str, int)):
        raise ValueError("raw decision provenance is incomplete")
    if not isinstance(row.get("annotator", row.get("annotatorId")), str) or not row.get("annotator", row.get("annotatorId")):
        raise ValueError("every raw Luna decision needs an independent annotator identifier")


def annotator_of(row: dict[str, Any]) -> str:
    return str(row.get("annotator", row.get("annotatorId")))


def packet_id_of(row: dict[str, Any]) -> str:
    packet_id = row.get("packetId", row.get("sourcePacketId"))
    if not isinstance(packet_id, str) or not packet_id:
        raise ValueError("every raw Luna decision needs packetId/sourcePacketId provenance")
    return packet_id


def context_key(row: dict[str, Any]) -> str:
    return json.dumps(row.get("context"), sort_keys=True, separators=(",", ":"))


def valid_resolution_context(value: Any) -> bool:
    """An adjudicator must choose a concrete structured context, never an implicit first review."""
    return (isinstance(value, dict) and bool(value)) or (isinstance(value, str) and bool(value.strip()))


def decision_provenance(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "packetId": packet_id_of(row),
        "annotator": annotator_of(row),
        "label": label_of(row),
        "context": row.get("context"),
        "reason": row.get("reason", row.get("rationale")),
    }


def validate_resolution(row: dict[str, Any]) -> None:
    candidate_id = row.get("candidateId")
    state = str(row.get("status", row.get("adjudicationStatus", ""))).lower()
    reason = row.get("reason", row.get("rationale"))
    if not isinstance(candidate_id, str) or label_of(row) not in TAXONOMY or state not in {"adjudicated", "resolved"}:
        raise ValueError("every adjudication needs candidateId, a taxonomy label, and explicit adjudicated/resolved status")
    if not valid_resolution_context(row.get("context")):
        raise ValueError("every adjudication needs a non-empty structured resolution context")
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError("every adjudication needs a reason")
    if not isinstance(row.get("adjudicator", row.get("annotator", row.get("annotatorId"))), str):
        raise ValueError("every adjudication needs adjudicator provenance")


def aggregate_decisions(
    grouped: dict[str, list[dict[str, Any]]],
    resolutions: dict[str, dict[str, Any]],
    corpus_version: str,
    annotation_version: str,
    expected_blind_duplicates: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    """Aggregate independent reviews without selecting a label or context by input order."""
    for resolution in resolutions.values():
        validate_resolution(resolution)
    final_rows: list[dict[str, Any]] = []
    checks: list[dict[str, Any]] = []
    conflicts: list[dict[str, Any]] = []
    duplicate_count = 0
    pair_count = label_agreements = context_agreements = combined_agreements = 0
    for candidate_id, decisions in sorted(grouped.items()):
        labels = [label_of(row) for row in decisions]
        contexts = [context_key(row) for row in decisions]
        is_duplicate = len(decisions) > 1
        provenance = [decision_provenance(row) for row in decisions]
        if is_duplicate:
            duplicate_count += 1
            annotators = [annotator_of(row) for row in decisions]
            if len(set(annotators)) != len(annotators):
                raise ValueError("blind duplicate decisions require distinct annotators")
            for left, right in combinations(decisions, 2):
                pair_count += 1
                labels_match = label_of(left) == label_of(right)
                contexts_match = context_key(left) == context_key(right)
                label_agreements += int(labels_match)
                context_agreements += int(contexts_match)
                combined_agreements += int(labels_match and contexts_match)
        consensus = len(set(labels)) == 1 and len(set(contexts)) == 1
        resolution = resolutions.get(candidate_id)
        if not consensus and resolution is None:
            conflict = {
                "candidateId": candidate_id,
                "status": "unresolved",
                "labelMismatch": len(set(labels)) != 1,
                "contextMismatch": len(set(contexts)) != 1,
                "decisions": provenance,
            }
            conflicts.append(conflict)
            checks.append({"candidateId": candidate_id, "decisionCount": len(decisions), "labels": labels, "disagreed": True, "contextMismatch": conflict["contextMismatch"], "status": "unresolved", "packetIds": [item["packetId"] for item in provenance]})
            continue
        final_label = label_of(resolution) if resolution else labels[0]
        final_context = resolution["context"] if resolution else decisions[0].get("context")
        state = str(resolution.get("status", resolution.get("adjudicationStatus"))) if resolution else ("agree" if is_duplicate else "single")
        first = decisions[0]
        final = {
            "candidateId": candidate_id,
            "label": final_label,
            "corpusVersion": corpus_version,
            "annotationVersion": annotation_version,
            "source": "luna",
            "gold": False,
            "model": str(first.get("model", first.get("modelVersion"))),
            "promptVersion": first["promptVersion"],
            "schemaVersion": first["schemaVersion"],
            "context": final_context,
            "adjudicationStatus": state,
        }
        if resolution is not None:
            final["adjudication"] = {
                "status": state,
                "reason": resolution.get("reason", resolution.get("rationale")),
                "context": final_context,
                "provenance": {
                    "adjudicator": resolution.get("adjudicator", resolution.get("annotator", resolution.get("annotatorId"))),
                    "source": resolution.get("source", resolution.get("labelSource")),
                    "model": resolution.get("model", resolution.get("modelVersion")),
                    "promptVersion": resolution.get("promptVersion"),
                    "schemaVersion": resolution.get("schemaVersion"),
                },
                "originalDecisions": provenance,
            }
        final_rows.append(final)
        if is_duplicate:
            checks.append({"candidateId": candidate_id, "decisionCount": len(decisions), "labels": labels, "disagreed": not consensus, "contextMismatch": len(set(contexts)) != 1, "status": state, "packetIds": [item["packetId"] for item in provenance]})
    extra_resolutions = sorted(set(resolutions) - set(grouped))
    if extra_resolutions:
        raise ValueError("adjudication references a candidate absent from raw Luna decisions")
    pairwise = {
        "pairCount": pair_count,
        "labelAgreement": label_agreements / pair_count if pair_count else None,
        "contextAgreement": context_agreements / pair_count if pair_count else None,
        "labelAndContextAgreement": combined_agreements / pair_count if pair_count else None,
    }
    qa = {
        "corpusVersion": corpus_version,
        "annotationVersion": annotation_version,
        "status": "passed" if not conflicts and duplicate_count >= expected_blind_duplicates else "needs-adjudication",
        "rawDecisionCount": sum(len(decisions) for decisions in grouped.values()),
        "finalAnnotationCount": len(final_rows),
        "blindDuplicateCount": duplicate_count,
        "agreementCount": sum(1 for check in checks if check["status"] == "agree"),
        "disagreementCount": sum(1 for check in checks if check["disagreed"]),
        "unresolvedConflicts": len(conflicts),
        "checks": checks,
        "blindPairwiseAgreement": pairwise["labelAgreement"],
        "pairwiseAgreement": pairwise,
        "note": "Luna-generated silver labels only; all raw reviews retain packet/context/reason provenance, and any label or context conflict requires explicit adjudication.",
    }
    return final_rows, conflicts, qa


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, action="append", required=True, help="raw Luna JSONL shard; repeat for each shard")
    parser.add_argument("--output", type=Path, required=True, help="final annotations.jsonl, written only after adjudication")
    parser.add_argument("--qa-output", type=Path, required=True)
    parser.add_argument("--conflicts-output", type=Path, required=True)
    parser.add_argument("--adjudications", type=Path, help="explicit resolutions for blind-duplicate disagreements")
    parser.add_argument("--corpus-version", required=True)
    parser.add_argument("--annotation-version", required=True)
    parser.add_argument("--expected-blind-duplicates", type=int, default=75)
    args = parser.parse_args()
    paths = [assert_private_path(path) for path in args.input]
    output, qa_output, conflicts_output = (assert_private_path(path) for path in (args.output, args.qa_output, args.conflicts_output))
    adjudications = assert_private_path(args.adjudications) if args.adjudications else None
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for path in paths:
        for row in rows(path):
            validate_raw(row, args.corpus_version, args.annotation_version)
            copied = dict(row)
            copied.setdefault("sourcePacketId", path.stem)
            grouped[str(copied["candidateId"])].append(copied)
    if not grouped:
        raise ValueError("no raw Luna decisions")
    resolutions: dict[str, dict[str, Any]] = {}
    if adjudications:
        for row in rows(adjudications):
            validate_resolution(row)
            candidate_id = str(row["candidateId"])
            if candidate_id in resolutions:
                raise ValueError("duplicate adjudication for candidate")
            resolutions[candidate_id] = row
    final_rows, conflicts, qa = aggregate_decisions(grouped, resolutions, args.corpus_version, args.annotation_version, args.expected_blind_duplicates)
    for path in (output, qa_output, conflicts_output):
        path.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as handle:
        for row in final_rows:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")
    with conflicts_output.open("w", encoding="utf-8") as handle:
        for row in conflicts:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")
    qa_output.write_text(json.dumps(qa, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"status": qa["status"], "blindDuplicateCount": qa["blindDuplicateCount"], "unresolvedConflicts": len(conflicts)}, sort_keys=True))
    return 0 if qa["status"] == "passed" else 2


if __name__ == "__main__":
    raise SystemExit(main())

"""Run and validate independent Luna DOM-labeling batches.

This utility intentionally has no heuristic fallback.  A malformed, incomplete,
or off-taxonomy Luna response is recorded as rejected and is not made available
as a silver label.  It accepts blind text/DOM packets only and stores prompts
and exact model responses in the caller's private output directory.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MODEL = "gpt-5.6-luna"
NODE_AXES = {"regions", "purposes", "componentType"}
PAGE_AXES = {"pageTypes", "contentKinds"}


def sha256_text(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode()).hexdigest()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows))


def load_taxonomy(path: Path) -> tuple[str, dict[str, set[str]]]:
    value = json.loads(path.read_text())
    revision = value.get("taxonomyRevision")
    allowed = value.get("allowedLabels")
    axes = {"regions", "purposes", "componentTypes", "pageTypes", "contentKinds"}
    if not isinstance(revision, str) or not isinstance(allowed, dict) or set(allowed) != axes:
        raise ValueError("taxonomy must provide a revision and complete allowedLabels")
    result: dict[str, set[str]] = {}
    for axis in axes:
        labels = allowed[axis]
        if not isinstance(labels, list) or not labels or not all(isinstance(label, str) for label in labels):
            raise ValueError(f"taxonomy allowedLabels.{axis} must be a non-empty string list")
        result[axis] = set(labels)
    return revision, result


def source_identity(packet: dict[str, Any]) -> tuple[str, str, str | None, str]:
    record_type = packet.get("recordType")
    if record_type not in {"node", "page"}:
        raise ValueError("packet recordType must be node or page")
    page_id, node_id, capture_hash = packet.get("pageId"), packet.get("nodeId"), packet.get("captureHash")
    if not isinstance(page_id, str) or not isinstance(capture_hash, str):
        raise ValueError("packet must include pageId and captureHash")
    if record_type == "node" and not isinstance(node_id, str):
        raise ValueError("node packet must include nodeId")
    if record_type == "page" and node_id is not None:
        raise ValueError("page packet nodeId must be null or omitted")
    return record_type, page_id, node_id, capture_hash


def validate_packet(packet: dict[str, Any], revision: str) -> None:
    if not isinstance(packet.get("packetId"), str) or not packet["packetId"]:
        raise ValueError("packet needs packetId")
    source_identity(packet)
    if not isinstance(packet.get("input"), str) or not packet["input"]:
        raise ValueError("packet needs text/DOM input")
    if packet.get("inputSha256") != sha256_text(packet["input"]):
        raise ValueError("packet inputSha256 does not bind its input")
    if packet.get("taxonomyRevision") != revision:
        raise ValueError("packet taxonomyRevision does not match the frozen taxonomy")
    if packet.get("split") not in {"train", "validation", "test"}:
        raise ValueError("packet split must be frozen before labeling")


def compact_packet_key(packet: dict[str, Any]) -> str:
    """A short, deterministic model-facing key; full identity remains local."""
    material = "\0".join(str(value) for value in (
        packet["packetId"], *source_identity(packet), packet["inputSha256"],
    ))
    return "pkt_" + hashlib.sha256(material.encode()).hexdigest()[:12]


def blind_packet(packet: dict[str, Any]) -> dict[str, Any]:
    return {
        "packetKey": compact_packet_key(packet),
        "recordType": packet["recordType"],
        "input": packet["input"],
    }


def response_schema(
    batch: list[dict[str, Any]], revision: str, allowed: dict[str, set[str]]
) -> dict[str, Any]:
    observation = {"anyOf": [
        {"type": "object", "additionalProperties": False,
         "required": ["axis", "complete", "labels"],
         "properties": {
             "axis": {"type": "string", "const": axis},
             "complete": {"type": "boolean"},
             "labels": {"type": "array", "items": {"type": "string", "enum": sorted(allowed["componentTypes" if axis == "componentType" else axis])}},
         }} for axis in sorted(NODE_AXES | PAGE_AXES)
    ]}
    return {
        "type": "object", "additionalProperties": False,
        "required": ["records"],
        "properties": {
            "records": {
                "type": "array", "minItems": len(batch), "maxItems": len(batch),
                "items": {
                    "type": "object", "additionalProperties": False,
                    "required": ["packetKey", "source", "gold", "model", "labelingMethod", "taxonomyRevision", "evidence", "observations"],
                    "properties": {
                        "packetKey": {"type": "string", "enum": [compact_packet_key(packet) for packet in batch]},
                        "source": {"type": "string", "const": "luna"}, "gold": {"type": "boolean", "const": False},
                        "model": {"type": "string", "const": MODEL}, "labelingMethod": {"type": "string", "const": "independent_reasoned_review"},
                        "taxonomyRevision": {"type": "string", "const": revision}, "evidence": {"type": "string", "minLength": 1, "maxLength": 800},
                        "observations": {"type": "array", "items": observation},
                    },
                },
            },
        },
    }

def prompt_for(batch: list[dict[str, Any]], revision: str, allowed: dict[str, set[str]]) -> str:
    public_taxonomy = {axis: sorted(values) for axis, values in allowed.items()}
    return """You are Luna, an independent DOM-labeling reviewer. Return JSON only as an object with a `records` array. Do not use tools, browse, or infer unavailable visual details. Every output must correspond to exactly one blind packet and preserve its packetKey exactly. Do not emit IDs, hashes, URLs, selectors, or any source metadata beyond the fields requested. Set source exactly `luna`, gold exactly false, model exactly `gpt-5.6-luna`, labelingMethod exactly `independent_reasoned_review`, taxonomyRevision exactly `%s`, and include a concise evidence string grounded only in packet input.

For node packets only use observations with axis regions, purposes, componentType. For page packets only use pageTypes, contentKinds. Each observation is `{\"axis\": string, \"complete\": boolean, \"labels\": string[]}`. Omit an axis when the packet cannot support a judgment. When an axis is observed and the packet is sufficient to decide its full allowed-label set, set complete true; do not default to incomplete. A complete multi-label axis may have an empty labels list only when the packet is sufficient to rule out every allowed label. Set complete false only for a bounded positive claim whose negatives cannot be decided. Incomplete labels are positive claims only and never imply negatives. `unknown`, when used, must be the only label for that axis. componentType must have exactly one label whenever observed. Use only these literal labels:
%s

Blind packets:
%s
""" % (
        revision,
        json.dumps(public_taxonomy, sort_keys=True),
        json.dumps([blind_packet(packet) for packet in batch], sort_keys=True),
    )

def validate_record(record: dict[str, Any], packet: dict[str, Any], revision: str, allowed: dict[str, set[str]]) -> dict[str, Any]:
    if record.get("packetKey") != compact_packet_key(packet):
        raise ValueError("response packetKey does not match its blind packet")
    if (
        record.get("source") != "luna"
        or record.get("gold") is not False
        or record.get("model") != MODEL
        or record.get("labelingMethod") != "independent_reasoned_review"
        or record.get("taxonomyRevision") != revision
    ):
        raise ValueError("response provenance is invalid")
    evidence = record.get("evidence")
    if not isinstance(evidence, str) or not evidence.strip() or len(evidence) > 800:
        raise ValueError("response needs bounded evidence")
    observations = record.get("observations")
    if not isinstance(observations, list):
        raise ValueError("response observations must be an array")
    allowed_axes = NODE_AXES if packet["recordType"] == "node" else PAGE_AXES
    axes: dict[str, dict[str, Any]] = {}
    for observation in observations:
        if not isinstance(observation, dict) or set(observation) != {"axis", "complete", "labels"}:
            raise ValueError("each observation must contain axis, complete and labels")
        axis = observation["axis"]
        if axis not in allowed_axes or axis in axes:
            raise ValueError("response contains a duplicate or invalid axis for this record type")
        axes[axis] = {"complete": observation["complete"], "labels": observation["labels"]}
    axis_vocab = {axis: axis for axis in allowed_axes}
    axis_vocab["componentType"] = "componentTypes"
    for axis, observation in axes.items():
        if not isinstance(observation["complete"], bool) or not isinstance(observation["labels"], list):
            raise ValueError(f"{axis} observation is malformed")
        labels = observation["labels"]
        if not all(isinstance(label, str) for label in labels) or len(labels) != len(set(labels)):
            raise ValueError(f"{axis} labels must be unique strings")
        if any(label not in allowed[axis_vocab[axis]] for label in labels):
            raise ValueError(f"{axis} contains an off-taxonomy label")
        if "unknown" in labels and labels != ["unknown"]:
            raise ValueError(f"{axis} unknown must stand alone")
        if axis == "componentType" and len(labels) != 1:
            raise ValueError("componentType must have one observed label")
    materialized = dict(record)
    materialized.pop("packetKey")
    materialized.pop("observations")
    materialized["observedAxes"] = axes
    for key in ("packetId", "recordType", "pageId", "nodeId", "captureHash", "inputSha256", "input", "split"):
        materialized[key] = packet.get(key)
    return materialized


def validated_batch_records(
    response_text: str,
    batch: list[dict[str, Any]],
    revision: str,
    allowed: dict[str, set[str]],
    prompt: str,
    number: int,
) -> list[dict[str, Any]]:
    """Return a complete validated response or raise without accepting any row."""
    # Codex CLI may prefix a final-message file with its speaker label. This is
    # transport framing only; preserve the exact raw response hash for audit.
    json_start = response_text.find("{")
    if json_start < 0:
        raise ValueError("response does not contain JSON")
    response = json.loads(response_text[json_start:])
    rows = response["records"] if isinstance(response, dict) else None
    if not isinstance(rows, list) or len(rows) != len(batch):
        raise ValueError("response must contain exactly one record per packet")
    by_key = {row.get("packetKey"): row for row in rows if isinstance(row, dict)}
    expected_keys = {compact_packet_key(packet) for packet in batch}
    if len(by_key) != len(rows) or set(by_key) != expected_keys:
        raise ValueError("response packet keys do not exactly match the batch")
    validated: list[dict[str, Any]] = []
    for packet in batch:
        row = validate_record(by_key[compact_packet_key(packet)], packet, revision, allowed)
        row = dict(row)
        row["lunaRun"] = {
            "promptSha256": sha256_text(prompt),
            "responseSha256": sha256_text(response_text),
            "batch": number,
            "recordedAt": datetime.now(timezone.utc).isoformat(),
        }
        validated.append(row)
    return validated


def run_batch(prompt: str, output_path: Path, schema_path: Path) -> str:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "codex", "exec", "-m", MODEL, "--ephemeral", "--ignore-user-config",
        "--skip-git-repo-check", "-s", "read-only", "--output-schema", str(schema_path), "--output-last-message", str(output_path), "-",
    ]
    completed = subprocess.run(
        command,
        input=prompt,
        text=True,
        cwd="/tmp",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    (output_path.parent / (output_path.stem + ".log")).write_text(completed.stdout)
    if completed.returncode != 0 or not output_path.exists():
        raise RuntimeError(f"Luna command failed with exit status {completed.returncode}")
    return output_path.read_text()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--packets", type=Path, required=True)
    parser.add_argument("--taxonomy", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runs-dir", type=Path, required=True)
    parser.add_argument("--batch-size", type=int, default=20)
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 40:
        raise ValueError("batch-size must be between 1 and 40")
    revision, allowed = load_taxonomy(args.taxonomy)
    packets = read_jsonl(args.packets)
    for packet in packets:
        validate_packet(packet, revision)
    if len({packet["packetId"] for packet in packets}) != len(packets):
        raise ValueError("packetId values must be unique")
    if len({compact_packet_key(packet) for packet in packets}) != len(packets):
        raise ValueError("derived packet keys must be unique")
    prior = read_jsonl(args.output) if args.output.exists() else []
    completed_ids = {row.get("packetId") for row in prior}
    accepted = list(prior)
    rejected: list[dict[str, Any]] = []
    for number, start in enumerate(range(0, len(packets), args.batch_size), 1):
        batch = [packet for packet in packets[start : start + args.batch_size] if packet["packetId"] not in completed_ids]
        if not batch:
            continue
        prompt = prompt_for(batch, revision, allowed)
        batch_dir = args.runs_dir / f"batch-{number:04d}"
        batch_dir.mkdir(parents=True, exist_ok=True)
        (batch_dir / "prompt.txt").write_text(prompt)
        schema_path = batch_dir / "response-schema.json"
        schema_path.write_text(json.dumps(response_schema(batch, revision, allowed), indent=2, sort_keys=True) + "\n")
        response_text = run_batch(prompt, batch_dir / "response.json", schema_path)
        try:
            # A response is all-or-nothing: an invalid sibling cannot leave a
            # partial batch of labels that appears complete to a later resume.
            validated = validated_batch_records(response_text, batch, revision, allowed, prompt, number)
            accepted.extend(validated)
            completed_ids.update(packet["packetId"] for packet in batch)
        except Exception as error:
            rejected.append({
                "batch": number,
                "packetIds": [packet["packetId"] for packet in batch],
                "reason": str(error),
                "promptSha256": sha256_text(prompt),
                "responseSha256": sha256_text(response_text),
            })
        write_jsonl(args.output, accepted)
        write_jsonl(args.runs_dir / "rejected-batches.jsonl", rejected)
    print(json.dumps({"accepted": len(accepted), "rejectedBatches": len(rejected)}, sort_keys=True))


if __name__ == "__main__":
    main()

"""Leakage-safe text/DOM data adapter for the DOM-role experiment.

The model input is deliberately reconstructed from fields available while the
DOM is resident: the node tag, its bounded ancestor tag path, and bounded node
text.  Candidate IDs and split metadata are bookkeeping only and never enter
the serialized input.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
import os
from pathlib import Path
from typing import Any, Iterable

TAXONOMY = (
    "site_header", "footer", "navigation", "main_content", "article_header",
    "card", "aside", "form", "consent_banner", "unknown",
)
SERIALIZER_VERSION = "runtime-dom-text-v1"
DEFAULT_ROOT = Path(os.environ.get("DOM_CLASSIFIER_DATA_ROOT", ".")) / "2026-09-18" / "v2"
_URL = re.compile(r"(?:https?://|www\.)\S+", re.I)
_EMAIL = re.compile(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b")
_SPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class TextExample:
    """One example; labels are a single reviewed legacy role for v2 data."""

    input_text: str
    labels: tuple[str, ...]
    split: str
    candidate_id: str
    label_source: str = "luna"
    gold: bool = False


@dataclass(frozen=True)
class TextDataset:
    splits: dict[str, tuple[TextExample, ...]]
    serializer_version: str = SERIALIZER_VERSION
    corpus_version: str = "dom-regions-v2"
    annotation_version: str = "dom-role-v2"

    def as_training_rows(self) -> dict[str, list[dict[str, Any]]]:
        """Return model-ready rows without IDs, provenance, or split metadata."""
        return {
            split: [{"text": row.input_text, "labels": list(row.labels)} for row in rows]
            for split, rows in self.splits.items()
        }


def _jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"{path}:{line_no} must contain an object")
        rows.append(value)
    return rows


def _bounded_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    value = _URL.sub("[url]", value)
    value = _EMAIL.sub("[email]", value)
    value = _SPACE.sub(" ", value).strip()
    return value[:limit]


def serialize_candidate(candidate: dict[str, Any], *, text_limit: int = 512, ancestor_limit: int = 8) -> str:
    """Serialize runtime-safe DOM evidence deterministically.

    Only direct DOM shape and bounded visible text are allowed.  In particular,
    this intentionally ignores URL/domain, IDs, selectors, classes, weak hints,
    labels, predictions, geometry, timestamps, and page provenance.
    """
    node = candidate.get("node")
    if not isinstance(node, dict):
        raise ValueError("candidate.node must be an object")
    tag = node.get("tag")
    if not isinstance(tag, str) or not tag.strip():
        raise ValueError("candidate.node.tag must be a non-empty string")
    ancestors = node.get("ancestorTags", [])
    if not isinstance(ancestors, list) or any(not isinstance(item, str) for item in ancestors):
        raise ValueError("candidate.node.ancestorTags must be a list of strings")
    path = ">".join(item.strip().lower() for item in ancestors[-ancestor_limit:] if item.strip())
    text = _bounded_text(node.get("text"), text_limit)
    if "text" not in node:
        raise ValueError("candidate.node.text must be present")
    return f"{SERIALIZER_VERSION}\ntag={tag.strip().lower()}\nancestors={path}\ntext={text or '[empty]'}"


def serializer_hash() -> str:
    config = {"version": SERIALIZER_VERSION, "textLimit": 512, "ancestorLimit": 8, "fields": ["tag", "ancestorTags", "text"], "redactions": ["url", "email"]}
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()[:16]


def _validate_manifest(root: Path, manifest: dict[str, Any]) -> tuple[str, str]:
    corpus = manifest.get("corpusVersion")
    annotation = manifest.get("annotationVersion", manifest.get("annotationVersionExpected"))
    if not isinstance(corpus, str) or not isinstance(annotation, str):
        raise ValueError("manifest must declare corpusVersion and annotationVersion")
    if manifest.get("annotation", {}).get("goldLabelsPresent") is True:
        raise ValueError("gold labels are outside this silver-label adapter")
    return corpus, annotation


def _frozen_assignments(root: Path, groups: list[dict[str, Any]], corpus: str, annotation: str) -> dict[str, str]:
    manifest = json.loads((root / "training" / "split-manifest.json").read_text(encoding="utf-8"))
    if manifest.get("corpusVersion") != corpus or manifest.get("annotationVersion") != annotation:
        raise ValueError("frozen split manifest version mismatch")
    rows = manifest.get("assignments")
    if not isinstance(rows, list):
        raise ValueError("frozen split manifest assignments must be an array")
    group_by_candidate = {row.get("candidateId"): row for row in groups}
    if len(group_by_candidate) != len(groups) or None in group_by_candidate:
        raise ValueError("split-groups must have unique candidate IDs")
    assignments: dict[str, str] = {}
    seen_candidates: set[str] = set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("candidateId"), str):
            raise ValueError("malformed frozen split assignment")
        candidate_id = row["candidateId"]
        if candidate_id in seen_candidates:
            raise ValueError("frozen split manifest repeats a candidate")
        seen_candidates.add(candidate_id)
        group = group_by_candidate.get(candidate_id)
        if group is None or row.get("splitGroupId") != group.get("splitGroupId") or row.get("templateFamilyId") != group.get("templateFamilyId"):
            raise ValueError("frozen assignment does not match split-groups")
        split = row.get("split")
        if split not in {"train", "validation", "test"}:
            raise ValueError("unsupported split")
        group_id = str(group["splitGroupId"])
        prior = assignments.setdefault(group_id, split)
        if prior != split:
            raise ValueError("connected split group crosses partitions")
    if set(assignments) != {str(row["splitGroupId"]) for row in groups}:
        raise ValueError("frozen assignments do not cover all split groups")
    result = {candidate_id: assignments[str(group["splitGroupId"])] for candidate_id, group in group_by_candidate.items()}
    for field in ("siteId", "templateFamilyId"):
        by_value: dict[str, str] = {}
        for row in groups:
            value = row.get(field)
            split = result[str(row["candidateId"])]
            prior = by_value.setdefault(str(value), split)
            if prior != split:
                raise ValueError(f"{field} crosses frozen partitions")
    return result


def load_v2(root: Path = DEFAULT_ROOT) -> TextDataset:
    """Load v2 candidates and reviewed Luna labels using its frozen split."""
    root = root.expanduser().resolve()
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    corpus, annotation = _validate_manifest(root, manifest)
    qa_path = root / "labels" / "qa-summary.json"
    if not qa_path.is_file():
        raise ValueError("v2 QA summary is required")
    qa = json.loads(qa_path.read_text(encoding="utf-8"))
    if str(qa.get("status", "")).lower() not in {"passed", "final"} or qa.get("unresolvedConflicts") != 0:
        raise ValueError("v2 QA summary is not passed/final with zero unresolved conflicts")
    candidates = _jsonl(root / "candidates.jsonl")
    groups = _jsonl(root / "split-groups.jsonl")
    by_id: dict[str, dict[str, Any]] = {}
    for candidate in candidates:
        candidate_id = candidate.get("candidateId")
        if not isinstance(candidate_id, str) or candidate_id in by_id:
            raise ValueError("candidates must have unique candidateId")
        by_id[candidate_id] = candidate
    candidate_splits = _frozen_assignments(root, groups, corpus, annotation)
    rows: list[TextExample] = []
    seen: set[str] = set()
    for label in _jsonl(root / "labels" / "annotations.jsonl"):
        candidate_id = label.get("candidateId")
        role = label.get("label", label.get("finalLabel"))
        if not isinstance(candidate_id, str) or candidate_id not in by_id:
            raise ValueError("label references an unknown candidate")
        if candidate_id in seen:
            raise ValueError("duplicate reviewed label")
        if label.get("corpusVersion") != corpus or label.get("annotationVersion") != annotation:
            raise ValueError("label version mismatch")
        if label.get("source") != "luna" or label.get("gold") is not False:
            raise ValueError("only explicit Luna silver labels are accepted")
        if role not in TAXONOMY:
            raise ValueError(f"unsupported role {role!r}")
        seen.add(candidate_id)
        rows.append(TextExample(serialize_candidate(by_id[candidate_id]), (role,), candidate_splits[candidate_id], candidate_id))
    if not rows:
        raise ValueError("no reviewed labels found")
    return TextDataset({split: tuple(row for row in rows if row.split == split) for split in ("train", "validation", "test")}, corpus_version=corpus, annotation_version=annotation)


def load_positive_only_export(root: Path, captures_dir: Path | None = None) -> list[dict[str, Any]]:
    """Load modern reviewed node rows while preserving absent axes as unknown.

    This is intentionally separate from the legacy single-role task.  A missing
    axis is unobserved and therefore never emitted as a negative label.
    """
    root = root.expanduser().resolve()
    captures_dir = (captures_dir or root / "audit" / "captures").expanduser().resolve()
    captures: dict[str, dict[str, Any]] = {}
    if captures_dir.is_dir():
        for path in sorted(captures_dir.glob("page_*.json")):
            page = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(page, dict) and isinstance(page.get("id"), str):
                captures[page["id"]] = page
    rows = _jsonl(root / "node-examples.jsonl")
    result: list[dict[str, Any]] = []
    for row in rows:
        if row.get("source") != "human" or row.get("gold") is not False:
            raise ValueError("reviewed export rows must be human silver labels")
        labels = row.get("labels")
        if not isinstance(labels, dict) or not labels:
            raise ValueError("reviewed row needs at least one explicit axis")
        node = dict(row.get("node", {}))
        capture = row.get("capture", {})
        page = captures.get(capture.get("pageId")) if isinstance(capture, dict) else None
        if page is not None:
            capture_nodes = {item.get("id"): item for item in page.get("nodes", []) if isinstance(item, dict)}
            captured = capture_nodes.get(row.get("nodeId"))
            if isinstance(captured, dict):
                # Text is runtime DOM evidence. Selector/URL/IDs stay out of the
                # serialized candidate, while parent links reconstruct ancestry.
                node.setdefault("text", captured.get("text", ""))
                ancestors: list[str] = []
                current = captured
                while isinstance(current, dict) and len(ancestors) < 8:
                    tag = current.get("tag")
                    if isinstance(tag, str):
                        ancestors.append(tag)
                    current = capture_nodes.get(current.get("parentId"))
                node.setdefault("ancestorTags", list(reversed(ancestors[1:])))
        result.append({"text": serialize_candidate({"node": node}), "labels": labels, "supervision": "positive_only"})
    return result

#!/usr/bin/env python3
"""Fit and evaluate a leakage-safe local DOM-role baseline from a final corpus only."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from time import perf_counter
from typing import Any

from inference import PRIVATE_ROOT, TAXONOMY, assert_private_path, candidate_features, semantic_heuristic


EXPERIMENT_LIMITATIONS = [
    "Fixed DOM region containers only; paragraph, link, and arbitrary-element candidates were not evaluated.",
    "The 48 template families are a coarse count-based proxy, so this is domain-held-out with heuristic template grouping rather than robust template holdout.",
    "The deduplication fingerprint includes copied context/path information and is not a pure structural deduplication guarantee.",
    "The v2 sample is an unstratified one-page-per-domain selection; six selected pages had no eligible candidate.",
    "Results measure agreement with adjudicated Luna silver labels, not human gold labels; duplicate-review pairwise label agreement was 69.3%.",
    "Held-out support is too small for automatic merging: unknown recall was 1/5, aside recall was 0/1, and there were no held-out form or consent-banner examples (with one consent-banner training example).",
    "This offline experiment has no production integration. Production identity must continue to require direct DOM evidence.",
]


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"{path}:{index} must be a JSON object")
        rows.append(value)
    return rows


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_final_manifest(manifest: dict[str, Any], requested_version: str, annotation_version: str) -> None:
    actual_version = manifest.get("corpusVersion")
    if not isinstance(actual_version, str) or actual_version != requested_version:
        raise ValueError("--corpus-version must exactly match manifest.json corpusVersion")
    version = actual_version.lower()
    if "pilot" in version or version.endswith("v1") or "-v1" in version:
        raise ValueError("only an explicit final corpus version is trainable; pilot/v1 corpora are rejected")
    if manifest.get("annotationVersion", manifest.get("annotationVersionExpected")) != annotation_version:
        raise ValueError("--annotation-version must exactly match manifest.json annotationVersion")


def require_qa(qa: dict[str, Any], corpus_version: str, annotation_version: str, required_duplicates: int) -> None:
    if qa.get("corpusVersion") != corpus_version:
        raise ValueError("qa-summary corpusVersion does not match the requested final corpus")
    if qa.get("annotationVersion") != annotation_version:
        raise ValueError("qa-summary annotationVersion does not match the requested final annotations")
    if str(qa.get("status", "")).lower() not in {"passed", "final"}:
        raise ValueError("qa-summary must have status=passed after adjudication")
    count = qa.get("blindDuplicateCount", qa.get("blindDuplicates"))
    if not isinstance(count, int) or count < required_duplicates:
        raise ValueError(f"qa-summary must document at least {required_duplicates} blind duplicates")
    unresolved = qa.get("unresolvedConflicts")
    if unresolved != 0:
        raise ValueError("unresolved label conflicts block training")
    checks = qa.get("checks", qa.get("duplicates", []))
    if not isinstance(checks, list):
        raise ValueError("qa-summary checks must be an array")
    for check in checks:
        if not isinstance(check, dict):
            raise ValueError("qa-summary check must be an object")
        state = str(check.get("status", "")).lower()
        if state in {"unresolved", "pending", "conflict"}:
            raise ValueError("a blind-duplicate disagreement is unresolved; it cannot be auto-accepted")
        disagreed = check.get("disagreed", check.get("agreement") is False)
        if disagreed and state not in {"adjudicated", "resolved"}:
            raise ValueError("a blind-duplicate disagreement needs an explicit adjudicated/resolved status")


def normalize_label(row: dict[str, Any], corpus_version: str, annotation_version: str) -> str:
    label = row.get("finalLabel", row.get("label"))
    if label not in TAXONOMY:
        raise ValueError(f"unsupported or missing label {label!r}")
    if row.get("corpusVersion") != corpus_version:
        raise ValueError("every label must carry the exact final corpusVersion")
    if row.get("annotationVersion") != annotation_version:
        raise ValueError("every label must carry the exact annotationVersion")
    if row.get("gold") is not False:
        raise ValueError("Luna silver labels must explicitly say gold=false")
    if str(row.get("source", row.get("labelSource", ""))).lower() != "luna":
        raise ValueError("only final Luna label records are accepted by this silver-label experiment")
    if not isinstance(row.get("model", row.get("modelVersion")), str):
        raise ValueError("each label needs Luna model/version provenance")
    schema = row.get("schemaVersion")
    if not isinstance(row.get("promptVersion"), str) or isinstance(schema, bool) or not isinstance(schema, (str, int)):
        raise ValueError("each label needs promptVersion and schemaVersion provenance")
    return str(label)


def canonical_signature(candidate: dict[str, Any]) -> str:
    node = candidate.get("node", {})
    # This is only a leakage guard, never a model feature. It catches the same
    # extracted candidate being placed in different split groups.
    stable = {key: node.get(key) for key in ("shapeFingerprint", "text", "tag", "context", "ancestorTags")}
    return hashlib.sha256(json.dumps(stable, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def prepare_records(
    candidates: list[dict[str, Any]], labels: list[dict[str, Any]], groups: list[dict[str, Any]], corpus_version: str, annotation_version: str,
) -> list[dict[str, Any]]:
    by_candidate: dict[str, dict[str, Any]] = {}
    for candidate in candidates:
        candidate_id = candidate.get("candidateId")
        if not isinstance(candidate_id, str) or candidate_id in by_candidate:
            raise ValueError("candidates.jsonl must contain unique candidateId values")
        by_candidate[candidate_id] = candidate
    group_by_candidate: dict[str, dict[str, Any]] = {}
    for group in groups:
        candidate_id = group.get("candidateId")
        if not isinstance(candidate_id, str) or candidate_id in group_by_candidate:
            raise ValueError("split-groups.jsonl must contain one entry per candidate")
        if not isinstance(group.get("splitGroupId"), str) or not isinstance(group.get("siteId"), str) or not isinstance(group.get("templateFamilyId"), str):
            raise ValueError("each split-group entry needs splitGroupId, siteId, and templateFamilyId")
        group_by_candidate[candidate_id] = group

    records: list[dict[str, Any]] = []
    seen_labels: set[str] = set()
    for row in labels:
        candidate_id = row.get("candidateId")
        if not isinstance(candidate_id, str) or candidate_id not in by_candidate:
            raise ValueError("a label references a candidate absent from candidates.jsonl")
        if candidate_id in seen_labels:
            raise ValueError("labels.jsonl must contain one final adjudicated label per candidate; retain blind reviews only in QA")
        seen_labels.add(candidate_id)
        candidate = by_candidate[candidate_id]
        group = group_by_candidate.get(candidate_id)
        if group is None:
            raise ValueError("a labeled candidate is missing its frozen split-group entry")
        if candidate.get("siteId") != group.get("siteId"):
            raise ValueError("candidate and split-group siteId disagree")
        records.append({"candidate": candidate, "label": normalize_label(row, corpus_version, annotation_version), "group": group})

    if not records:
        raise ValueError("no final labels supplied")
    # Connected groups are expected to have been built before labels. Validate the
    # promised domain/template edges, then reject any exact candidate across groups.
    group_for_site: dict[str, str] = {}
    group_for_template: dict[str, str] = {}
    group_for_signature: dict[str, str] = {}
    for record in records:
        group_id = str(record["group"]["splitGroupId"])
        site_id = str(record["group"]["siteId"])
        template_id = str(record["group"]["templateFamilyId"])
        for key, value, seen in (("site", site_id, group_for_site), ("template", template_id, group_for_template), ("duplicate", canonical_signature(record["candidate"]), group_for_signature)):
            prior = seen.setdefault(value, group_id)
            if prior != group_id:
                raise ValueError(f"{key} linkage crosses split groups; regenerate split-groups.jsonl before fitting")
    return records


def validate_group_rows(candidates: list[dict[str, Any]], groups: list[dict[str, Any]]) -> None:
    """Validate grouping before labels exist, so labels cannot influence the split."""
    candidate_by_id = {row.get("candidateId"): row for row in candidates}
    if len(candidate_by_id) != len(candidates) or None in candidate_by_id:
        raise ValueError("candidates.jsonl must contain unique candidateId values")
    if len({row.get("candidateId") for row in groups}) != len(groups):
        raise ValueError("split-groups.jsonl must contain one entry per candidate")
    if set(candidate_by_id) != {row.get("candidateId") for row in groups}:
        raise ValueError("split-groups.jsonl must cover exactly the candidates.jsonl candidate IDs")
    seen_site: dict[str, str] = {}
    seen_template: dict[str, str] = {}
    seen_signature: dict[str, str] = {}
    for row in groups:
        candidate_id = row["candidateId"]
        candidate = candidate_by_id[candidate_id]
        for key in ("siteId", "templateFamilyId", "splitGroupId"):
            if not isinstance(row.get(key), str):
                raise ValueError(f"split-groups entry missing {key}")
        if candidate.get("siteId") != row["siteId"]:
            raise ValueError("candidate and split-group siteId disagree")
        for kind, value, seen in (("site", row["siteId"], seen_site), ("template", row["templateFamilyId"], seen_template), ("duplicate", canonical_signature(candidate), seen_signature)):
            prior = seen.setdefault(value, row["splitGroupId"])
            if prior != row["splitGroupId"]:
                raise ValueError(f"{kind} linkage crosses split groups; regenerate split-groups.jsonl before fitting")


def validate_group_manifest(groups: list[dict[str, Any]]) -> None:
    """Validate only public split metadata when freezing before annotation completes."""
    if not groups:
        raise ValueError("split-groups.jsonl must not be empty")
    candidate_ids: set[str] = set()
    for row in groups:
        for key in ("candidateId", "siteId", "templateFamilyId", "splitGroupId"):
            if not isinstance(row.get(key), str) or not row[key]:
                raise ValueError(f"split-groups entry missing {key}")
        candidate_id = str(row["candidateId"])
        if candidate_id in candidate_ids:
            raise ValueError("split-groups.jsonl must contain one entry per candidate")
        candidate_ids.add(candidate_id)


def allocate_splits(groups: list[dict[str, Any]], seed: int) -> dict[str, str]:
    """Deterministically freeze connected groups before labels or estimators are read."""
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in groups:
        grouped[str(row["splitGroupId"])].append(row)
    if len(grouped) < 3:
        raise ValueError("at least three connected domain/template groups are required for train/validation/test")
    targets = {"train": 0.70, "validation": 0.15, "test": 0.15}
    assigned: dict[str, str] = {}
    sizes = Counter()
    total_rows = len(groups)
    ordered = sorted(grouped, key=lambda group_id: (-len(grouped[group_id]), hashlib.sha256(f"{seed}:{group_id}".encode()).hexdigest()))
    # Seed with one group per partition, then greedily minimise row-count error.
    # The only inputs are group IDs, group sizes, and the public seed.
    seed_order = ("train", "validation", "test")
    for split, group_id in zip(seed_order, ordered[:3]):
        assigned[group_id] = split
        sizes[split] += len(grouped[group_id])
    for group_id in ordered[3:]:
        group_size = len(grouped[group_id])
        split = min(
            targets,
            key=lambda name: (
                sum(
                    abs((sizes[partition] + (group_size if partition == name else 0)) - targets[partition] * total_rows)
                    for partition in targets
                ),
                name,
            ),
        )
        assigned[group_id] = split
        sizes[split] += len(grouped[group_id])
    return assigned


def validate_partition_support(records: list[dict[str, Any]], assignments: dict[str, str]) -> dict[str, Any]:
    counts = {split: Counter(record["label"] for record in records if assignments[str(record["group"]["splitGroupId"])] == split) for split in ("train", "validation", "test")}
    if any(sum(counts[split].values()) == 0 for split in counts):
        raise ValueError("every split must contain records")
    if len(counts["train"]) < 2:
        raise ValueError("training split needs at least two observed classes")
    train_classes = set(counts["train"])
    return {
        split: {
            "records": sum(counts[split].values()),
            "classCounts": dict(sorted(counts[split].items())),
            "observedClasses": sorted(counts[split]),
            "missingTaxonomyClasses": [label for label in TAXONOMY if label not in counts[split]],
            "classesUnseenInTrain": sorted(set(counts[split]) - train_classes),
        }
        for split in counts
    }


def split_manifest(groups: list[dict[str, Any]], assignments: dict[str, str], corpus_version: str, annotation_version: str, seed: int, correction: dict[str, Any] | None = None) -> dict[str, Any]:
    rows = []
    for group in groups:
        rows.append({
            "candidateId": group["candidateId"],
            "splitGroupId": group["splitGroupId"],
            "templateFamilyId": group["templateFamilyId"],
            "split": assignments[str(group["splitGroupId"])],
        })
    partition_rows = Counter(row["split"] for row in rows)
    partition_groups = Counter(assignments.values())
    result = {
        "schemaVersion": 1,
        "corpusVersion": corpus_version,
        "annotationVersion": annotation_version,
        "seed": seed,
        "grouping": "connected registrable-domain and detected-template groups supplied by split-groups.jsonl before labels",
        "allocation": "deterministic group-size-only 70/15/15 target; no labels, candidates, or outcomes consulted",
        "partitionRows": dict(sorted(partition_rows.items())),
        "partitionGroups": dict(sorted(partition_groups.items())),
        "assignments": rows,
    }
    if correction is not None:
        result["correction"] = correction
    return result


def load_frozen_assignments(
    frozen: dict[str, Any], groups: list[dict[str, Any]], corpus_version: str, annotation_version: str, seed: int,
) -> dict[str, str]:
    """Accept only the exact deterministic group assignment frozen before labels."""
    if isinstance(frozen.get("schemaVersion"), bool) or frozen.get("schemaVersion") != 1:
        raise ValueError("split-manifest schemaVersion must be integer 1")
    if frozen.get("corpusVersion") != corpus_version or frozen.get("annotationVersion") != annotation_version:
        raise ValueError("split-manifest corpus/annotation version does not match this training run")
    if frozen.get("seed") != seed:
        raise ValueError("split-manifest seed does not match this training run")
    rows = frozen.get("assignments")
    if not isinstance(rows, list):
        raise ValueError("split-manifest assignments must be an array")
    group_by_candidate = {str(row["candidateId"]): row for row in groups}
    stored_by_candidate: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("candidateId"), str) or row["candidateId"] in stored_by_candidate:
            raise ValueError("split-manifest must contain one assignment per candidate")
        stored_by_candidate[row["candidateId"]] = row
    if set(stored_by_candidate) != set(group_by_candidate):
        raise ValueError("split-manifest candidates do not exactly match split-groups.jsonl")
    assignments: dict[str, str] = {}
    for candidate_id, group in group_by_candidate.items():
        stored = stored_by_candidate[candidate_id]
        if stored.get("splitGroupId") != group["splitGroupId"] or stored.get("templateFamilyId") != group["templateFamilyId"]:
            raise ValueError("split-manifest candidate group metadata does not match split-groups.jsonl")
        split = stored.get("split")
        if split not in {"train", "validation", "test"}:
            raise ValueError("split-manifest contains an unsupported partition")
        group_id = str(group["splitGroupId"])
        prior = assignments.setdefault(group_id, str(split))
        if prior != split:
            raise ValueError("split-manifest assigns one connected group to multiple partitions")
    if set(assignments.values()) != {"train", "validation", "test"}:
        raise ValueError("split-manifest must contain train, validation, and test groups")
    expected = allocate_splits(groups, seed)
    if assignments != expected:
        raise ValueError("split-manifest assignments do not match the deterministic group-size-only allocation")
    return assignments


def metrics(y_true: list[str], y_pred: list[str]) -> dict[str, Any]:
    from sklearn.metrics import accuracy_score, balanced_accuracy_score, classification_report, confusion_matrix, f1_score
    observed = sorted(set(y_true))
    all_taxonomy_macro_f1 = f1_score(y_true, y_pred, labels=list(TAXONOMY), average="macro", zero_division=0)
    return {
        "accuracy": accuracy_score(y_true, y_pred),
        "balancedAccuracy": balanced_accuracy_score(y_true, y_pred),
        "macroF1": all_taxonomy_macro_f1,
        "all10MacroF1": all_taxonomy_macro_f1,
        "allTaxonomyMacroF1": all_taxonomy_macro_f1,
        "observedMacroF1": f1_score(y_true, y_pred, labels=observed, average="macro", zero_division=0),
        "observedClassMacroF1": f1_score(y_true, y_pred, labels=observed, average="macro", zero_division=0),
        "classSupport": dict(Counter(y_true)),
        "perClass": classification_report(y_true, y_pred, labels=list(TAXONOMY), output_dict=True, zero_division=0),
        "confusionMatrix": confusion_matrix(y_true, y_pred, labels=list(TAXONOMY)).tolist(),
        "confusionLabels": list(TAXONOMY),
    }


def probabilities_with_temperature(probabilities: Any, temperature: float) -> Any:
    import numpy as np
    adjusted = np.maximum(probabilities, 1e-12) ** (1.0 / temperature)
    return adjusted / adjusted.sum(axis=1, keepdims=True)


def choose_temperature(probabilities: Any, y_true: list[str], classes: list[str]) -> tuple[float, dict[str, Any]]:
    from sklearn.metrics import log_loss

    supported_indices = [index for index, label in enumerate(y_true) if label in classes]
    excluded = Counter(label for label in y_true if label not in classes)
    diagnostics = {
        "policy": "temperature log-loss uses only validation labels observed in the training split; unseen labels remain in evaluation metrics",
        "calibratedRecords": len(supported_indices),
        "excludedValidationLabelsUnseenInTrain": dict(sorted(excluded.items())),
    }
    if not supported_indices:
        diagnostics["fallback"] = "temperature=1.0 because validation has no labels observed in training"
        return 1.0, diagnostics
    supported_true = [y_true[index] for index in supported_indices]
    supported_probabilities = probabilities[supported_indices]
    best = (float("inf"), 1.0)
    for temperature in (0.5, 0.7, 0.85, 1.0, 1.2, 1.5, 2.0, 3.0):
        loss = log_loss(supported_true, probabilities_with_temperature(supported_probabilities, temperature), labels=classes)
        best = min(best, (float(loss), temperature))
    diagnostics["selectedLogLoss"] = best[0]
    return best[1], diagnostics


def predictions_with_threshold(probabilities: Any, classes: list[str], threshold: float) -> tuple[list[str], list[str], list[float], list[float]]:
    import numpy as np
    best_index = probabilities.argmax(axis=1)
    confidences = probabilities.max(axis=1).tolist()
    forced = [classes[index] for index in best_index]
    predicted = [label if confidence >= threshold else "unknown" for label, confidence in zip(forced, confidences)]
    entropy = (-(probabilities * np.log(np.maximum(probabilities, 1e-12))).sum(axis=1)).tolist()
    return predicted, forced, confidences, entropy


def choose_model(train_records: list[dict[str, Any]], validation_records: list[dict[str, Any]], seed: int) -> tuple[Any, Any, str, dict[str, Any]]:
    from sklearn.ensemble import ExtraTreesClassifier
    from sklearn.feature_extraction import DictVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import f1_score

    vectorizer = DictVectorizer(sparse=True)
    x_train = vectorizer.fit_transform([candidate_features(record["candidate"]) for record in train_records])
    x_validation = vectorizer.transform([candidate_features(record["candidate"]) for record in validation_records])
    y_train = [record["label"] for record in train_records]
    y_validation = [record["label"] for record in validation_records]
    candidates: list[tuple[str, Any]] = [
        ("logistic-regression-c0.3", LogisticRegression(C=0.3, class_weight="balanced", max_iter=3000, random_state=seed)),
        ("logistic-regression-c1", LogisticRegression(C=1.0, class_weight="balanced", max_iter=3000, random_state=seed)),
        ("extra-trees-160", ExtraTreesClassifier(n_estimators=160, max_depth=12, min_samples_leaf=2, class_weight="balanced", n_jobs=1, random_state=seed)),
    ]
    scored: list[dict[str, Any]] = []
    best: tuple[float, str, Any] | None = None
    for name, estimator in candidates:
        estimator.fit(x_train, y_train)
        predicted = estimator.predict(x_validation)
        score = float(f1_score(y_validation, predicted, labels=list(TAXONOMY), average="macro", zero_division=0))
        scored.append({"name": name, "validationMacroF1Forced": score})
        if best is None or score > best[0]:
            best = (score, name, estimator)
    assert best is not None
    return vectorizer, best[2], best[1], {"candidates": scored, "selectedBy": "validation macro-F1 before calibration/abstention"}


def run_training(records: list[dict[str, Any]], assignments: dict[str, str], seed: int, output: Path, corpus_version: str, partition_support: dict[str, Any], input_hashes: dict[str, str]) -> dict[str, Any]:
    training_started = perf_counter()
    partitions = {name: [record for record in records if assignments[str(record["group"]["splitGroupId"])] == name] for name in ("train", "validation", "test")}
    vectorizer, model, model_name, selection = choose_model(partitions["train"], partitions["validation"], seed)
    x_validation = vectorizer.transform([candidate_features(record["candidate"]) for record in partitions["validation"]])
    classes = model.classes_.tolist()
    validation_probability = model.predict_proba(x_validation)
    temperature, calibration = choose_temperature(validation_probability, [record["label"] for record in partitions["validation"]], classes)
    validation_probability = probabilities_with_temperature(validation_probability, temperature)
    thresholds = [round(value / 100, 2) for value in range(0, 91, 5)]
    y_validation = [record["label"] for record in partitions["validation"]]
    threshold, validation_predicted = max(
        ((value, predictions_with_threshold(validation_probability, classes, value)[0]) for value in thresholds),
        key=lambda item: metrics(y_validation, item[1])["macroF1"],
    )
    x_test = vectorizer.transform([candidate_features(record["candidate"]) for record in partitions["test"]])
    started = perf_counter()
    test_probability = probabilities_with_temperature(model.predict_proba(x_test), temperature)
    latency_ms = (perf_counter() - started) * 1000 / max(1, len(partitions["test"]))
    test_predicted, test_forced, confidence, uncertainty = predictions_with_threshold(test_probability, classes, threshold)
    baseline = [semantic_heuristic(record["candidate"]) for record in partitions["test"]]
    y_test = [record["label"] for record in partitions["test"]]
    artifact = {"corpusVersion": corpus_version, "classes": classes, "vectorizer": vectorizer, "model": model, "temperature": temperature, "abstentionThreshold": threshold, "featurePolicy": "structural DOM features only; no snippets, labels, URLs, identifiers, or provenance"}
    import joblib
    model_path = output / "model.joblib"
    joblib.dump(artifact, model_path)
    test_metrics = {
        "abstaining": metrics(y_test, test_predicted),
        "forced": metrics(y_test, test_forced),
        "semanticHeuristic": metrics(y_test, baseline),
        "abstentionRate": sum(label == "unknown" and forced != "unknown" for label, forced in zip(test_predicted, test_forced)) / max(1, len(y_test)),
        "meanConfidence": sum(confidence) / max(1, len(confidence)),
        "meanUncertaintyEntropy": sum(uncertainty) / max(1, len(uncertainty)),
    }
    test_metrics["all10MacroF1"] = test_metrics["abstaining"]["all10MacroF1"]
    test_metrics["observedTestMacroF1"] = test_metrics["abstaining"]["observedMacroF1"]
    return {
        "corpusVersion": corpus_version,
        "silverLabels": True,
        "humanGoldClaim": False,
        "selection": selection,
        "selectedModel": model_name,
        "temperature": temperature,
        "calibration": calibration,
        "abstentionThreshold": threshold,
        "validation": {"abstaining": metrics(y_validation, validation_predicted), "forced": metrics(y_validation, predictions_with_threshold(validation_probability, classes, 0.0)[0])},
        "test": test_metrics,
        "latencyMsPerCandidate": latency_ms,
        "modelBytes": model_path.stat().st_size,
        "partitionSizes": {name: len(rows) for name, rows in partitions.items()},
        "partitionSupport": partition_support,
        "inputHashes": input_hashes,
        "trainingWallTimeMs": (perf_counter() - training_started) * 1000,
        "featureVocabularySize": len(vectorizer.vocabulary_),
        "limitations": EXPERIMENT_LIMITATIONS,
        "notes": ["All evaluation is against model-generated silver labels (gold=false).", "The semantic heuristic is an intentionally conservative shared-DOM baseline and returns unknown when semantics do not support a role.", "Test was held out from parameter, calibration, and abstention-threshold selection."],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--candidates", type=Path, help="required for training; intentionally not read by --freeze-splits-only")
    parser.add_argument("--labels", type=Path)
    parser.add_argument("--qa", type=Path)
    parser.add_argument("--split-groups", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--corpus-version", required=True, help="must exactly equal final manifest corpusVersion")
    parser.add_argument("--annotation-version", required=True, help="must exactly equal final manifest annotationVersion")
    parser.add_argument("--seed", type=int, default=2307)
    parser.add_argument("--required-qa-duplicates", type=int, default=75)
    parser.add_argument("--freeze-splits-only", action="store_true")
    parser.add_argument("--split-correction-reason", help="auditable reason for replacing an invalid prior split manifest")
    parser.add_argument("--correction-after-labeling-started", action="store_true", help="record that the metadata-only correction happened after annotation work began")
    args = parser.parse_args()
    required_paths = ("manifest", "split-groups", "output")
    if not args.freeze_splits_only and (args.candidates is None or args.labels is None or args.qa is None):
        parser.error("--candidates, --labels, and --qa are required unless --freeze-splits-only is used")
    if args.correction_after_labeling_started and not args.split_correction_reason:
        parser.error("--correction-after-labeling-started requires --split-correction-reason")
    if not args.freeze_splits_only and args.split_correction_reason:
        parser.error("--split-correction-reason is valid only with --freeze-splits-only")
    paths = {name: assert_private_path(getattr(args, name.replace("-", "_"))) for name in required_paths}
    if args.candidates is not None:
        paths["candidates"] = assert_private_path(args.candidates)
    if args.labels is not None:
        paths["labels"] = assert_private_path(args.labels)
    if args.qa is not None:
        paths["qa"] = assert_private_path(args.qa)
    output = paths["output"]
    output.mkdir(parents=True, exist_ok=True)
    manifest = load_json(paths["manifest"])
    require_final_manifest(manifest, args.corpus_version, args.annotation_version)
    groups = load_jsonl(paths["split-groups"])
    validate_group_manifest(groups)
    if args.freeze_splits_only:
        assignments = allocate_splits(groups, args.seed)
        correction = None
        if args.split_correction_reason:
            correction = {
                "reason": args.split_correction_reason,
                "afterLabelingStarted": args.correction_after_labeling_started,
                "inputsConsulted": ["manifest.json", "split-groups.jsonl"],
                "inputsNotConsulted": ["candidates.jsonl", "labels", "QA outcomes"],
            }
        frozen = split_manifest(groups, assignments, args.corpus_version, args.annotation_version, args.seed, correction)
        (output / "split-manifest.json").write_text(json.dumps(frozen, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(json.dumps({"status": "splits-frozen", "output": str(output / "split-manifest.json")}, sort_keys=True))
        return 0
    frozen_path = output / "split-manifest.json"
    if not frozen_path.is_file():
        raise ValueError("a frozen split-manifest.json is required before training")
    assignments = load_frozen_assignments(load_json(frozen_path), groups, args.corpus_version, args.annotation_version, args.seed)
    candidates = load_jsonl(paths["candidates"])
    validate_group_rows(candidates, groups)
    require_qa(load_json(paths["qa"]), args.corpus_version, args.annotation_version, args.required_qa_duplicates)
    records = prepare_records(candidates, load_jsonl(paths["labels"]), groups, args.corpus_version, args.annotation_version)
    partition_support = validate_partition_support(records, assignments)
    input_hashes = {
        "manifest": sha256_file(paths["manifest"]),
        "candidates": sha256_file(paths["candidates"]),
        "labels": sha256_file(paths["labels"]),
        "qa": sha256_file(paths["qa"]),
        "splitGroups": sha256_file(paths["split-groups"]),
        "splitManifest": sha256_file(frozen_path),
    }
    result = run_training(records, assignments, args.seed, output, args.corpus_version, partition_support, input_hashes)
    (output / "metrics.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    # This summary contains only aggregate counts and metrics: no DOM snippets,
    # URLs, domains, candidate IDs, or label-source prompts.
    public_summary = {key: result[key] for key in ("corpusVersion", "silverLabels", "humanGoldClaim", "selectedModel", "temperature", "calibration", "abstentionThreshold", "validation", "test", "latencyMsPerCandidate", "trainingWallTimeMs", "modelBytes", "partitionSizes", "partitionSupport", "inputHashes", "featureVocabularySize", "limitations", "notes")}
    (output / "public-summary.json").write_text(json.dumps(public_summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"status": "trained", "output": str(output), "testMacroF1": result["test"]["abstaining"]["macroF1"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

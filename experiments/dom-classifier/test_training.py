import hashlib
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from inference import candidate_features, semantic_heuristic
from aggregate_labels import aggregate_decisions, validate_raw
from train import TAXONOMY, allocate_splits, load_frozen_assignments, normalize_label, prepare_records, require_final_manifest, require_qa, split_manifest, validate_partition_support


def candidate(candidate_id, site_id, text="bounded candidate"):
    return {
        "candidateId": candidate_id,
        "siteId": site_id,
        "node": {
            "tag": "section", "roles": [], "context": "main", "ancestorTags": ["body", "main"],
            "siblingPosition": 1, "siblingCount": 3, "childCount": 2, "childTags": ["p"],
            "subtreeTagCounts": {"section": 1, "p": 2}, "linkCategories": {"relative": 1},
            "text": text, "textLength": len(text), "shapeFingerprint": "a" * 24,
        },
    }


def label(candidate_id, value):
    return {"candidateId": candidate_id, "label": value, "corpusVersion": "dom-regions-v2", "annotationVersion": "dom-role-v2", "source": "luna", "gold": False, "model": "luna", "promptVersion": "p2", "schemaVersion": "s2"}


def group(candidate_id, site_id, split_group, template):
    return {"candidateId": candidate_id, "siteId": site_id, "splitGroupId": split_group, "templateFamilyId": template}


def raw_decision(candidate_id, value, annotator, packet_id, context=None):
    return {
        **label(candidate_id, value),
        "annotator": annotator,
        "packetId": packet_id,
        "context": context if context is not None else {"domPath": "main"},
        "reason": "independent Luna review",
    }


class TrainingGuardTest(unittest.TestCase):
    def test_label_and_provenance_never_become_features(self):
        row = candidate("dom_a", "site_a")
        row["label"] = "footer"
        row["annotator"] = "luna"
        expected = candidate_features(row)
        row["label"] = "main_content"
        row["annotator"] = "something-else"
        self.assertEqual(expected, candidate_features(row))

    def test_semantic_baseline_scores_the_whole_candidate(self):
        row = candidate("dom_a", "site_a")
        row["node"]["tag"] = "nav"
        row["segments"] = [{"label": "main_content"}]  # A segmentation result must be ignored.
        self.assertEqual(semantic_heuristic(row), "navigation")

    def test_site_or_template_linkage_cannot_cross_groups(self):
        rows = [candidate("dom_a", "site_a"), candidate("dom_b", "site_a", "different text")]
        labels = [label("dom_a", "main_content"), label("dom_b", "footer")]
        groups = [group("dom_a", "site_a", "split_one", "template_a"), group("dom_b", "site_a", "split_two", "template_b")]
        with self.assertRaisesRegex(ValueError, "site linkage"):
            prepare_records(rows, labels, groups, "dom-regions-v2", "dom-role-v2")

    def test_exact_duplicate_cannot_cross_groups(self):
        rows = [candidate("dom_a", "site_a"), candidate("dom_b", "site_b")]
        labels = [label("dom_a", "main_content"), label("dom_b", "footer")]
        groups = [group("dom_a", "site_a", "split_one", "template_a"), group("dom_b", "site_b", "split_two", "template_b")]
        with self.assertRaisesRegex(ValueError, "duplicate linkage"):
            prepare_records(rows, labels, groups, "dom-regions-v2", "dom-role-v2")

    def test_exploratory_subset_of_taxonomy_is_allowed(self):
        records = []
        for index, value in enumerate(TAXONOMY[:-1]):
            row = candidate(f"dom_{index}", f"site_{index}", f"text {index}")
            records.append({"candidate": row, "label": value, "group": group(row["candidateId"], row["siteId"], f"split_{index}", f"template_{index}")})
        assignments = allocate_splits([record["group"] for record in records], 1)
        validate_partition_support(records, assignments)

    def test_split_allocation_has_a_real_70_15_15_distribution_for_48_groups_and_480_rows(self):
        groups = [
            group(f"dom_{group_index}_{row_index}", f"site_{group_index}", f"split_{group_index}", f"template_{group_index}")
            for group_index in range(48)
            for row_index in range(10)
        ]
        assignments = allocate_splits(groups, 2307)
        split_rows = {split: sum(1 for row in groups if assignments[row["splitGroupId"]] == split) for split in ("train", "validation", "test")}
        split_groups = {split: sum(1 for value in assignments.values() if value == split) for split in ("train", "validation", "test")}
        self.assertEqual(len(assignments), 48)
        self.assertEqual(sum(split_rows.values()), 480)
        self.assertEqual(split_rows, {"train": 340, "validation": 70, "test": 70})
        self.assertEqual(split_groups, {"train": 34, "validation": 7, "test": 7})

    def test_training_uses_the_existing_frozen_manifest_and_rejects_a_mismatch(self):
        groups = [
            group(f"dom_{index}", f"site_{index}", f"split_{index}", f"template_{index}")
            for index in range(12)
        ]
        assignments = allocate_splits(groups, 2307)
        frozen = split_manifest(groups, assignments, "dom-regions-v2", "dom-role-v2", 2307, {"reason": "metadata correction", "afterLabelingStarted": True})
        before = hashlib.sha256(json.dumps(frozen, sort_keys=True).encode()).hexdigest()
        self.assertEqual(load_frozen_assignments(frozen, groups, "dom-regions-v2", "dom-role-v2", 2307), assignments)
        after = hashlib.sha256(json.dumps(frozen, sort_keys=True).encode()).hexdigest()
        self.assertEqual(before, after, "validation must not mutate the frozen correction record")
        mismatched = json.loads(json.dumps(frozen))
        mismatched["assignments"][0]["split"] = "test" if mismatched["assignments"][0]["split"] != "test" else "train"
        with self.assertRaisesRegex(ValueError, "assignments"):
            load_frozen_assignments(mismatched, groups, "dom-regions-v2", "dom-role-v2", 2307)

    def test_training_requires_two_train_classes_but_allows_rare_classes_outside_train(self):
        records = []
        for index, value in enumerate(("main_content", "footer", "aside")):
            row = candidate(f"dom_{index}", f"site_{index}", f"text {index}")
            records.append({"candidate": row, "label": value, "group": group(row["candidateId"], row["siteId"], f"split_{index}", f"template_{index}")})
        assignments = {"split_0": "train", "split_1": "train", "split_2": "validation"}
        # Add a test row so all partitions are represented while aside remains unseen in train.
        test_row = candidate("dom_test", "site_test", "test")
        records.append({"candidate": test_row, "label": "aside", "group": group("dom_test", "site_test", "split_test", "template_test")})
        assignments["split_test"] = "test"
        diagnostics = validate_partition_support(records, assignments)
        self.assertEqual(diagnostics["validation"]["classesUnseenInTrain"], ["aside"])
        self.assertEqual(diagnostics["test"]["classesUnseenInTrain"], ["aside"])
        assignments["split_1"] = "validation"
        with self.assertRaisesRegex(ValueError, "training split"):
            validate_partition_support(records, assignments)

    def test_schema_version_integer_one_is_allowed_and_boolean_is_rejected(self):
        integer_schema = label("dom_a", "main_content")
        integer_schema["schemaVersion"] = 1
        self.assertEqual(normalize_label(integer_schema, "dom-regions-v2", "dom-role-v2"), "main_content")
        boolean_schema = label("dom_b", "footer")
        boolean_schema["schemaVersion"] = True
        with self.assertRaisesRegex(ValueError, "schemaVersion"):
            normalize_label(boolean_schema, "dom-regions-v2", "dom-role-v2")
        with self.assertRaisesRegex(ValueError, "provenance"):
            validate_raw(boolean_schema, "dom-regions-v2", "dom-role-v2")

    def test_context_only_conflict_is_unresolved_until_resolution_context_is_supplied(self):
        decisions = {
            "dom_a": [
                raw_decision("dom_a", "main_content", "luna-01", "packet-01", {"domPath": "main"}),
                raw_decision("dom_a", "main_content", "luna-02", "packet-02", {"domPath": "article"}),
            ]
        }
        final_rows, conflicts, qa = aggregate_decisions(decisions, {}, "dom-regions-v2", "dom-role-v2", 1)
        self.assertEqual(final_rows, [])
        self.assertTrue(conflicts[0]["contextMismatch"])
        self.assertEqual([item["packetId"] for item in conflicts[0]["decisions"]], ["packet-01", "packet-02"])
        self.assertEqual(qa["status"], "needs-adjudication")
        resolution = {"candidateId": "dom_a", "label": "main_content", "status": "adjudicated", "adjudicator": "reviewer-01", "context": {"domPath": "article"}, "reason": "the article scope is authoritative"}
        final_rows, conflicts, qa = aggregate_decisions(decisions, {"dom_a": resolution}, "dom-regions-v2", "dom-role-v2", 1)
        self.assertEqual(conflicts, [])
        self.assertEqual(final_rows[0]["context"], {"domPath": "article"})
        self.assertEqual(final_rows[0]["adjudication"]["reason"], "the article scope is authoritative")
        self.assertEqual(qa["status"], "passed")

    def test_duplicate_reviews_need_independent_annotators_and_pairwise_metrics_use_pairs(self):
        duplicate_annotator = {"dom_a": [raw_decision("dom_a", "main_content", "luna-01", "packet-01"), raw_decision("dom_a", "main_content", "luna-01", "packet-02")]}
        with self.assertRaisesRegex(ValueError, "distinct annotators"):
            aggregate_decisions(duplicate_annotator, {}, "dom-regions-v2", "dom-role-v2", 1)
        independent = {"dom_a": [raw_decision("dom_a", "main_content", "luna-01", "packet-01"), raw_decision("dom_a", "main_content", "luna-02", "packet-02"), raw_decision("dom_a", "footer", "luna-03", "packet-03")]}
        _, conflicts, qa = aggregate_decisions(independent, {}, "dom-regions-v2", "dom-role-v2", 1)
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(qa["pairwiseAgreement"]["pairCount"], 3)
        self.assertAlmostEqual(qa["blindPairwiseAgreement"], 1 / 3)

    def test_pilot_and_unresolved_qa_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "pilot"):
            require_final_manifest({"corpusVersion": "pilot-v1", "annotationVersion": "dom-role-v2", "status": "final"}, "pilot-v1", "dom-role-v2")
        with self.assertRaisesRegex(ValueError, "unresolved"):
            require_qa({"corpusVersion": "dom-regions-v2", "annotationVersion": "dom-role-v2", "status": "passed", "blindDuplicateCount": 75, "unresolvedConflicts": 1}, "dom-regions-v2", "dom-role-v2", 75)


if __name__ == "__main__":
    unittest.main()

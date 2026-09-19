import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from student import apply_jev_v3, fit_binary, predict, record_key, train
from evaluate_luna import evaluate, labels_for, positive_only_labels, require_manifest_bound_labels


def node(label="button", probability=0.9):
    return {"recordType": "node", "split": "train", "pageId": "p", "nodeId": "n", "input": "tag=button text=Save", "provenance": {"snapshotHash": "sha256:a"}, "softTargets": {"componentType": {"distribution": [{"label": label, "probability": probability}, {"label": "link", "probability": 1 - probability}]}, "regions": [{"label": "main_content", "yesProbability": probability}], "purposes": [{"label": "submit", "yesProbability": probability}]}}


class StudentTest(unittest.TestCase):
    def test_node_key_requires_capture_hash(self):
        with self.assertRaises(ValueError):
            record_key({"recordType": "node", "pageId": "p", "nodeId": "n"})
        self.assertEqual(record_key(node()), ("node", "p", "n", "sha256:a"))

    def test_soft_binary_expansion_preserves_probabilistic_target(self):
        from scipy.sparse import csr_matrix
        head = fit_binary(csr_matrix([[1], [0]]), [0.8, 0.2])
        self.assertGreater(head.predict_proba(csr_matrix([[1]]))[0, 1], head.predict_proba(csr_matrix([[0]]))[0, 1])
        with self.assertRaises(ValueError):
            fit_binary(csr_matrix([[1]]), [float("nan")])

    def test_train_rejects_non_train_split(self):
        bad = node(); bad["split"] = "test"
        with self.assertRaisesRegex(ValueError, "only train"):
            train([bad], [{"recordType": "page", "split": "train", "pageId": "p", "input": "welcome", "softTargets": {"pageTypes": [{"label": "homepage", "yesProbability": 1}], "contentKinds": [{"label": "software", "yesProbability": 1}]}}])

    def test_v3_replaces_matched_target_without_duplicating_row(self):
        base = node()
        v3 = {"pageId": "p", "nodeId": "n", "snapshotHash": "sha256:a", "axisProbabilities": {"regions": [{"label": "footer", "yesProbability": .8}], "purposes": [{"label": "submit", "yesProbability": .7}]}, "componentTypeChoice": {"choice": "link", "confidence": .8, "distribution": [{"label": "link", "probability": 1}]}}
        merged, count = apply_jev_v3([base], [v3])
        self.assertEqual((len(merged), count), (1, 1))
        self.assertEqual(merged[0]["softTargets"]["regions"][0]["label"], "footer")

    def test_prediction_accepts_one_kind_or_no_rows(self):
        rows = [node("button", .9), node("link", .1)]
        page_rows = [{"recordType": "page", "split": "train", "pageId": "p1", "input": "page tag content alpha", "softTargets": {"pageTypes": [{"label": "homepage", "yesProbability": .9}], "contentKinds": [{"label": "software", "yesProbability": .9}]}}, {"recordType": "page", "split": "train", "pageId": "p2", "input": "page tag content beta", "softTargets": {"pageTypes": [{"label": "homepage", "yesProbability": .1}], "contentKinds": [{"label": "software", "yesProbability": .1}]}}]
        model = train(rows, page_rows)
        self.assertEqual(len(predict(model, rows)), 2)
        self.assertEqual(len(predict(model, page_rows)), 2)
        self.assertEqual(predict(model, []), [])

    def test_independent_scoring_requires_explicit_complete_axes(self):
        row = {"recordType": "node", "pageId": "p", "nodeId": "n", "captureHash": "c", "input": "runtime\ntag=nav", "observedAxes": {"regions": {"complete": True, "labels": ["main_content"]}, "purposes": {"complete": False, "labels": []}}}
        self.assertEqual(labels_for(row, "regions"), {"main_content"})
        self.assertIsNone(labels_for(row, "purposes"))
        prediction = {"recordType": "node", "pageId": "p", "nodeId": "n", "captureHash": "c", "regions": {"positiveLabels": ["main_content"]}}
        self.assertEqual(evaluate([row], [prediction])["regions"]["exactSetAccuracy"], 1)
        row["observedAxes"]["purposes"] = {"complete": False, "labels": ["submit"]}
        self.assertEqual(positive_only_labels(row, "purposes"), {"submit"})
        partial_prediction = {**prediction, "purposes": {"positiveLabels": ["submit"]}}
        self.assertEqual(evaluate([row], [partial_prediction])["purposes"]["positiveOnlyRecall"], 1)

    def test_tag_baseline_handles_complete_node_and_page_axes(self):
        node_row = {"recordType": "node", "pageId": "p", "nodeId": "n", "captureHash": "c", "input": "runtime\ntag=nav", "observedAxes": {"componentType": {"complete": True, "labels": ["navigation_menu"]}, "regions": {"complete": True, "labels": []}}}
        page_row = {"recordType": "page", "pageId": "p2", "captureHash": "c2", "input": "home", "observedAxes": {"pageTypes": {"complete": True, "labels": []}, "contentKinds": {"complete": True, "labels": []}}}
        predictions = [{"recordType": "node", "pageId": "p", "nodeId": "n", "captureHash": "c"}, {"recordType": "page", "pageId": "p2", "captureHash": "c2"}]
        scores = evaluate([node_row, page_row], predictions, baseline=True)
        self.assertEqual(scores["componentType"]["exactSetAccuracy"], 1)
        self.assertEqual(scores["regions"]["exactSetAccuracy"], 1)

    def test_evaluation_requires_exact_manifest_bound_label_file(self):
        import hashlib
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); labels = root / "approved.jsonl"; labels.write_text("{}\n")
            manifest = {"labelFiles": [{"path": "approved.jsonl", "sha256": "sha256:" + hashlib.sha256(labels.read_bytes()).hexdigest()}]}
            self.assertTrue(require_manifest_bound_labels(manifest, root / "manifest.json", labels).startswith("sha256:"))
            labels.write_text('{"changed":true}\n')
            with self.assertRaisesRegex(ValueError, "hash"):
                require_manifest_bound_labels(manifest, root / "manifest.json", labels)


if __name__ == "__main__":
    unittest.main()

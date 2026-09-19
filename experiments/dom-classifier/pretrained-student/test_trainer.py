#!/usr/bin/env python3
"""Contract tests for the manifest-bound pretrained-student input gate."""
import hashlib
import importlib.util
import json
import tempfile
import unittest
import sys
import torch
from pathlib import Path

MODULE = Path(__file__).with_name("trainer.py")
spec = importlib.util.spec_from_file_location("pretrained_trainer", MODULE)
trainer = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = trainer
spec.loader.exec_module(trainer)


def input_hash(value):
    return "sha256:" + hashlib.sha256(value.encode()).hexdigest()


def training_row(record_type, page_id, node_id, capture_hash, split, text):
    targets = (
        {"componentType": {"distribution": [{"label": "button", "probability": 1.0}]},
         "regions": [{"label": "main_content", "yesProbability": 0.8}]}
        if record_type == "node"
        else {"pageTypes": [{"label": "landing_page", "yesProbability": 0.7}]}
    )
    return {
        "recordType": record_type, "pageId": page_id, "nodeId": node_id,
        "captureHash": capture_hash, "split": split, "input": text,
        "source": "jev", "gold": False, "taxonomyRevision": trainer.TAXONOMY_REVISION,
        "provenance": {"promptRevision": trainer.PROMPT_REVISION}, "softTargets": targets,
    }


class PretrainedStudentContractTest(unittest.TestCase):
    def setUp(self):
        self.labels = trainer.taxonomy()
        self.train = training_row("node", "page-a", "node-a", "capture-a", "train", "[button] Buy")
        self.validation = training_row("page", "page-b", None, "capture-b", "validation", "[main] Overview")
        self.test = training_row("node", "page-c", "node-c", "capture-c", "test", "[link] Test only")
        self.manifest = {
            "taxonomyRevision": trainer.TAXONOMY_REVISION,
            "trainingFiles": [],
            "trainingRecords": [
                {**{key: self.train[key] for key in ("recordType", "pageId", "nodeId", "captureHash", "split")}, "inputSha256": input_hash(self.train["input"])},
                {**{key: self.validation[key] for key in ("recordType", "pageId", "nodeId", "captureHash", "split")}, "inputSha256": input_hash(self.validation["input"])},
                {**{key: self.test[key] for key in ("recordType", "pageId", "nodeId", "captureHash", "split")}, "inputSha256": input_hash(self.test["input"])},
            ],
        }

    def test_bound_train_and_validation_are_accepted_without_reading_test_rows(self):
        entries = trainer.manifest_entries(self.manifest)
        self.assertEqual(trainer.validate_rows([self.train], entries, "train", self.labels), [self.train])
        self.assertEqual(trainer.validate_rows([self.validation], entries, "validation", self.labels), [self.validation])
        # The test record is deliberately never supplied to either training gate.
        self.assertNotIn("Test only", json.dumps([self.train, self.validation]))

    def test_categorical_zero_mass_and_missing_axes_are_distinct(self):
        specs = (trainer.HeadSpec("componentType", ("button", "link"), False),)
        targets = trainer.build_targets([self.train, self.validation], specs)
        self.assertEqual(targets["componentType"].tolist(), [[1.0, 0.0], [-1.0, -1.0]])
        loss = trainer.masked_loss({"componentType": torch.zeros((2, 2))}, targets, specs, torch.device("cpu"))
        self.assertAlmostEqual(float(loss), 0.693147, places=5)

    def test_fixed_shape_masked_loss_matches_observed_reference(self):
        specs = (trainer.HeadSpec("regions", ("site_header", "footer"), True),)
        logits = torch.tensor([[0.3, -0.5], [0.1, 0.7]], requires_grad=True)
        target = torch.tensor([[0.8, -1.0], [-1.0, 0.4]])
        got = trainer.masked_loss({"regions": logits}, {"regions": target}, specs, torch.device("cpu"))
        expected = torch.nn.functional.binary_cross_entropy_with_logits(torch.stack([logits[0, 0], logits[1, 1]]), torch.tensor([0.8, 0.4]))
        self.assertAlmostEqual(float(got), float(expected), places=6)
        got.backward()
        self.assertEqual(float(logits.grad[0, 1]), 0.0)
        self.assertEqual(float(logits.grad[1, 0]), 0.0)

    def test_input_hash_mismatch_is_rejected(self):
        entries = trainer.manifest_entries(self.manifest)
        self.train["input"] = "tampered sanitized text"
        with self.assertRaisesRegex(ValueError, "input hash"):
            trainer.validate_rows([self.train], entries, "train", self.labels)

    def test_human_or_wrong_prompt_record_is_rejected(self):
        entries = trainer.manifest_entries(self.manifest)
        self.train["source"] = "human"
        with self.assertRaisesRegex(ValueError, "Jev synthetic"):
            trainer.validate_rows([self.train], entries, "train", self.labels)
        self.train["source"] = "jev"
        self.train["provenance"]["promptRevision"] = "dom-suggestions-v3"
        with self.assertRaisesRegex(ValueError, "provenance"):
            trainer.validate_rows([self.train], entries, "train", self.labels)

    def test_unknown_label_and_inapplicable_axis_are_rejected(self):
        entries = trainer.manifest_entries(self.manifest)
        self.train["softTargets"]["regions"][0]["label"] = "made_up_region"
        with self.assertRaisesRegex(ValueError, "regions soft target label"):
            trainer.validate_rows([self.train], entries, "train", self.labels)
        self.train["softTargets"]["regions"][0]["label"] = "main_content"
        self.train["softTargets"]["pageTypes"] = []
        with self.assertRaisesRegex(ValueError, "inapplicable"):
            trainer.validate_rows([self.train], entries, "train", self.labels)

    def test_only_hash_bound_files_are_allowed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = root / "manifest.json"
            records = root / "train.jsonl"
            records.write_text(json.dumps(self.train) + "\n", encoding="utf-8")
            self.manifest["trainingFiles"] = [{"path": "train.jsonl", "sha256": "sha256:wrong"}]
            manifest_path.write_text(json.dumps(self.manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "hash-bound"):
                trainer.require_file_bound(self.manifest, manifest_path, records)


class PredictionInterfaceTest(unittest.TestCase):
    def test_prediction_identity_requires_node_ids_and_page_null_node(self):
        predict_spec = importlib.util.spec_from_file_location("pretrained_predict_identity", MODULE.with_name("predict.py"))
        predict = importlib.util.module_from_spec(predict_spec)
        sys.modules[predict_spec.name] = predict
        predict_spec.loader.exec_module(predict)
        with self.assertRaisesRegex(ValueError, "nodeId"):
            predict.validate_prediction_rows([{**training_row("node", "page-a", None, "capture-a", "test", "x")}])
        with self.assertRaisesRegex(ValueError, "must not have nodeId"):
            predict.validate_prediction_rows([{**training_row("page", "page-a", "node-a", "capture-a", "test", "x")}])

    def test_prediction_batches_and_preserves_split(self):
        predict_spec = importlib.util.spec_from_file_location("pretrained_predict_batches", MODULE.with_name("predict.py"))
        predict = importlib.util.module_from_spec(predict_spec)
        predict_spec.loader.exec_module(predict)
        sizes = []
        class Tokenizer:
            def __call__(self, inputs, **kwargs):
                sizes.append(len(inputs))
                return {"input_ids": torch.ones((len(inputs), 2), dtype=torch.long), "attention_mask": torch.ones((len(inputs), 2), dtype=torch.long)}
        class Model:
            def eval(self): return self
            def __call__(self, ids, mask): return {"componentType": torch.zeros((len(ids), 2))}
        rows = [training_row("node", "page-a", str(i), "capture-a", "test", "button") for i in range(19)]
        values = predict.prediction_rows(Model(), Tokenizer(), rows, (trainer.HeadSpec("componentType", ("button", "link"), False),), torch.device("cpu"))
        self.assertEqual(sizes, [8, 8, 3])
        self.assertEqual([v["nodeId"] for v in values], [str(i) for i in range(19)])
        self.assertTrue(all(v["split"] == "test" for v in values))

    def test_predictions_preserve_identity_and_only_emit_applicable_heads(self):
        predict_spec = importlib.util.spec_from_file_location("pretrained_predict", MODULE.with_name("predict.py"))
        predict = importlib.util.module_from_spec(predict_spec)
        sys.modules[predict_spec.name] = predict
        predict_spec.loader.exec_module(predict)
        specs = (
            trainer.HeadSpec("componentType", ("button", "link"), False),
            trainer.HeadSpec("regions", ("main_content",), True),
            trainer.HeadSpec("purposes", ("navigation",), True),
            trainer.HeadSpec("pageTypes", ("landing_page",), True),
            trainer.HeadSpec("contentKinds", ("article",), True),
        )
        class Tokenizer:
            def __call__(self, _inputs, **_kwargs):
                return {"input_ids": torch.ones((2, 2), dtype=torch.long), "attention_mask": torch.ones((2, 2), dtype=torch.long)}
        class Model:
            def eval(self):
                return self
            def __call__(self, _input_ids, _attention_mask):
                return {
                    "componentType": torch.tensor([[0.0, 1.0], [1.0, 0.0]]),
                    "regions": torch.tensor([[2.0], [-2.0]]), "purposes": torch.tensor([[-2.0], [-2.0]]),
                    "pageTypes": torch.tensor([[2.0], [2.0]]), "contentKinds": torch.tensor([[2.0], [2.0]]),
                }
        rows = [
            training_row("node", "page-a", "node-a", "capture-a", "train", "button"),
            training_row("page", "page-b", None, "capture-b", "validation", "page"),
        ]
        values = predict.prediction_rows(Model(), Tokenizer(), rows, specs, torch.device("cpu"))
        self.assertEqual(values[0]["nodeId"], "node-a")
        self.assertEqual(values[0]["componentType"]["prediction"], "link")
        self.assertIn("regions", values[0])
        self.assertNotIn("pageTypes", values[0])
        self.assertIn("pageTypes", values[1])
        self.assertNotIn("componentType", values[1])


if __name__ == "__main__":
    unittest.main()

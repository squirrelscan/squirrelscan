import importlib.util
import unittest
from pathlib import Path

PATH = Path(__file__).with_name("train_diverse.py")
spec = importlib.util.spec_from_file_location("train_diverse", PATH)
train_diverse = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(train_diverse)


class DiverseTrainContractTests(unittest.TestCase):
    def row(self, kind="node"):
        return {
            "recordType": kind, "pageId": "page-a", "nodeId": "node-a" if kind == "node" else None,
            "captureHash": "sha256:capture", "split": "train", "source": "jev", "gold": False,
            "taxonomyRevision": "dom-taxonomy-v2", "input": "tag=button", "softTargets": {"componentType": {"distribution": []}},
            "teacherIdentity": {"id": "jev-row", "modelId": "jev-1.13.0", "modelRevision": "jev-1.13.0", "promptRevision": "dom-suggestions-v4", "snapshotHash": "sha256:snapshot"},
        }

    def manifest(self, rows):
        return {"trainingRecords": [{key: row[key] for key in ("recordType", "pageId", "nodeId", "captureHash", "split")} | {"inputSha256": train_diverse.sha256_text(row["input"])} for row in rows]}

    def test_rejects_luna_as_training_supervision(self):
        row = self.row(); row["source"] = "luna"
        with self.assertRaisesRegex(ValueError, "Jev"):
            train_diverse.validate_train_rows([row], self.manifest([row]))

    def test_rejects_incomplete_or_old_jev_provenance(self):
        row = self.row(); row["teacherIdentity"]["promptRevision"] = "dom-suggestions-v3"
        with self.assertRaisesRegex(ValueError, "provenance"):
            train_diverse.validate_train_rows([row], self.manifest([row]))

    def test_rejects_heldout_and_duplicate_identity(self):
        row = self.row(); row["split"] = "test"
        with self.assertRaisesRegex(ValueError, "train-split"):
            train_diverse.validate_train_rows([row], self.manifest([row]))
        with self.assertRaisesRegex(ValueError, "duplicate"):
            train_diverse.validate_train_rows([self.row(), self.row(), {**self.row("page"), "pageId": "page-b"}], self.manifest([self.row(), {**self.row("page"), "pageId": "page-b"}]))

    def test_rejects_stale_or_unassigned_record(self):
        node, page = self.row(), {**self.row("page"), "pageId": "page-b"}
        stale = dict(node); stale["captureHash"] = "sha256:other"
        with self.assertRaisesRegex(ValueError, "stale"):
            train_diverse.validate_train_rows([stale, page], self.manifest([node, page]))

    def test_requires_both_record_kinds(self):
        with self.assertRaisesRegex(ValueError, "both node and page"):
            train_diverse.validate_train_rows([self.row()], self.manifest([self.row()]))


if __name__ == "__main__":
    unittest.main()

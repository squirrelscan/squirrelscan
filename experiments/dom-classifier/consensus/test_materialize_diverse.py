import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

PATH = Path(__file__).with_name("materialize_diverse.py")
spec = importlib.util.spec_from_file_location("materialize_diverse", PATH)
materialize = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = materialize
spec.loader.exec_module(materialize)


class MaterializeDiverseTests(unittest.TestCase):
    def capture(self, page_id, capture_hash):
        return {"id": page_id, "captureHash": capture_hash, "title": "Contact me@example.test https://example.test token=privatevalue", "nodes": [
            {"id": "n1", "tag": "nav", "text": "Home", "parentId": None},
            {"id": "n2", "tag": "button", "text": "Buy", "parentId": None},
            {"id": "n3", "tag": "footer", "text": "Support", "parentId": None},
            {"id": "n4", "tag": "main", "text": "Content", "parentId": None},
            {"id": "n5", "tag": "a", "text": "More", "parentId": None},
            {"id": "n6", "tag": "section", "text": "Details", "parentId": None},
        ]}

    def jev(self, page, node_id=None, stale=False):
        axes = ({"regions": [{"label": "footer", "yesProbability": .2}], "purposes": [{"label": "support", "yesProbability": .3}]}
                if node_id else {"pageTypes": [{"label": "homepage", "yesProbability": .8}], "contentKinds": [{"label": "organization", "yesProbability": .7}]})
        row = {"id": "id-" + page["id"] + str(node_id), "provider": "typesafe", "modelId": materialize.MODEL, "modelRevision": materialize.MODEL,
               "promptRevision": materialize.PROMPT, "taxonomyRevision": materialize.TAXONOMY, "pageId": page["id"], "nodeId": node_id,
               "captureHash": page["captureHash"], "snapshotHash": "sha256:stale" if stale else "sha256:state", "rawAnswers": {}, "provisional": True,
               "axisProbabilities": axes, "mappedLabels": {"componentType": "button"} if node_id else {}}
        if node_id:
            row["componentTypeChoice"] = {"choice": "button", "confidence": .9, "distribution": [{"label": "button", "probability": 1.0}]}
        return row

    def materialize_fixture(self, stale=False, bad_split=False):
        directory = tempfile.TemporaryDirectory(); root = Path(directory.name); (root / "captures").mkdir()
        frozen = []; jev = []
        for number, split in enumerate(("train", "train", "validation", "test")):
            page = self.capture(f"page-{number}", f"capture-{number}")
            path = root / "captures" / f"page-{number}.json"; path.write_text(json.dumps(page))
            frozen.append({"pageId": page["id"], "captureHash": page["captureHash"], "path": f"captures/{path.name}", "split": "wrong" if bad_split and number == 0 else split})
            jev.append(self.jev(page, stale=stale and number == 0)); jev += [self.jev(page, node) for node in ("n1", "n2", "n3", "n4", "n5", "n6")]
        frozen_path = root / "frozen.jsonl"; frozen_path.write_text("".join(json.dumps(x) + "\n" for x in frozen))
        jev_path = root / "jev.jsonl"; jev_path.write_text("".join(json.dumps(x) + "\n" for x in jev))
        argv = ["materialize", "--qa-root", str(root), "--frozen-manifest", str(frozen_path), "--jev", str(jev_path), "--output", str(root / "out"), "--train-qa-pages", "1"]
        with patch.object(materialize, "state_hashes", return_value={f"page-{n}": "sha256:state" for n in range(4)}), patch.object(sys, "argv", argv):
            materialize.main()
        return directory, root

    def test_materializes_train_only_and_blind_packet_policy(self):
        directory, root = self.materialize_fixture()
        self.addCleanup(directory.cleanup)
        output = root / "out"; manifest = json.loads((output / "frozen-manifest.json").read_text())
        self.assertEqual(len((output / "train-jev.jsonl").read_text().splitlines()), 14)
        self.assertEqual(len((output / "validation-jev.jsonl").read_text().splitlines()), 7)
        self.assertEqual(len((output / "test-jev.jsonl").read_text().splitlines()), 7)
        packets = [json.loads(x) for x in (output / "luna-blind-packets.jsonl").read_text().splitlines()]
        self.assertEqual(len(packets), 12)  # every selected page plus three nodes
        self.assertEqual(manifest["lunaPackets"]["counts"], {"total": 12, "train": 4, "validation": 4, "test": 4})
        self.assertTrue(all(not ({"softTargets", "teacherIdentity", "provenance", "source", "gold"} & set(row)) for row in packets))
        self.assertTrue(all(row["inputSha256"] == materialize.h(row["input"]) for row in packets))
        self.assertNotIn("https://", (output / "train-jev.jsonl").read_text())
        self.assertNotIn("me@example.test", (output / "train-jev.jsonl").read_text())

    def test_rejects_stale_state_and_wrong_frozen_split(self):
        with self.assertRaisesRegex(ValueError, "stale"):
            directory, _ = self.materialize_fixture(stale=True); directory.cleanup()
        with self.assertRaisesRegex(ValueError, "invalid"):
            directory, _ = self.materialize_fixture(bad_split=True); directory.cleanup()

    def test_rejects_duplicate_source_identity(self):
        directory = tempfile.TemporaryDirectory(); root = Path(directory.name); self.addCleanup(directory.cleanup)
        page = self.capture("page", "capture"); (root / "captures").mkdir(); (root / "captures" / "page.json").write_text(json.dumps(page))
        (root / "frozen.jsonl").write_text(json.dumps({"pageId": "page", "captureHash": "capture", "path": "captures/page.json", "split": "train"}) + "\n")
        data = [self.jev(page), self.jev(page, "n1"), self.jev(page, "n1"), self.jev(page, "n2"), self.jev(page, "n3"), self.jev(page, "n4"), self.jev(page, "n5"), self.jev(page, "n6")]
        (root / "jev.jsonl").write_text("".join(json.dumps(x) + "\n" for x in data))
        argv = ["materialize", "--qa-root", str(root), "--frozen", str(root / "frozen.jsonl"), "--jev", str(root / "jev.jsonl"), "--output", str(root / "out")]
        with patch.object(materialize, "state_hashes", return_value={"page": "sha256:state"}), patch.object(sys, "argv", argv):
            with self.assertRaisesRegex(ValueError, "duplicate Jev source"):
                materialize.main()


if __name__ == "__main__":
    unittest.main()

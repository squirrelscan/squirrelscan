import hashlib
import importlib.util
import json
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("luna_batch.py")
spec = importlib.util.spec_from_file_location("luna_batch", MODULE_PATH)
luna_batch = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(luna_batch)


class LunaBatchTests(unittest.TestCase):
    def setUp(self):
        self.revision, self.allowed = luna_batch.load_taxonomy(
            Path(__file__).parents[1] / "taxonomy.json"
        )

    def packet(self, packet_id: str, page_id: str, node_id: str):
        value = {
            "packetId": packet_id,
            "recordType": "node",
            "pageId": page_id,
            "nodeId": node_id,
            "captureHash": "capture-a",
            "input": "page=Example\ntag=button\ntext=Buy",
            "taxonomyRevision": self.revision,
            "split": "train",
        }
        value["inputSha256"] = luna_batch.sha256_text(value["input"])
        return value

    def record(self, packet):
        return {
            "packetKey": luna_batch.compact_packet_key(packet),
            "source": "luna",
            "gold": False,
            "model": "gpt-5.6-luna",
            "labelingMethod": "independent_reasoned_review",
            "taxonomyRevision": self.revision,
            "evidence": "The button tag and Buy text identify an action control.",
            "observations": [{"axis": "componentType", "complete": True, "labels": ["button"]}],
        }

    def test_invalid_sibling_rejects_entire_batch_before_acceptance(self):
        first = self.packet("first", "page-a", "node-a")
        second = self.packet("second", "page-b", "node-b")
        bad_second = self.record(second)
        bad_second["packetKey"] = "pkt_wrongkey"
        response = json.dumps({"records": [self.record(first), bad_second]})

        with self.assertRaisesRegex(ValueError, "packet keys"):
            luna_batch.validated_batch_records(
                response, [first, second], self.revision, self.allowed, "prompt", 1
            )

    def test_valid_batch_preserves_every_packet_identity(self):
        first = self.packet("first", "page-a", "node-a")
        second = self.packet("second", "page-b", "node-b")
        rows = luna_batch.validated_batch_records(
            json.dumps({"records": [self.record(second), self.record(first)]}),
            [first, second], self.revision, self.allowed, "prompt", 1,
        )
        self.assertEqual([row["packetId"] for row in rows], ["first", "second"])
        self.assertEqual([row["pageId"] for row in rows], ["page-a", "page-b"])
        self.assertEqual(rows[0]["input"], first["input"])
        self.assertTrue(all("lunaRun" in row for row in rows))

    def test_prompt_requires_complete_axes_when_packet_is_sufficient(self):
        packet = self.packet("first", "page-a", "node-a")
        prompt = luna_batch.prompt_for([packet], self.revision, self.allowed)
        self.assertIn("do not default to incomplete", prompt)

    def test_response_schema_uses_only_compact_keys_and_axis_enums(self):
        packet = self.packet("first", "page-a", "node-a")
        schema = luna_batch.response_schema([packet], self.revision, self.allowed)
        item = schema["properties"]["records"]["items"]
        self.assertEqual(item["properties"]["packetKey"]["enum"], [luna_batch.compact_packet_key(packet)])
        self.assertNotIn("pageId", item["properties"])
        observation = item["properties"]["observations"]["items"]
        branches = {entry["properties"]["axis"]["const"]: entry["properties"]["labels"]["items"]["enum"] for entry in observation["anyOf"]}
        self.assertEqual(set(branches["componentType"]), self.allowed["componentTypes"])
        self.assertEqual(set(branches["purposes"]), self.allowed["purposes"])
        self.assertNotIn("observedAxes", item["properties"])


if __name__ == "__main__":
    unittest.main()

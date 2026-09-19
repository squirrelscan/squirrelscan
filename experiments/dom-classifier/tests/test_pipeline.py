import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "experiments" / "dom-classifier"))
from build_corpus import SENSITIVE_TEXT, candidate_record, packet_validation_failures, sanitize_text, validate_packet_files


class SafePacketTest(unittest.TestCase):
    def page_provenance(self):
        return {
            "capturedAt": "2026-09-18T00:00:00Z",
            "capturedAtEpochMs": 1,
            "captureMode": "unknown",
            "captureEvidence": None,
            "contentHashVerified": True,
            "sourceHashPresent": False,
        }

    def production_nodes(self):
        payload = {"kind": "page", "pageId": "page_x", "siteId": "site_x", "pageProvenance": {}, "url": "https://example.test/article", "html": '<main><article><header>Guide</header><p>mail a@b.test token=abc123456 <a href="/guide">Read guide</a></p></article><form><input type="hidden" value="secret"></form><script>password=leak</script></main>'}
        result = subprocess.run(["bun", str(ROOT / "experiments" / "dom-classifier" / "extract-dom.ts")], input=json.dumps(payload) + "\n", text=True, capture_output=True, check=True)
        return json.loads(result.stdout)["candidates"]

    def test_canonical_parser_redacts_and_excludes_unsafe_content(self):
        article = next(node for node in self.production_nodes() if node["tag"] == "article")
        record = candidate_record(article, {"pageId": "page_x", "siteId": "site_x", "pageProvenance": self.page_provenance()}, "seed", 1)
        self.assertIn("[REDACTED]", record["node"]["text"])
        self.assertNotIn("secret", record["node"]["text"])
        self.assertNotIn("leak", record["node"]["text"])
        self.assertNotIn("weakSignals", record["node"])
        self.assertLessEqual(len(record["node"]["text"]), 280)

    def test_recursive_packet_validator_checks_context_and_nested_fields(self):
        article = next(node for node in self.production_nodes() if node["tag"] == "article")
        record = candidate_record(article, {"pageId": "page_x", "siteId": "site_x", "pageProvenance": self.page_provenance()}, "seed", 1)
        packet = {key: value for key, value in record.items() if key != "weakSignals"}
        self.assertEqual(packet_validation_failures(packet), {})

        context_leak = copy.deepcopy(packet)
        context_leak["node"]["contextText"] = "contact person@example.test"
        self.assertIn("sensitive_string", " ".join(packet_validation_failures(context_leak)))

        nested_attribute = copy.deepcopy(packet)
        nested_attribute["node"]["semanticAncestorChain"][0]["attributes"] = {"data-email": "person@example.test"}
        nested_failures = packet_validation_failures(nested_attribute)
        self.assertIn("$.node.semanticAncestorChain[0]:unallowed_field", nested_failures)
        self.assertNotIn("person@example.test", json.dumps(nested_failures))

        provenance_attribute = copy.deepcopy(packet)
        provenance_attribute["pageProvenance"]["url"] = "https://private.example.test"
        self.assertIn("$.pageProvenance:unallowed_field", packet_validation_failures(provenance_attribute))

    def test_packet_file_validator_returns_aggregate_failures_without_values(self):
        article = next(node for node in self.production_nodes() if node["tag"] == "article")
        record = candidate_record(article, {"pageId": "page_x", "siteId": "site_x", "pageProvenance": self.page_provenance()}, "seed", 1)
        packet = {key: value for key, value in record.items() if key != "weakSignals"}
        packet["node"]["contextText"] = "Bearer abcdefghijkl"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "packet.jsonl"
            path.write_text(json.dumps(packet) + "\n", encoding="utf-8")
            result = validate_packet_files(Path(directory))
        self.assertEqual(result["recordsChecked"], 1)
        self.assertEqual(result["failureCount"], 1)
        self.assertEqual(result["failures"], {"$.<field>.<field>:sensitive_string": 1})

    def packet(self):
        article = next(node for node in self.production_nodes() if node["tag"] == "article")
        record = candidate_record(article, {"pageId": "page_x", "siteId": "site_x", "pageProvenance": self.page_provenance()}, "seed", 1)
        return {key: value for key, value in record.items() if key != "weakSignals"}

    def test_sensitive_attribute_value_is_reported_without_being_echoed(self):
        secret = "reception@private-clinic.test"  # pragma: allowlist secret

        direct = copy.deepcopy(self.packet())
        direct["node"]["semanticAttributes"]["aria-label"] = f"Email {secret}"

        nested = copy.deepcopy(self.packet())
        nested["node"]["mediaDescendants"] = [
            {"tag": "img", "attributes": {"alt": f"Email {secret}"}, "srcCategory": "same-site"}
        ]

        cases = (
            ("semanticAttributes", direct, "$.<field>.<field>.<field>:sensitive_string"),
            ("mediaDescendants", nested, "$.<field>.<field>[0].<field>.<field>:sensitive_string"),
        )
        for name, leak, expected in cases:
            with self.subTest(field=name):
                failures = packet_validation_failures(leak)
                # Every field name on the path is masked, so the report says a
                # sensitive value exists without naming which attribute held it.
                self.assertIn(expected, failures)
                serialized = json.dumps(failures)
                self.assertNotIn(secret, serialized)
                self.assertNotIn("private-clinic", serialized)
                self.assertNotIn("aria-label", serialized)
                self.assertNotIn("alt", serialized)

    def test_attribute_values_are_redacted_on_the_emit_path(self):
        node = next(n for n in self.production_nodes() if n["tag"] == "article")
        node = copy.deepcopy(node)
        node["semanticAttributes"] = {"alt": "Call Dana on +1 555 0134", "title": "mail a@b.test"}
        node["mediaDescendants"] = [{"tag": "img", "attributes": {"alt": "mail a@b.test"}, "srcCategory": "same-site"}]
        record = candidate_record(node, {"pageId": "page_x", "siteId": "site_x", "pageProvenance": self.page_provenance()}, "seed", 1)
        attributes = record["node"]["semanticAttributes"]
        self.assertEqual(attributes["title"], "mail [REDACTED]")
        self.assertNotIn("555", attributes["alt"])
        self.assertEqual(record["node"]["mediaDescendants"][0]["attributes"]["alt"], "mail [REDACTED]")
        # A redacted packet is a clean packet.
        packet = {key: value for key, value in record.items() if key != "weakSignals"}
        self.assertEqual(packet_validation_failures(packet), {})

    def test_unknown_attribute_key_and_host_shaped_src_category_are_rejected(self):
        extra_key = copy.deepcopy(self.packet())
        extra_key["node"]["semanticAttributes"]["data-owner"] = "Dana"
        self.assertIn("$.node.semanticAttributes:unallowed_key", packet_validation_failures(extra_key))

        host_leak = copy.deepcopy(self.packet())
        host_leak["node"]["srcCategory"] = "cdn.private-clinic.test"
        failures = packet_validation_failures(host_leak)
        self.assertIn("$.node.srcCategory:unallowed_value", failures)
        self.assertNotIn("private-clinic", json.dumps(failures))

        bad_summary = copy.deepcopy(self.packet())
        bad_summary["node"]["structureSummary"] = "img[src=https://private-clinic.test/a.png]"
        summary_failures = packet_validation_failures(bad_summary)
        self.assertIn("$.node.structureSummary:unallowed_value", summary_failures)
        self.assertNotIn("private-clinic", json.dumps(summary_failures))

    def test_new_extractor_fields_survive_a_real_extraction(self):
        node = next(n for n in self.production_nodes() if n["tag"] == "article")
        for field in ("emptyText", "semanticAttributes", "srcCategory", "structureSummary", "mediaDescendants"):
            self.assertIn(field, node)
        packet = self.packet()
        self.assertEqual(packet_validation_failures(packet), {})

    def test_sensitive_pattern_catches_email_bearer_and_urls(self):
        self.assertEqual(sanitize_text("a@b.test Bearer abcdefghijkl https://x.test/?token=abc"), "[REDACTED] [REDACTED] [REDACTED]")
        self.assertIsNotNone(SENSITIVE_TEXT.search("password=abcdef"))


if __name__ == "__main__":
    unittest.main()

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


PATH = Path(__file__).with_name("freeze_diverse_manifest.py")
spec = importlib.util.spec_from_file_location("freeze_diverse_manifest", PATH)
freeze = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(freeze)


class FreezeManifestTests(unittest.TestCase):
    def test_empty_landmarks_do_not_connect_unrelated_domains_and_output_is_immutable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            captures = root / "captures"
            captures.mkdir()
            source = root / "source.jsonl"
            output = root / "frozen.jsonl"
            rows = []
            for page_id, domain in (("page-a", "a.example"), ("page-b", "b.example")):
                capture = captures / f"{page_id}.json"
                capture.write_text(json.dumps({"nodes": [{"id": "n", "tag": "div", "text": "different"}]}))
                rows.append({"pageId": page_id, "captureHash": f"sha256:{page_id}", "domainGroup": domain, "path": capture.name})
            source.write_text("".join(json.dumps(row) + "\n" for row in rows))
            old_argv = sys.argv
            try:
                sys.argv = [str(PATH), "--source", str(source), "--captures", str(captures), "--output", str(output)]
                freeze.main()
                frozen = [json.loads(line) for line in output.read_text().splitlines()]
                self.assertNotEqual(frozen[0]["connectedGroupId"], frozen[1]["connectedGroupId"])
                with self.assertRaisesRegex(ValueError, "immutable"):
                    freeze.main()
            finally:
                sys.argv = old_argv


if __name__ == "__main__":
    unittest.main()

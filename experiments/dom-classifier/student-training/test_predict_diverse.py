import importlib.util
import unittest
from pathlib import Path


PATH = Path(__file__).with_name("predict_diverse.py")
spec = importlib.util.spec_from_file_location("predict_diverse", PATH)
predict_diverse = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(predict_diverse)


class PredictDiverseContractTests(unittest.TestCase):
    def row(self, kind="node"):
        return {
            "recordType": kind,
            "pageId": "page-a",
            "nodeId": "node-a" if kind == "node" else None,
            "captureHash": "sha256:capture",
            "input": "runtime-dom-text-v1\ntag=button\ntext=Save",
        }

    def test_requires_stable_node_page_identity(self):
        bad_node = self.row(); bad_node["nodeId"] = None
        with self.assertRaisesRegex(ValueError, "nodeId"):
            predict_diverse.validate_rows([bad_node])
        bad_page = self.row("page"); bad_page["nodeId"] = "node-a"
        with self.assertRaisesRegex(ValueError, "must not have nodeId"):
            predict_diverse.validate_rows([bad_page])

    def test_accepts_only_supplied_text_identity_fields(self):
        predict_diverse.validate_rows([self.row(), self.row("page")])


if __name__ == "__main__":
    unittest.main()

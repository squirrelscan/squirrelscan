import importlib.util
import sys
import unittest
import tempfile
from types import SimpleNamespace
import torch
from pathlib import Path
import numpy as np

PATH = Path(__file__).with_name("frozen_encoder.py")
spec = importlib.util.spec_from_file_location("frozen_encoder", PATH)
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)


class FrozenEncoderTests(unittest.TestCase):
    def test_nonconstant_soft_heads_fit_dense_embeddings(self):
        rows = [
            {"recordType": "node", "softTargets": {"componentType": {"distribution": [{"label": "button", "probability": probability}]}}}
            for probability in (0.2, 0.8)
        ]
        heads = mod.fit(rows, np.array([[1.0, 0.0], [0.0, 1.0]]), mod.trainer.taxonomy())
        probabilities = heads[("componentType", "button")].predict_proba(np.array([[1.0, 0.0], [0.0, 1.0]]))[:, 1]
        self.assertLess(probabilities[0], probabilities[1])

    def test_prediction_identity_gate(self):
        with self.assertRaises(ValueError):
            mod.validate_prediction_rows(
                [
                    {
                        "recordType": "node",
                        "pageId": "p",
                        "captureHash": "c",
                        "input": "x",
                    }
                ]
            )
        mod.validate_prediction_rows(
            [
                {
                    "recordType": "page",
                    "pageId": "p",
                    "nodeId": None,
                    "captureHash": "c",
                    "input": "x",
                    "split": "test",
                }
            ]
        )

    def test_soft_head_constant_roundtrip(self):
        rows = [
            {
                "recordType": "node",
                "softTargets": {
                    "componentType": {
                        "distribution": [{"label": "button", "probability": 1.0}]
                    },
                    "regions": [{"label": "footer", "yesProbability": 1.0}],
                    "purposes": [{"label": "support", "yesProbability": 1.0}],
                },
            },
            {
                "recordType": "page",
                "softTargets": {
                    "pageTypes": [{"label": "homepage", "yesProbability": 0.0}],
                    "contentKinds": [{"label": "organization", "yesProbability": 1.0}],
                },
            },
        ]
        labels = mod.trainer.taxonomy()
        heads = mod.fit(rows, np.array([[1.0, 0.0], [0.0, 1.0]]), labels)
        self.assertIn(("componentType", "button"), heads)
        self.assertEqual(
            float(
                heads[("componentType", "button")].predict_proba(
                    np.array([[1.0, 0.0]])
                )[0, 1]
            ),
            1.0,
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "heads.joblib"
            mod.joblib.dump(heads, path)
            loaded = mod.joblib.load(path)
            self.assertEqual(float(loaded[("componentType", "button")].predict_proba(np.array([[0.0, 1.0]]))[0, 1]), 1.0)

    def test_mean_pool_excludes_padding(self):
        class Tokens(dict):
            def to(self, device):
                return self
        class Tokenizer:
            def __call__(self, values, **kwargs):
                return Tokens(input_ids=torch.tensor([[1, 2, 0]]), attention_mask=torch.tensor([[1, 1, 0]]))
        class Encoder:
            def eval(self):
                return self
            def __call__(self, **kwargs):
                return SimpleNamespace(last_hidden_state=torch.tensor([[[2.0, 4.0], [4.0, 6.0], [100.0, 100.0]]]))
        values = mod.embed([{"input": "example"}], Tokenizer(), Encoder(), torch.device("cpu"))
        np.testing.assert_allclose(values, [[3.0, 5.0]])


if __name__ == "__main__":
    unittest.main()

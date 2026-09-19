import tempfile
import unittest
from types import SimpleNamespace

import torch
from torch import nn

from model import HeadSpec, MultiAxisTextProbe


class FakeEncoder(nn.Module):
    config = SimpleNamespace(hidden_size=3)
    def forward(self, input_ids, attention_mask):
        values = input_ids.float().unsqueeze(-1).repeat(1, 1, 3)
        return SimpleNamespace(last_hidden_state=values)


class ProbeTest(unittest.TestCase):
    def test_missing_axis_labels_do_not_create_negative_examples(self):
        model = MultiAxisTextProbe((HeadSpec("region", ("header", "footer")), HeadSpec("purpose", ("navigation", "other"))), encoder=FakeEncoder())
        logits = model(torch.tensor([[1, 2], [3, 4]]), torch.ones(2, 2, dtype=torch.long))
        loss, observed = model.masked_loss(logits, {"region": torch.tensor([0, -100]), "purpose": torch.tensor([-100, -100])})
        self.assertTrue(torch.isfinite(loss))
        self.assertEqual(observed, {"region": 1, "purpose": 0})

    def test_multi_label_axis_masks_each_unobserved_label(self):
        model = MultiAxisTextProbe((HeadSpec("purposes", ("navigation", "search"), multi_label=True),), encoder=FakeEncoder())
        logits = model(torch.tensor([[1], [2]]), torch.ones(2, 1, dtype=torch.long))
        loss, observed = model.masked_loss(logits, {"purposes": torch.tensor([[1.0, -1.0], [-1.0, 0.0]])})
        self.assertTrue(torch.isfinite(loss))
        self.assertEqual(observed, {"purposes": 2})

    def test_probe_heads_reload_without_serializing_an_encoder(self):
        model = MultiAxisTextProbe((HeadSpec("legacyRole", ("footer", "navigation")),), encoder=FakeEncoder())
        with tempfile.TemporaryDirectory() as directory:
            model.save_probe(directory)
            loaded = MultiAxisTextProbe.load_probe(directory, encoder=FakeEncoder())
            self.assertEqual(tuple(loaded.heads), ("legacyRole",))
            self.assertTrue((model(torch.tensor([[1]]), torch.ones(1, 1, dtype=torch.long))["legacyRole"] == loaded(torch.tensor([[1]]), torch.ones(1, 1, dtype=torch.long))["legacyRole"]).all())

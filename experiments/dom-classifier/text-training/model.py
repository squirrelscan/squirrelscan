"""Small, text-and-DOM-only multi-head probe over a pinned RoBERTa encoder.

The encoder is intentionally frozen in the first baseline.  This keeps the run
small enough for a laptop and makes the saved artifact a *probe*, rather than
misrepresenting it as a full encoder fine-tune.  Heads are independent: a
missing label for one axis never supplies a negative label for another axis.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import json
from typing import Mapping, Sequence

import torch
from torch import Tensor, nn

MODEL_ID = "FacebookAI/roberta-base"
MODEL_REVISION = "e2da8e2f811d1448a5b465c236feacd80ffbac7b"  # pragma: allowlist secret


@dataclass(frozen=True)
class HeadSpec:
    """A closed vocabulary for one independently observed label axis."""

    name: str
    labels: tuple[str, ...]
    multi_label: bool = False


class MultiAxisTextProbe(nn.Module):
    """A frozen transformer encoder with one linear classifier per label axis."""

    def __init__(
        self,
        head_specs: Sequence[HeadSpec],
        *,
        encoder: nn.Module | None = None,
        model_id: str = MODEL_ID,
        revision: str = MODEL_REVISION,
        freeze_encoder: bool = True,
        cache_dir: str | None = None,
    ) -> None:
        super().__init__()
        if not head_specs or any(not spec.labels for spec in head_specs):
            raise ValueError("at least one non-empty head is required")
        if len({spec.name for spec in head_specs}) != len(head_specs):
            raise ValueError("head names must be unique")
        if any(len(set(spec.labels)) != len(spec.labels) for spec in head_specs):
            raise ValueError("head vocabularies must not contain duplicate labels")
        if encoder is None:
            from transformers import AutoModel

            encoder = AutoModel.from_pretrained(model_id, revision=revision, cache_dir=cache_dir)
        self.encoder = encoder
        self.model_id = model_id
        self.revision = revision
        self.freeze_encoder = freeze_encoder
        self.head_specs = tuple(head_specs)
        hidden_size = int(getattr(self.encoder.config, "hidden_size"))
        self.heads = nn.ModuleDict({spec.name: nn.Linear(hidden_size, len(spec.labels)) for spec in head_specs})
        if freeze_encoder:
            for parameter in self.encoder.parameters():
                parameter.requires_grad = False
            self.encoder.eval()

    def train(self, mode: bool = True) -> "MultiAxisTextProbe":
        super().train(mode)
        # ``Module.train`` recurses. Keep frozen dropout inactive even when a
        # caller puts heads in training mode before embedding extraction.
        if self.freeze_encoder:
            self.encoder.eval()
        return self

    def encode(self, input_ids: Tensor, attention_mask: Tensor) -> Tensor:
        # RoBERTa has no pooler in the base model; the first token is its CLS
        # equivalent and gives a fixed-width representation for each candidate.
        output = self.encoder(input_ids=input_ids, attention_mask=attention_mask)
        return output.last_hidden_state[:, 0, :]

    def forward(self, input_ids: Tensor, attention_mask: Tensor) -> dict[str, Tensor]:
        representation = self.encode(input_ids, attention_mask)
        return {name: head(representation) for name, head in self.heads.items()}

    def masked_loss(self, logits: Mapping[str, Tensor], targets: Mapping[str, Tensor]) -> tuple[Tensor, dict[str, int]]:
        """Cross entropy on observed labels only; ``-100`` means unobserved."""
        losses: list[Tensor] = []
        observed: dict[str, int] = {}
        for spec in self.head_specs:
            target = targets.get(spec.name)
            if target is None:
                observed[spec.name] = 0
                continue
            if spec.multi_label:
                if target.ndim != 2 or target.shape[1] != len(spec.labels):
                    raise ValueError(f"multi-label target shape for {spec.name} must be [batch, labels]")
                mask = target.ne(-1)
            else:
                if target.ndim != 1:
                    raise ValueError(f"categorical target shape for {spec.name} must be [batch]")
                mask = target.ne(-100)
            count = int(mask.sum().item())
            observed[spec.name] = count
            if count:
                if spec.multi_label:
                    losses.append(nn.functional.binary_cross_entropy_with_logits(logits[spec.name][mask], target[mask].float()))
                else:
                    losses.append(nn.functional.cross_entropy(logits[spec.name][mask], target[mask]))
        if not losses:
            raise ValueError("batch has no observed labels; missing labels are not negatives")
        return torch.stack(losses).mean(), observed

    def save_probe(self, directory: str | Path) -> None:
        if not self.freeze_encoder:
            raise ValueError("probe artifacts store heads only; unfrozen encoders are unsupported")
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        config = {
            "format": "squirrelscan-text-probe-v1",
            "encoder": {"modelId": self.model_id, "revision": self.revision, "frozen": self.freeze_encoder},
            "heads": [{"name": spec.name, "labels": list(spec.labels), "multiLabel": spec.multi_label} for spec in self.head_specs],
        }
        (directory / "probe-config.json").write_text(json.dumps(config, indent=2, sort_keys=True) + "\n")
        torch.save({name: head.state_dict() for name, head in self.heads.items()}, directory / "probe-heads.pt")

    @classmethod
    def load_probe(cls, directory: str | Path, *, encoder: nn.Module | None = None, cache_dir: str | None = None) -> "MultiAxisTextProbe":
        directory = Path(directory)
        config = json.loads((directory / "probe-config.json").read_text())
        if config.get("format") != "squirrelscan-text-probe-v1":
            raise ValueError("not a text probe artifact")
        specs = tuple(HeadSpec(item["name"], tuple(item["labels"]), bool(item.get("multiLabel", False))) for item in config["heads"])
        instance = cls(specs, encoder=encoder, model_id=config["encoder"]["modelId"], revision=config["encoder"]["revision"], freeze_encoder=bool(config["encoder"].get("frozen")), cache_dir=cache_dir)
        states = torch.load(directory / "probe-heads.pt", map_location="cpu", weights_only=True)
        for name, state in states.items():
            instance.heads[name].load_state_dict(state)
        return instance

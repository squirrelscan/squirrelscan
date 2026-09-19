#!/usr/bin/env python3
"""Frozen RoBERTa embedding comparator; it never fine-tunes the encoder."""

import argparse, hashlib, importlib.util, json, time, sys
from pathlib import Path
import joblib, numpy as np, torch
from transformers import AutoModel, AutoTokenizer

ROOT = Path(__file__).parents[1]
HERE = Path(__file__).parent


def mod(name, path):
    s = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(s)
    sys.modules[name] = m
    s.loader.exec_module(m)
    return m


trainer = mod("frozen_trainer", HERE / "trainer.py")
student = mod("frozen_student", ROOT / "student-training/student.py")
AXES = {
    "node": ("componentType", "regions", "purposes"),
    "page": ("pageTypes", "contentKinds"),
}


def sha(p):
    return "sha256:" + hashlib.sha256(p.read_bytes()).hexdigest()


def read(p):
    return [json.loads(x) for x in p.read_text().splitlines() if x]


def validate_prediction_rows(rows):
    for r in rows:
        if (
            not isinstance(r.get("input"), str)
            or not r["input"]
            or r.get("recordType") not in AXES
            or not isinstance(r.get("pageId"), str)
            or not isinstance(r.get("captureHash"), str)
            or (r["recordType"] == "node" and not isinstance(r.get("nodeId"), str))
            or (r["recordType"] == "page" and r.get("nodeId") is not None)
        ):
            raise ValueError("prediction record identity or input is invalid")


def embed(rows, tokenizer, encoder, device, batch=1):
    if not 1 <= batch <= 4:
        raise ValueError("batch-size must be 1..4")
    out = []
    encoder.eval()
    with torch.no_grad():
        for start in range(0, len(rows), batch):
            t = tokenizer(
                [r["input"] for r in rows[start : start + batch]],
                truncation=True,
                max_length=192,
                padding="max_length",
                return_tensors="pt",
            ).to(device)
            h = encoder(**t).last_hidden_state
            w = t["attention_mask"].unsqueeze(-1)
            out.append(((h * w).sum(1) / w.sum(1).clamp_min(1)).cpu().numpy())
            if (start // batch + 1) % 25 == 0:
                print(
                    json.dumps(
                        {"embedded": min(start + batch, len(rows)), "total": len(rows)}
                    ),
                    flush=True,
                )
    return np.concatenate(out)


def fit(rows, features, labels):
    from scipy.sparse import csr_matrix

    features = csr_matrix(features)
    heads = {}
    for kind in AXES:
        ids = [i for i, r in enumerate(rows) if r["recordType"] == kind]
        for axis in AXES[kind]:
            if axis == "componentType":
                for label in labels[axis]:
                    vals = [
                        (
                            i,
                            float(
                                next(
                                    (
                                        x["probability"]
                                        for x in rows[i]["softTargets"]
                                        .get(axis, {})
                                        .get("distribution", [])
                                        if x["label"] == label
                                    ),
                                    0,
                                )
                            ),
                        )
                        for i in ids
                        if axis in rows[i]["softTargets"]
                    ]
                    if vals:
                        heads[axis, label] = student.fit_binary(
                            features[[i for i, _ in vals]], [v for _, v in vals]
                        )
            else:
                for label in labels[axis]:
                    vals = [
                        (
                            i,
                            float(
                                next(
                                    (
                                        x["yesProbability"]
                                        for x in rows[i]["softTargets"].get(axis, [])
                                        if x["label"] == label
                                    ),
                                    -1,
                                )
                            ),
                        )
                        for i in ids
                        if any(
                            x["label"] == label
                            for x in rows[i]["softTargets"].get(axis, [])
                        )
                    ]
                    if vals:
                        heads[axis, label] = student.fit_binary(
                            features[[i for i, _ in vals]], [v for _, v in vals]
                        )
    return heads


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--manifest", type=Path)
    p.add_argument("--train-records", type=Path)
    p.add_argument("--cache-dir", type=Path, required=True)
    p.add_argument("--output", type=Path)
    p.add_argument("--predict", type=Path)
    p.add_argument("--artifact", type=Path)
    p.add_argument("--device", default="cpu", choices=("cpu", "mps"))
    p.add_argument("--batch-size", type=int, default=1)
    a = p.parse_args()
    device = torch.device(a.device)
    if a.predict:
        if not a.artifact or not a.output:
            raise ValueError("prediction needs artifact and output")
        meta = json.loads((a.artifact / "metadata.json").read_text())
        heads_path = a.artifact / "heads.joblib"
        if (
            meta.get("format") != "squirrelscan-frozen-roberta-heads-v1"
            or meta.get("taxonomyRevision") != trainer.TAXONOMY_REVISION
            or meta.get("encoder", {}).get("modelId") != trainer.MODEL_ID
            or meta.get("encoder", {}).get("revision") != trainer.MODEL_REVISION
            or meta.get("headsSha256") != sha(heads_path)
        ):
            raise ValueError("artifact metadata/hash is incompatible")
        rows = read(a.predict)
        validate_prediction_rows(rows)
        encoder = AutoModel.from_pretrained(
            trainer.MODEL_ID,
            revision=trainer.MODEL_REVISION,
            cache_dir=str(a.cache_dir),
            local_files_only=True,
        ).to(device)
        f = embed(
            rows,
            AutoTokenizer.from_pretrained(
                trainer.MODEL_ID,
                revision=trainer.MODEL_REVISION,
                cache_dir=str(a.cache_dir),
                local_files_only=True,
            ),
            encoder,
            device,
            a.batch_size,
        )
        heads = joblib.load(heads_path)
        out = []
        for i, r in enumerate(rows):
            q = {
                k: r.get(k)
                for k in ("recordType", "pageId", "nodeId", "captureHash", "split")
            }
            for axis in AXES[r["recordType"]]:
                scores = {
                    lab: float(h.predict_proba(f[i : i + 1])[0, 1])
                    for (ax, lab), h in heads.items()
                    if ax == axis
                }
                q[axis] = (
                    {"prediction": max(scores, key=scores.get), "probabilities": scores}
                    if axis == "componentType"
                    else {
                        "probabilities": scores,
                        "positiveLabels": sorted(
                            k for k, v in scores.items() if v >= 0.5
                        ),
                    }
                )
            out.append(q)
        if a.output.exists():
            raise ValueError("output exists")
        a.output.write_text("".join(json.dumps(x, sort_keys=True) + "\n" for x in out))
        return
    if not a.manifest or not a.train_records or not a.output:
        raise ValueError("train needs manifest, train-records and output")
    if a.output.exists():
        raise ValueError("output exists")
    m = json.loads(a.manifest.read_text())
    entries = trainer.manifest_entries(m)
    trainer.require_file_bound(m, a.manifest, a.train_records)
    labels = trainer.taxonomy()
    rows = trainer.validate_rows(read(a.train_records), entries, "train", labels)
    start = time.time()
    encoder = AutoModel.from_pretrained(
        trainer.MODEL_ID,
        revision=trainer.MODEL_REVISION,
        cache_dir=str(a.cache_dir),
        local_files_only=True,
    ).to(device)
    encoder.requires_grad_(False)
    features = embed(
        rows,
        AutoTokenizer.from_pretrained(
            trainer.MODEL_ID,
            revision=trainer.MODEL_REVISION,
            cache_dir=str(a.cache_dir),
            local_files_only=True,
        ),
        encoder,
        device,
        a.batch_size,
    )
    heads = fit(rows, features, labels)
    a.output.mkdir(mode=0o700)
    joblib.dump(heads, a.output / "heads.joblib")
    (a.output / "metadata.json").write_text(
        json.dumps(
            {
                "format": "squirrelscan-frozen-roberta-heads-v1",
                "encoder": {
                    "modelId": trainer.MODEL_ID,
                    "revision": trainer.MODEL_REVISION,
                    "frozen": True,
                },
                "taxonomyRevision": trainer.TAXONOMY_REVISION,
                "trainingRecordsSha256": sha(a.train_records),
                "manifestSha256": sha(a.manifest),
                "pooling": "masked_mean_last_hidden_state; maxLength=192; fixed_padding",
                "batchSize": a.batch_size,
                "seconds": time.time() - start,
                "headsSha256": sha(a.output / "heads.joblib"),
                "supervision": "train-split Jev soft targets only; no Luna or heldout access",
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()

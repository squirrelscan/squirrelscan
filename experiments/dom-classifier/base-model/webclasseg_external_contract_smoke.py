#!/usr/bin/env python3
"""Check the released WebClasSeg model with a few exact public `path_class` rows.

This is an input-contract smoke only, never an accuracy benchmark: the tiny
public sample is not representative and must not be used for selection or fit.
"""

import argparse
import hashlib
import json
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import urlopen

from webclasseg_component_inference import MODEL_ID, MODEL_REVISION, TOKENIZER_ID, TOKENIZER_REVISION, require_private_path

DATASET = "gerbejon/WebClasSeg25-html-nodes-fc-balanced"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private-root", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--count", type=int, default=3)
    args = parser.parse_args()
    if not 1 <= args.count <= 10:
        parser.error("--count must be between 1 and 10")
    root = args.private_root.expanduser().resolve()
    cache, output = (require_private_path(path, root) for path in (args.cache_dir, args.output))
    if output.exists():
        raise FileExistsError(f"refusing to overwrite existing output: {output}")
    query = urlencode({"dataset": DATASET, "config": "default", "split": "test", "offset": 0, "length": args.count})
    with urlopen(f"https://datasets-server.huggingface.co/rows?{query}", timeout=30) as response:
        payload = json.loads(response.read())
    fetched_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    rows = payload["rows"]
    from transformers import AutoModelForSequenceClassification, AutoTokenizer
    import torch
    tokenizer = AutoTokenizer.from_pretrained(TOKENIZER_ID, revision=TOKENIZER_REVISION, cache_dir=str(cache))
    model = AutoModelForSequenceClassification.from_pretrained(MODEL_ID, revision=MODEL_REVISION, cache_dir=str(cache)).eval()
    labels = {int(key): value for key, value in model.config.id2label.items()}
    records = []
    with torch.inference_mode():
        for item in rows:
            row = item["row"]
            text = row["path_class"]
            logits = model(**tokenizer([text], return_tensors="pt", truncation=True, max_length=512)).logits.softmax(dim=-1)[0].tolist()
            index = max(range(len(logits)), key=logits.__getitem__)
            records.append({"schemaVersion": 1, "kind": "external_exact_serializer_contract_smoke", "dataset": {"id": DATASET, "revision": None, "revisionStatus": "unpinned live rows endpoint"}, "fetchedAt": fetched_at, "datasetSplit": "test", "datasetRow": item["row_idx"], "expectedLabel": row["y"], "predictedLabel": labels[index], "input": {"serializer": "upstream path_class exact", "sha256": hashlib.sha256(text.encode()).hexdigest()}, "model": {"id": MODEL_ID, "revision": MODEL_REVISION}, "notAnAccuracyMetric": True})
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")
    print(json.dumps({"rows": len(records), "matches": sum(row["expectedLabel"] == row["predictedLabel"] for row in records), "output": str(output)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

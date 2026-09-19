#!/usr/bin/env python3
"""Join disjoint accepted Luna batches to their exact frozen packet identities."""

import argparse
import hashlib
import json
from pathlib import Path


def rows(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def digest(path):
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--packets", required=True, type=Path)
    parser.add_argument("--shard", required=True, action="append", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("joined label artifact already exists")
    packets = rows(args.packets)
    index = {row["packetId"]: row for row in packets}
    accepted = [row for path in args.shard for row in rows(path)]
    if (
        len(index) != len(packets)
        or len({r["packetId"] for r in accepted}) != len(accepted)
        or {r["packetId"] for r in accepted} != set(index)
    ):
        raise ValueError("shards must cover every frozen packet exactly once")
    result = []
    for row in accepted:
        packet = index[row["packetId"]]
        for field in (
            "recordType",
            "pageId",
            "nodeId",
            "captureHash",
            "inputSha256",
            "input",
            "taxonomyRevision",
        ):
            if row.get(field) != packet.get(field):
                raise ValueError(f"accepted row differs from frozen packet: {field}")
        if (
            row.get("source") != "luna"
            or row.get("gold") is not False
            or row.get("model") != "gpt-5.6-luna"
            or not row.get("lunaRun")
        ):
            raise ValueError("accepted row lacks independent Luna provenance")
        if row.get("split", packet["split"]) != packet["split"]:
            raise ValueError("accepted row conflicts with frozen split")
        result.append({**row, "split": packet["split"]})
    result.sort(key=lambda row: row["packetId"])
    args.output.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in result)
    )
    args.output.with_suffix(".manifest.json").write_text(
        json.dumps(
            {
                "packetsSha256": digest(args.packets),
                "labelFileSha256": digest(args.output),
                "shards": [
                    {"name": path.parent.name, "sha256": digest(path)}
                    for path in args.shard
                ],
                "records": len(result),
                "splitSource": "exact frozen packet identity join; never model-inferred",
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()

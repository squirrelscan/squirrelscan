#!/usr/bin/env python3
"""Resumable orchestration for the private diverse-500 synthetic experiment.

It freezes the supplied QA manifest before Jev reads it, then invokes Jev in
bounded chunks. Subsequent packet/materialization stages consume only the
frozen JSONL, never the mutable QA source.
"""

import argparse, hashlib, json, os, subprocess, sys
from pathlib import Path

DATA_ROOT = Path(os.environ["DOM_CLASSIFIER_DATA_ROOT"])
ROOT = DATA_ROOT / "2026-09-19" / "diverse-500-v1"
EXP = Path(__file__).parents[1]


def run(cmd, env=None):
    subprocess.run(cmd, check=True, env=env)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--qa-manifest", type=Path, required=True)
    p.add_argument("--qa-root", type=Path, required=True)
    p.add_argument("--run", required=True)
    p.add_argument("--chunk-size", type=int, default=200)
    p.add_argument("--max-candidates", type=int, default=6)
    p.add_argument("--limit", type=int)
    p.add_argument("--expected-pages", type=int)
    p.add_argument("--jev-only", action="store_true")
    a = p.parse_args()
    if not 1 <= a.chunk_size <= 200 or not 3 <= a.max_candidates <= 6:
        raise ValueError("chunk-size 1..200; candidates 3..6")
    out = ROOT / "labeling-runtime" / a.run
    if out.exists():
        raise ValueError("run directory already exists")
    out.mkdir(parents=True, mode=0o700)
    frozen = out / "frozen-split-manifest.jsonl"
    run(
        [
            sys.executable,
            str(Path(__file__).with_name("freeze_diverse_manifest.py")),
            "--source",
            str(a.qa_manifest),
            "--captures",
            str(a.qa_root),
            "--output",
            str(frozen),
        ]
    )
    rows = [json.loads(x) for x in frozen.read_text().splitlines() if x]
    if a.limit is not None:
        if a.limit < 1:
            raise ValueError("--limit must be positive")
        rows = rows[: a.limit]
        frozen.write_text(
            "\n".join(json.dumps(row, sort_keys=True) for row in rows) + "\n"
        )
    if a.expected_pages is not None and len(rows) != a.expected_pages:
        raise ValueError("frozen page count does not match --expected-pages")
    if len(rows) < 2:
        raise ValueError("need at least two accepted captures")
    # Preserve capture membership in per-chunk directories without copying capture data.
    captures = out / "jev-chunks"
    captures.mkdir()
    env = {**os.environ}
    # Path to a private credentials env file; never stored in this repository.
    secret = os.environ["TYPESAFE_ENV_FILE"]
    for n, start in enumerate(range(0, len(rows), a.chunk_size), 1):
        d = captures / f"{n:03d}"
        d.mkdir()
        for r in rows[start : start + a.chunk_size]:
            os.symlink((a.qa_root / r["path"]).resolve(), d / f"{r['pageId']}.json")
        target = out / f"jev-{n:03d}.jsonl"
        run(
            [
                "bun",
                f"--env-file={secret}",
                str(EXP / "model-suggestions/generate-jev.ts"),
                "--input",
                str(d),
                "--output",
                str(target),
                "--limit",
                str(len(rows[start : start + a.chunk_size])),
                "--max-candidates",
                str(a.max_candidates),
            ],
            env,
        )
    manifest = {
        "taxonomyRevision": "dom-taxonomy-v2",
        "run": a.run,
        "sourceManifestSha256": "sha256:"
        + hashlib.sha256(a.qa_manifest.read_bytes()).hexdigest(),
        "frozenSplitManifestSha256": "sha256:"
        + hashlib.sha256(frozen.read_bytes()).hexdigest(),
        "pages": len(rows),
        "jevFiles": [x.name for x in sorted(out.glob("jev-*.jsonl"))],
        "policy": "Jev all pages; independent Luna heldout plus train QA; Luna does not alter Jev targets",
    }
    (out / "run-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    )
    print(
        json.dumps(
            {
                "run": str(out),
                "pages": len(rows),
                "jevChunks": len(manifest["jevFiles"]),
            }
        )
    )


if __name__ == "__main__":
    main()

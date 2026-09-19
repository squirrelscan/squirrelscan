#!/usr/bin/env python3
"""Materialize frozen diverse captures into hash-bound training inputs.

No model is called here.  The utility validates Jev's canonical v4 request
state against each capture, writes train-only teacher targets, and makes blind
Luna packets that cannot contain teacher labels or confidence values.
"""

from __future__ import annotations
import argparse, hashlib, json, math, re, subprocess
from collections import defaultdict
from pathlib import Path
from typing import Any

TAXONOMY = "dom-taxonomy-v2"
MODEL = "jev-1.13.0"
PROMPT = "dom-suggestions-v4"
SPLITS = {"train", "validation", "test"}
URL = re.compile(r"(?:https?://|www\.)\S+", re.I)
EMAIL = re.compile(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b")
SECRET = re.compile(
    r"(?i)\b(?:api[_ -]?key|token|secret|password|passwd|authorization)\s*(?:=|:|\bis\b)\s*[^\s,;]{6,}"
)
SPACE = re.compile(r"\s+")


def h(s: str) -> str:
    return "sha256:" + hashlib.sha256(s.encode("utf-8", "surrogatepass")).hexdigest()


def hf(p: Path) -> str:
    return "sha256:" + hashlib.sha256(p.read_bytes()).hexdigest()


def rows(p: Path) -> list[dict[str, Any]]:
    if not p.is_file():
        raise ValueError(f"missing JSONL input: {p}")
    out = []
    for n, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
        if line.strip():
            x = json.loads(line)
            if not isinstance(x, dict):
                raise ValueError(f"{p}:{n} is not an object")
            out.append(x)
    return out


def write(p: Path, xs: list[dict[str, Any]]):
    p.write_text(
        "".join(json.dumps(x, sort_keys=True) + "\n" for x in xs), encoding="utf-8"
    )


def clean(v: Any, limit=512) -> str:
    if not isinstance(v, str):
        return ""
    return SPACE.sub(
        " ", SECRET.sub("[secret]", EMAIL.sub("[email]", URL.sub("[url]", v)))
    ).strip()[:limit]


def node_input(cap: dict[str, Any], nid: str) -> str:
    ns = cap.get("nodes")
    by = (
        {
            n.get("id"): n
            for n in ns
            if isinstance(n, dict) and isinstance(n.get("id"), str)
        }
        if isinstance(ns, list)
        else {}
    )
    n = by.get(nid)
    if not isinstance(n, dict) or not isinstance(n.get("tag"), str) or "text" not in n:
        raise ValueError(f"capture lacks usable node {nid}")
    a = []
    cur = n
    while len(a) < 8 and isinstance(cur.get("parentId"), str):
        cur = by.get(cur["parentId"])
        if not isinstance(cur, dict):
            break
        if isinstance(cur.get("tag"), str):
            a.append(cur["tag"].strip().lower())
    return f"runtime-dom-text-v1\ntag={n['tag'].strip().lower()}\nancestors={'>'.join(reversed(a))}\ntext={clean(n.get('text')) or '[empty]'}"


def page_input(cap: dict[str, Any]) -> str:
    ns = cap.get("nodes")
    if not isinstance(ns, list):
        raise ValueError("capture nodes must be an array")
    parents = {
        n.get("parentId")
        for n in ns
        if isinstance(n, dict) and isinstance(n.get("parentId"), str)
    }
    parts = [clean(cap.get("title"), 256)]
    seen = set(parts)
    for n in ns:
        if isinstance(n, dict) and n.get("id") not in parents:
            t = clean(n.get("text"))
            if t and t not in seen:
                seen.add(t)
                parts.append(t)
    return "dom-page-text-v1\ntext=" + "\n".join(x for x in parts if x)[:24000]


def state_hashes(caps: dict[str, dict[str, Any]], adapter: Path) -> dict[str, str]:
    # Delegate only canonical state reconstruction to the versioned adapter; this
    # neither contacts an API nor emits its URL/geometry-bearing state to disk.
    code = "const {buildRequest,snapshotHashForState}=await import(process.argv[1]); const xs=JSON.parse(await Bun.stdin.text()); for (const [id,p] of Object.entries(xs)) console.log(JSON.stringify([id,snapshotHashForState(buildRequest(p,6).state)]));"
    r = subprocess.run(
        ["bun", "-e", code, str(adapter)],
        input=json.dumps(caps),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if r.returncode or not r.stdout.strip():
        raise ValueError(
            "cannot verify Jev state with canonical v4 adapter: "
            + r.stderr.strip()[:300]
        )
    out = {}
    for line in r.stdout.splitlines():
        pid, digest = json.loads(line)
        if not isinstance(pid, str) or not isinstance(digest, str):
            raise ValueError("canonical v4 state verifier returned invalid hash")
        out[pid] = digest
    if set(out) != set(caps):
        raise ValueError("canonical v4 state verifier did not cover every capture")
    return out


def vocabulary() -> dict[str, set[str]]:
    v = json.loads((Path(__file__).parents[1] / "taxonomy.json").read_text())
    if v.get("taxonomyRevision") != TAXONOMY or not isinstance(
        v.get("allowedLabels"), dict
    ):
        raise ValueError("frozen taxonomy is invalid")
    out = {
        "regions": set(v["allowedLabels"].get("regions", [])),
        "purposes": set(v["allowedLabels"].get("purposes", [])),
        "componentType": set(v["allowedLabels"].get("componentTypes", [])),
        "pageTypes": set(v["allowedLabels"].get("pageTypes", [])),
        "contentKinds": set(v["allowedLabels"].get("contentKinds", [])),
    }
    if any(not x for x in out.values()):
        raise ValueError("frozen taxonomy lacks an axis vocabulary")
    return out


def probability(v: Any) -> None:
    if (
        not isinstance(v, (int, float))
        or isinstance(v, bool)
        or not math.isfinite(v)
        or not 0 <= v <= 1
    ):
        raise ValueError("Jev soft-target probability is invalid")


def targets(j: dict[str, Any], labels: dict[str, set[str]]) -> dict[str, Any]:
    axes = j.get("axisProbabilities")
    if not isinstance(axes, dict):
        raise ValueError("Jev row lacks axisProbabilities")
    allowed = (
        {"regions", "purposes"}
        if j["nodeId"] is not None
        else {"pageTypes", "contentKinds"}
    )
    out = {k: v for k, v in axes.items() if k in allowed and isinstance(v, list) and v}
    for axis, values in out.items():
        seen = set()
        for item in values:
            if (
                not isinstance(item, dict)
                or item.get("label") not in labels[axis]
                or item["label"] in seen
            ):
                raise ValueError(f"Jev {axis} soft-target label is invalid")
            probability(item.get("yesProbability"))
            seen.add(item["label"])
    if j["nodeId"] is not None:
        c = j.get("componentTypeChoice")
        if (
            isinstance(c, dict)
            and isinstance(c.get("distribution"), list)
            and c["distribution"]
        ):
            seen = set()
            total = 0.0
            for item in c["distribution"]:
                if (
                    not isinstance(item, dict)
                    or item.get("label") not in labels["componentType"]
                    or item["label"] in seen
                ):
                    raise ValueError("Jev componentType soft-target label is invalid")
                probability(item.get("probability"))
                seen.add(item["label"])
                total += item["probability"]
            if (
                not isinstance(c.get("choice"), str)
                or c["choice"] not in labels["componentType"]
                or abs(total - 1) > 0.011
            ):
                raise ValueError("Jev componentType distribution is invalid")
            out["componentType"] = {
                k: c.get(k) for k in ("choice", "confidence", "distribution")
            }
    need = (
        {"regions", "purposes", "componentType"}
        if j["nodeId"] is not None
        else {"pageTypes", "contentKinds"}
    )
    if set(out) != need:
        raise ValueError("Jev row omits a required observed soft-target axis")
    return out


def meaningful(j: dict[str, Any]) -> bool:
    mapped = j.get("mappedLabels", {})
    if not isinstance(mapped, dict):
        return False
    return any(
        isinstance(mapped.get(axis), list)
        and any(isinstance(label, str) and label != "unknown" for label in mapped[axis])
        for axis in ("regions", "purposes")
    ) or (
        isinstance(mapped.get("componentType"), str)
        and mapped["componentType"] != "unknown"
    )


def choose(ns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rank = lambda r: hashlib.sha256(
        ("luna-diverse-v1\0" + r["pageId"] + "\0" + r["nodeId"]).encode()
    ).hexdigest()
    tags = defaultdict(list)
    for r in ns:
        tags[r["input"].split("\n", 2)[1]].append(r)
    got = sorted((min(v, key=rank) for v in tags.values()), key=rank)
    got += sorted((r for v in tags.values() for r in v if r not in got), key=rank)
    if len(got) < 3:
        raise ValueError("page has fewer than three valid Jev node targets")
    return got[:3]


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--qa-root", type=Path, required=True)
    a.add_argument(
        "--frozen-manifest", "--frozen", dest="frozen", type=Path, required=True
    )
    a.add_argument("--jev", type=Path, action="append", required=True)
    a.add_argument("--output", type=Path, required=True)
    a.add_argument("--train-qa-pages", type=int, default=50)
    x = a.parse_args()
    if x.output.exists():
        raise ValueError("output already exists; materialized artifacts are immutable")
    if x.train_qa_pages < 1:
        raise ValueError("--train-qa-pages must be positive")
    frozen = rows(x.frozen)
    fm = {r.get("pageId"): r for r in frozen}
    if (
        not frozen
        or len(fm) != len(frozen)
        or any(
            not isinstance(r.get("pageId"), str)
            or r.get("split") not in SPLITS
            or not isinstance(r.get("path"), str)
            or not isinstance(r.get("captureHash"), str)
            for r in frozen
        )
    ):
        raise ValueError(
            "frozen manifest has duplicate or invalid page identities/splits"
        )
    labels = vocabulary()
    adapter = Path(__file__).parents[1] / "model-suggestions/jev-adapter.ts"
    caps = {}
    for pid, f in fm.items():
        p = x.qa_root / f["path"]
        if not p.is_file():
            raise ValueError(f"frozen capture missing: {p}")
        cap = json.loads(p.read_text(encoding="utf-8"))
        if (
            not isinstance(cap, dict)
            or cap.get("id") != pid
            or cap.get("captureHash") != f["captureHash"]
        ):
            raise ValueError("capture does not match frozen page/capture identity")
        caps[pid] = cap
    states = state_hashes(caps, adapter)
    index = {}
    for j in [r for p in x.jev for r in rows(p)]:
        req = {
            "id",
            "provider",
            "modelId",
            "modelRevision",
            "promptRevision",
            "taxonomyRevision",
            "pageId",
            "nodeId",
            "captureHash",
            "snapshotHash",
            "rawAnswers",
            "provisional",
            "axisProbabilities",
        }
        if not req <= set(j):
            raise ValueError("Jev row lacks required v4 identity fields")
        pid = j.get("pageId")
        if pid not in fm:
            raise ValueError("Jev row references page absent from frozen manifest")
        if (
            j.get("provider"),
            j.get("modelId"),
            j.get("modelRevision"),
            j.get("promptRevision"),
            j.get("taxonomyRevision"),
            j.get("provisional"),
        ) != ("typesafe", MODEL, MODEL, PROMPT, TAXONOMY, True):
            raise ValueError(
                "Jev row has wrong provider/model/prompt/taxonomy identity"
            )
        if (
            j.get("captureHash") != fm[pid]["captureHash"]
            or j.get("snapshotHash") != states[pid]
        ):
            raise ValueError(
                f"Jev row is stale or mismatched to its frozen capture/state: {pid}"
            )
        if not isinstance(j.get("id"), str) or not isinstance(
            j.get("rawAnswers"), dict
        ):
            raise ValueError("Jev row has invalid source identity or answers")
        kind = "page" if j["nodeId"] is None else "node"
        if kind == "node" and j["nodeId"] not in {
            n.get("id") for n in caps[pid].get("nodes", []) if isinstance(n, dict)
        }:
            raise ValueError("Jev nodeId does not exist in frozen capture")
        key = (kind, pid, j["nodeId"], j["captureHash"])
        if key in index:
            raise ValueError("duplicate Jev source identity")
        targets(j, labels)
        index[key] = j
    material = []
    pgs = {}
    nodes = defaultdict(list)
    for (kind, pid, nid, ch), j in index.items():
        inp = page_input(caps[pid]) if kind == "page" else node_input(caps[pid], nid)
        teacher = {
            "id": j["id"],
            "modelId": MODEL,
            "modelRevision": MODEL,
            "promptRevision": PROMPT,
            "snapshotHash": j["snapshotHash"],
        }
        r = {
            "recordType": kind,
            "pageId": pid,
            "nodeId": nid,
            "captureHash": ch,
            "split": fm[pid]["split"],
            "taxonomyRevision": TAXONOMY,
            "input": inp,
            "inputSha256": h(inp),
            "source": "jev",
            "gold": False,
            "softTargets": targets(j, labels),
            "teacherIdentity": teacher,
            "provenance": teacher,
            "meaningfulTeacherEvidence": meaningful(j),
        }
        material.append(r)
        if kind == "page":
            pgs[pid] = r
        else:
            nodes[pid].append(r)
    gaps = []
    for pid in fm:
        if pid not in pgs or len(nodes[pid]) != 6:
            raise ValueError(
                "each frozen page needs one Jev page row and exactly six node rows"
            )
        count = sum(r["meaningfulTeacherEvidence"] for r in nodes[pid])
        if count < 3:
            gaps.append(
                {
                    "pageId": pid,
                    "split": fm[pid]["split"],
                    "meaningfulNodeTargets": count,
                    "unknownOrInsufficientNodeTargets": 6 - count,
                }
            )
    if gaps:
        gap_path = Path(str(x.output) + ".coverage-gaps.json")
        gap_path.write_text(
            json.dumps(
                {
                    "policy": "need at least three non-unknown Jev node targets per frozen page; uncertain labels remain in source and are not dropped",
                    "gaps": gaps,
                },
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )
        raise ValueError(
            f"meaningful Jev node coverage is incomplete; repair report: {gap_path}"
        )
    x.output.mkdir(parents=True, mode=0o700)
    key = lambda r: (r["recordType"], r["pageId"], r["nodeId"] or "", r["captureHash"])
    train = sorted((r for r in material if r["split"] == "train"), key=key)
    validation = sorted((r for r in material if r["split"] == "validation"), key=key)
    test = sorted((r for r in material if r["split"] == "test"), key=key)
    held = validation + test
    write(x.output / "train-jev.jsonl", train)
    write(x.output / "validation-jev.jsonl", validation)
    write(x.output / "test-jev.jsonl", test)
    picked = sorted(
        (r for r in frozen if r["split"] == "train"),
        key=lambda r: hashlib.sha256(
            ("luna-train-qa-v1\0" + r["pageId"]).encode()
        ).hexdigest(),
    )
    if len(picked) < x.train_qa_pages:
        raise ValueError("frozen train split has fewer pages than --train-qa-pages")
    selected = [r for r in frozen if r["split"] != "train"] + picked[: x.train_qa_pages]
    packets = []
    for f in sorted(selected, key=lambda r: r["pageId"]):
        pid = f["pageId"]
        rs = [pgs[pid]]
        rs += choose(nodes[pid])
        for r in rs:
            q = {
                k: r[k]
                for k in (
                    "recordType",
                    "pageId",
                    "nodeId",
                    "captureHash",
                    "split",
                    "taxonomyRevision",
                    "input",
                    "inputSha256",
                )
            }
            q["packetId"] = (
                "luna_"
                + hashlib.sha256(
                    (r["recordType"] + "\0" + pid + "\0" + str(r["nodeId"])).encode()
                ).hexdigest()[:20]
            )
            packets.append(q)
    if any(
        any(
            k in q
            for k in ("softTargets", "teacherIdentity", "provenance", "source", "gold")
        )
        for q in packets
    ):
        raise AssertionError("teacher data leaked into Luna packet")
    write(x.output / "luna-blind-packets.jsonl", packets)
    manifest = {
        "format": "squirrelscan-diverse-materialized-v1",
        "taxonomyRevision": TAXONOMY,
        "frozenManifestSha256": hf(x.frozen),
        "jevFiles": [{"path": str(p), "sha256": hf(p)} for p in x.jev],
        "trainingFiles": [
            {"path": "train-jev.jsonl", "sha256": hf(x.output / "train-jev.jsonl")},
            {
                "path": "validation-jev.jsonl",
                "sha256": hf(x.output / "validation-jev.jsonl"),
            },
        ],
        "trainingRecords": [
            {
                k: r[k]
                for k in (
                    "recordType",
                    "pageId",
                    "nodeId",
                    "captureHash",
                    "split",
                    "inputSha256",
                )
            }
            for r in train + validation
        ],
        "heldoutRecords": [
            {
                k: r[k]
                for k in (
                    "recordType",
                    "pageId",
                    "nodeId",
                    "captureHash",
                    "split",
                    "inputSha256",
                )
            }
            for r in held
        ],
        "lunaPackets": {
            "path": "luna-blind-packets.jsonl",
            "sha256": hf(x.output / "luna-blind-packets.jsonl"),
            "policy": "every heldout page plus 3 label-blind node targets; fixed 50 train pages plus 3 node targets",
            "counts": {
                "total": len(packets),
                "train": sum(q["split"] == "train" for q in packets),
                "validation": sum(q["split"] == "validation" for q in packets),
                "test": sum(q["split"] == "test" for q in packets),
            },
        },
        "policy": "sparse training uses only train-split Jev soft targets; validation/test stay separate; omitted axes are never negatives",
    }
    (x.output / "frozen-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    )
    print(
        json.dumps(
            {
                "pages": len(frozen),
                "trainRecords": len(train),
                "heldoutRecords": len(held),
                "lunaPackets": len(packets),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()

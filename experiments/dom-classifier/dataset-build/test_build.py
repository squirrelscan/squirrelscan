import importlib.util
import json
import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory


ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location("dataset_build", ROOT / "build.py")
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(module)


def page(page_id, domain, content_hash):
    return {"id": page_id, "_etldPlusOne": domain, "contentHash": content_hash}


def test_assignment_is_label_independent_and_groups_duplicates():
    pages = [
        page("a", "a.example", "same"),
        page("b", "b.example", "same"),
        page("c", "c.example", "other"),
        page("d", "d.example", "other-2"),
    ]
    first, metadata = module.assignments(pages, {"c.example"})
    second, _ = module.assignments(list(reversed(pages)), {"c.example"})
    assert first == second
    domains = metadata["domainToComponent"]
    assert domains["a.example"] == domains["b.example"]
    assert first[domains["a.example"]] == first[domains["b.example"]]
    assert first[domains["c.example"]] == "train"


def test_weak_targets_keep_probabilities_and_do_not_invent_negatives():
    target = module.weak_targets({"provider": "typesafe", "provisional": True, "axisProbabilities": {"regions": [{"label": "footer", "yesProbability": 0.2}]}, "mappedLabels": {"purposes": ["share"]}})
    assert target["regions"] == [{"label": "footer", "yesProbability": 0.2}]
    assert "purposes" not in target
    assert target["mappedPositiveLabels"] == {"purposes": ["share"]}


def test_undo_restores_predecessor_and_removes_sole_annotation():
    earlier = {"id": "a1", "pageId": "p", "nodeId": "n", "captureHash": "h", "decision": "label"}
    current = {
        "id": "a2", "pageId": "p", "nodeId": "n", "captureHash": "h",
        "decision": "label", "supersedes": "a1",
    }
    undo = {"actionKind": "annotation", "actionId": "a2"}
    assert module.effective_annotations([earlier, current], [undo]) == {
        ("p", "n", "h"): earlier
    }
    assert module.effective_annotations([earlier], [{"actionKind": "annotation", "actionId": "a1"}]) == {}


def test_end_to_end_snapshot_keeps_teacher_blind_holdouts_and_quarantines_duplicates():
    with TemporaryDirectory() as temporary:
        root = Path(temporary)
        snapshot = root / "snapshot"; captures = snapshot / "audit" / "captures"; captures.mkdir(parents=True)
        def capture(page_id, text):
            return {"id": page_id, "title": page_id, "captureHash": f"sha256:{page_id}", "contentHash": f"sha256:{page_id}", "nodes": [{"id": "n", "parentId": None, "tag": "button", "text": text, "rect": {"width": 1, "height": 1}}, {"id": "unique", "parentId": None, "tag": "p", "text": page_id, "rect": {"width": 1, "height": 1}}]}
        pages = [capture("page_a", "same"), capture("page_b", "same"), capture("page_c", "other")]
        entries = []
        for value in pages:
            path = captures / f"{value['id']}.json"; path.write_text(json.dumps(value)); entries.append({"pageId": value["id"], "sourceSha256": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()})
        annotations = {"id": "a1", "pageId": "page_a", "nodeId": "n", "decision": "reject", "boundary": "correct"}
        (snapshot / "audit" / "annotations.jsonl").write_text(json.dumps(annotations) + "\n")
        suggestions = []
        for value in pages:
            suggestions.extend([{"id": f"p-{value['id']}", "pageId": value["id"], "nodeId": None, "captureHash": value["captureHash"], "provider": "typesafe", "provisional": True, "modelId": "jev", "modelRevision": "r", "promptRevision": "p", "snapshotHash": "s", "axisProbabilities": {"pageTypes": [{"label": "docs_article", "yesProbability": .5}]}, "mappedLabels": {}}, {"id": f"n-{value['id']}", "pageId": value["id"], "nodeId": "n", "captureHash": value["captureHash"], "provider": "typesafe", "provisional": True, "modelId": "jev", "modelRevision": "r", "promptRevision": "p", "snapshotHash": "s", "axisProbabilities": {"regions": [{"label": "footer", "yesProbability": .5}]}, "mappedLabels": {}}])
        suggestion_path = snapshot / "audit" / "model-suggestions.jsonl"; suggestion_path.write_text("".join(json.dumps(x) + "\n" for x in suggestions))
        annotation_path = snapshot / "audit" / "annotations.jsonl"
        (snapshot / "node-examples.jsonl").write_text("")
        (snapshot / "manifest.json").write_text(json.dumps({"input": {"auditFiles": [{"path": "audit/annotations.jsonl", "sha256": "sha256:" + hashlib.sha256(annotation_path.read_bytes()).hexdigest()}, {"path": "audit/model-suggestions.jsonl", "sha256": "sha256:" + hashlib.sha256(suggestion_path.read_bytes()).hexdigest()}]}, "captureEntries": entries}))
        groups = root / "groups.json"; groups.write_text(json.dumps([{"pageId": "page_a", "groupId": "old.example"}, {"pageId": "page_b", "groupId": "b.example"}, {"pageId": "page_c", "groupId": "c.example"}]))
        v2 = root / "v2"; v2.mkdir(); (v2 / "page-provenance.jsonl").write_text(json.dumps({"sourceRow": {"registrableDomain": "old.example"}}) + "\n")
        output = root / "out"
        original_assignments = module.assignments
        module.assignments = lambda *_: ({"page_a": "train", "page_b": "validation", "page_c": "test"}, {"domainToComponent": {"old.example": "page_a", "b.example": "page_b", "c.example": "page_c"}, "components": {}, "oldV2Domains": ["old.example"], "oldV2ComponentsForcedTrain": ["page_a"], "pageCounts": {"train": 1, "validation": 1, "test": 1}})
        try:
            manifest = module.run(snapshot, output, v2, ROOT.parent, groups)
        finally:
            module.assignments = original_assignments
        assert manifest["counts"]["inputExclusions"] == 0
        assert manifest["counts"]["crossSplitNodeInputExclusions"] >= 1
        for split in ("validation", "test"):
            for row in map(json.loads, (output / f"{split}-pending-human-review.jsonl").read_text().splitlines()):
                assert "softTargets" not in row and "provenance" not in row
        weak_path = output / "node-train-weak.jsonl"
        weak = [json.loads(line) for line in weak_path.read_text().splitlines()] if weak_path.exists() else []
        assert all(row["pageId"] != "page_a" for row in weak)  # current reject suppresses weak training

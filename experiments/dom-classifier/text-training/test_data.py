import json
from pathlib import Path

import pytest

from data import SERIALIZER_VERSION, load_v2, serialize_candidate


def candidate(candidate_id="c1", site="s1", template="t1", group="g1", text="Read the story"):
    return {
        "candidateId": candidate_id,
        "siteId": site,
        "node": {
            "tag": "article",
            "ancestorTags": ["html", "body", "main"],
            "text": text,
            "locator": "html[0]/body[0]/article[0]",
            "classTokens": ["secret-class"],
        },
        "weakSignals": {"node": {"semanticLandmark": True}},
        "splitGroupId": group,
        "templateFamilyId": template,
    }


def test_serializer_is_deterministic_and_annotation_independent():
    left = candidate(text="Read https://example.test/story from a@example.test")
    right = candidate(text=left["node"]["text"])
    left["node"]["roles"] = ["model-prediction"]
    left["node"]["context"] = "teacher hint"
    left["weakSignals"]["node"]["semanticLandmark"] = False
    assert serialize_candidate(left) == serialize_candidate(right)
    assert "https://" not in serialize_candidate(left)
    assert "@example" not in serialize_candidate(left)
    assert SERIALIZER_VERSION in serialize_candidate(left)


def test_serializer_rejects_malformed_dom():
    with pytest.raises(ValueError, match="ancestorTags"):
        serialize_candidate({"node": {"tag": "p", "ancestorTags": "body", "text": "x"}})
    assert "text=[empty]" in serialize_candidate({"node": {"tag": "p", "ancestorTags": [], "text": ""}})
    with pytest.raises(ValueError, match="present"):
        serialize_candidate({"node": {"tag": "p", "ancestorTags": []}})


def test_v2_rejects_split_group_leakage(tmp_path: Path):
    root = tmp_path
    (root / "training").mkdir()
    (root / "labels").mkdir()
    (root / "manifest.json").write_text(json.dumps({"corpusVersion": "c", "annotationVersionExpected": "a", "annotation": {"goldLabelsPresent": False}}))
    (root / "labels" / "qa-summary.json").write_text(json.dumps({"status": "passed", "unresolvedConflicts": 0}))
    row = candidate()
    (root / "candidates.jsonl").write_text(json.dumps(row) + "\n")
    (root / "split-groups.jsonl").write_text(json.dumps({"candidateId": "c1", "siteId": "s1", "templateFamilyId": "t1", "splitGroupId": "g1"}) + "\n")
    (root / "training" / "split-manifest.json").write_text(json.dumps({"corpusVersion": "c", "annotationVersion": "a", "assignments": [{"candidateId": "c1", "splitGroupId": "g2", "templateFamilyId": "t1", "split": "train"}]}))
    (root / "labels" / "annotations.jsonl").write_text(json.dumps({"candidateId": "c1", "label": "card", "corpusVersion": "c", "annotationVersion": "a", "source": "luna", "gold": False}) + "\n")
    with pytest.raises(ValueError, match="frozen assignment"):
        load_v2(root)


def test_v2_rejects_annotation_contamination(tmp_path: Path):
    root = tmp_path
    (root / "training").mkdir()
    (root / "labels").mkdir()
    (root / "manifest.json").write_text(json.dumps({"corpusVersion": "c", "annotationVersionExpected": "a", "annotation": {"goldLabelsPresent": False}}))
    (root / "labels" / "qa-summary.json").write_text(json.dumps({"status": "passed", "unresolvedConflicts": 0}))
    rows = [candidate("c1", group="g1"), candidate("c2", site="s2", template="t2", group="g2"), candidate("c3", site="s3", template="t3", group="g3")]
    (root / "candidates.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    (root / "split-groups.jsonl").write_text("\n".join(json.dumps({"candidateId": r["candidateId"], "siteId": r["siteId"], "templateFamilyId": r["templateFamilyId"], "splitGroupId": r["splitGroupId"]}) for r in rows) + "\n")
    (root / "training" / "split-manifest.json").write_text(json.dumps({"corpusVersion": "c", "annotationVersion": "a", "assignments": [{"candidateId": "c1", "splitGroupId": "g1", "templateFamilyId": "t1", "split": "train"}, {"candidateId": "c2", "splitGroupId": "g2", "templateFamilyId": "t2", "split": "validation"}, {"candidateId": "c3", "splitGroupId": "g3", "templateFamilyId": "t3", "split": "test"}]}))
    label = {"candidateId": "c1", "label": "card", "corpusVersion": "c", "annotationVersion": "a", "source": "luna", "gold": False, "prediction": "main_content"}
    (root / "labels" / "annotations.jsonl").write_text(json.dumps(label) + "\n")
    dataset = load_v2(root)
    assert dataset.splits["train"][0].labels == ("card",)
    assert "prediction" not in dataset.as_training_rows()["train"][0]["text"]


def test_v2_requires_passed_qa_summary(tmp_path: Path):
    (tmp_path / "training").mkdir()
    (tmp_path / "labels").mkdir()
    (tmp_path / "manifest.json").write_text(json.dumps({"corpusVersion": "c", "annotationVersionExpected": "a", "annotation": {"goldLabelsPresent": False}}))
    with pytest.raises(ValueError, match="QA summary is required"):
        load_v2(tmp_path)

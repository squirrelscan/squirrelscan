import importlib.util
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("weborganizer_inference.py")
SPEC = importlib.util.spec_from_file_location("weborganizer_inference", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_capture_text_uses_visible_leaves_and_is_bounded() -> None:
    capture = {"title": "Title", "nodes": [{"id": "root", "parentId": None, "tag": "body", "text": "chrome"}, {"id": "leaf", "parentId": "root", "tag": "p", "text": "x" * (MODULE.MAX_INPUT_CHARS + 20), "rect": {"width": 1, "height": 1}}]}
    result = MODULE.capture_text(capture)
    assert result.startswith("Title\n\n")
    assert len(result) == MODULE.MAX_INPUT_CHARS


def test_capture_text_falls_back_when_leaf_geometry_is_missing() -> None:
    assert MODULE.capture_text({"title": "", "nodes": [{"id": "root", "text": "fallback text"}]}) == "fallback text"


def test_result_has_no_page_text_and_only_maps_unambiguous_formats() -> None:
    result = MODULE.prediction_record({"id": "page_x", "contentHash": "sha256:x"}, "private text", {0: "Documentation", 1: "Content Listing"}, [0.9, 0.1])
    assert result["pageTypeSuggestion"] == "docs_article"
    assert "private text" not in str(result)
    assert "uncalibrated" in result["format"]["confidenceMeaning"]
    assert result["notPredicted"] == ["region", "function", "componentType", "purpose"]

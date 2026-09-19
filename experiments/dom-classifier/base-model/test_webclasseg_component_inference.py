import importlib.util
from pathlib import Path

PATH = Path(__file__).with_name("webclasseg_component_inference.py")
SPEC = importlib.util.spec_from_file_location("component", PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_selector_is_tag_only_and_bounded() -> None:
    result = MODULE.approximate_path_class("html > body:nth-of-type(1) > custom-element > div.foo")
    assert result == "html body custom-element div"


def test_fc_nav_is_a_weak_purpose_not_a_region() -> None:
    assert MODULE.CLASS_TO_WEAK_PURPOSE_HINT["nav"] == "navigation"
    assert "nav" not in MODULE.CLASS_TO_WEAK_REGION_HINT
    assert "card" not in MODULE.CLASS_TO_WEAK_REGION_HINT

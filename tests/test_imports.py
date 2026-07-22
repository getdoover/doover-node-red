"""Smoke tests for the template application.

These validate that modules are importable, the config schema is well-formed,
the Tags/UI classes subclass the correct bases, and the config export entry
point runs end-to-end.
"""

import json

from pydoover.config import Schema
from pydoover.tags import Tags
from pydoover.ui import UI


def test_import_app():
    from app_template.application import SampleApplication
    assert SampleApplication.config_cls is not None
    assert SampleApplication.tags_cls is not None
    assert SampleApplication.ui_cls is not None


def test_config_schema():
    from app_template.app_config import SampleConfig
    assert issubclass(SampleConfig, Schema)

    schema = SampleConfig.to_schema()
    assert isinstance(schema, dict)
    assert schema["type"] == "object"
    assert len(schema["properties"]) > 0
    assert "a_funny_message" in schema["required"]
    assert "simulator_app_key" in schema["required"]


def test_tags():
    from app_template.app_tags import SampleTags
    assert issubclass(SampleTags, Tags)


def test_ui():
    from app_template.app_ui import SampleUI
    assert issubclass(SampleUI, UI)


def test_state_machine():
    from app_template.app_state import SampleState
    state = SampleState()
    assert state.state == "off"


def test_config_export(tmp_path):
    from app_template.app_config import SampleConfig

    fp = tmp_path / "doover_config.json"
    SampleConfig.export(fp, "sample_application")

    data = json.loads(fp.read_text())
    assert "sample_application" in data
    assert "config_schema" in data["sample_application"]
    assert "properties" in data["sample_application"]["config_schema"]


def test_ui_export(tmp_path):
    from app_template.app_ui import SampleUI

    fp = tmp_path / "doover_config.json"
    SampleUI(None, None, None).export(fp, "sample_application")

    data = json.loads(fp.read_text())
    assert "ui_schema" in data["sample_application"]
    assert data["sample_application"]["ui_schema"]["type"] == "uiApplication"
    assert "is_working" in data["sample_application"]["ui_schema"]["children"]

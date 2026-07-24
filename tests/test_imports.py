"""Smoke tests for the Doover Node-RED supervisor app.

Validate that modules import, the config schema is well-formed and covers the
PLAN.md 4.2 fields, the Tags/UI classes subclass the correct bases, and the
settings template renders.
"""

import json

from pydoover.config import Schema
from pydoover.tags import Tags
from pydoover.ui import UI


def test_import_app():
    from doover_node_red.application import NodeRedApplication

    assert NodeRedApplication.config_cls is not None
    assert NodeRedApplication.tags_cls is not None
    assert NodeRedApplication.ui_cls is not None


def test_config_schema():
    from doover_node_red.app_config import NodeRedConfig

    assert issubclass(NodeRedConfig, Schema)

    schema = NodeRedConfig.to_schema()
    assert isinstance(schema, dict)
    assert schema["type"] == "object"

    props = schema["properties"]
    expected = {
        "editor_enabled",
        "editor_access",
        "extra_palette_packages",
        "flows_sync_enabled",
        "flow_package",
        "credential_secret",
        "flow_env",
        "memory_limit_mb",
        "timezone",
    }
    assert expected.issubset(props.keys())

    # Defaults per PLAN.md 4.2.
    assert props["editor_enabled"]["default"] is True
    assert props["flows_sync_enabled"]["default"] is True
    # editor_access is an enum drop-down.
    assert "enum" in props["editor_access"]
    # extra_palette_packages is an array.
    assert props["extra_palette_packages"]["type"][0] == "array"
    # flow_package has no working apply-loop yet, so it is hidden + flagged
    # EXPERIMENTAL like its unimplemented siblings (not shown as functional).
    assert props["flow_package"]["x-hidden"] is True
    assert "not yet implemented" in props["flow_package"]["description"].lower()


def test_tags():
    from doover_node_red.app_tags import NodeRedTags

    assert issubclass(NodeRedTags, Tags)


def test_ui():
    from doover_node_red.app_ui import NodeRedUI

    assert issubclass(NodeRedUI, UI)


def test_config_export(tmp_path):
    from doover_node_red.app_config import NodeRedConfig, APP_NAME

    fp = tmp_path / "doover_config.json"
    NodeRedConfig.export(fp, APP_NAME)

    data = json.loads(fp.read_text())
    assert APP_NAME in data
    assert "config_schema" in data[APP_NAME]
    assert "properties" in data[APP_NAME]["config_schema"]


def test_ui_export(tmp_path):
    from doover_node_red.app_ui import NodeRedUI
    from doover_node_red.app_config import APP_NAME

    fp = tmp_path / "doover_config.json"
    NodeRedUI(None, None, None).export(fp, APP_NAME)

    data = json.loads(fp.read_text())
    ui_schema = data[APP_NAME]["ui_schema"]
    assert ui_schema["type"] == "uiApplication"
    children = ui_schema["children"]
    assert "runtime_state" in children
    assert "open_editor" in children
    assert "node_red" in children
    # Last-deploy is a human-readable text variable ("never" / local datetime),
    # not a raw-epoch numeric variable.
    assert children["last_deploy_time"]["varType"] == "string"


def test_render_settings(tmp_path):
    from doover_node_red.runner import render_settings

    cfg = {
        "editor_enabled": True,
        "extra_palette_packages": ["node-red-contrib-modbus"],
    }
    out = render_settings(
        cfg,
        user_dir=str(tmp_path),
        template_path="/nonexistent-so-falls-back-to-repo-template",
    )
    rendered = (tmp_path / "settings.js").read_text()

    # Every template marker must be substituted.
    for marker in (
        "__ADMIN_ROOT__",
        "__DISABLE_EDITOR__",
        "__FLOW_FILE__",
        "__EXTERNAL_MODULES_ALLOWLIST__",
        "__NODE_RED_PORT__",
    ):
        assert marker not in rendered
    assert "node-red-contrib-modbus" in rendered
    # Pre-installed Doover palette is always in the allowlist.
    assert "node-red-contrib-doover" in rendered
    assert out.endswith("settings.js")


def test_render_settings_disabled_editor(tmp_path):
    from doover_node_red.runner import render_settings

    render_settings(
        {"editor_enabled": False},
        user_dir=str(tmp_path),
        template_path="/nonexistent",
    )
    rendered = (tmp_path / "settings.js").read_text()
    assert "true" in rendered  # disableEditor branch substituted to true


def test_build_child_env():
    from doover_node_red.runner import build_child_env

    env = build_child_env(
        {
            "editor_enabled": True,
            "credential_secret": "s3cret",
            "timezone": "Australia/Brisbane",
            "memory_limit_mb": 200,
            "flow_env": {"SITE_ID": "pump-42"},
        }
    )
    assert env["DOOVER_CREDENTIAL_SECRET"] == "s3cret"
    assert env["TZ"] == "Australia/Brisbane"
    assert env["SITE_ID"] == "pump-42"
    assert "--max-old-space-size=200" in env["NODE_OPTIONS"]

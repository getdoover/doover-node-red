"""Deployment config schema for the Doover Node-RED app.

Mirrors PLAN.md section 4.2. Every field here becomes part of the app's
deployment config surface — the supervisor reads these values to materialise
``settings.js`` and to manage the Node-RED runtime.
"""

from pathlib import Path

from pydoover import config

# The app key / top-level object name in doover_config.json.
APP_NAME = "doover_node_red"


class NodeRedConfig(config.Schema):
    editor_enabled = config.Boolean(
        "Editor Enabled",
        default=True,
        description=(
            "Serve the Node-RED flow editor. Disable entirely for locked-down "
            "production devices — flows still run, but the editor is inaccessible."
        ),
    )
    editor_access = config.Enum(
        "Editor Access",
        choices=["doover-auth", "local-only"],
        default="doover-auth",
        hidden=True,
        description=(
            "EXPERIMENTAL / not yet implemented. How the editor is reached. "
            "'doover-auth' exposes it via a Doover tunnel authenticated against "
            "Doover; 'local-only' keeps it bound to localhost with no tunnel. "
            "Hidden until the editor tunnel lands (currently has no effect)."
        ),
    )
    extra_palette_packages = config.Array(
        "Extra Palette Packages",
        element=config.String("npm package"),
        default=[],
        description=(
            "Additional npm package names to install at startup (e.g. "
            "'node-red-contrib-modbus'). Installs need connectivity and add "
            "boot time."
        ),
    )
    flows_sync_enabled = config.Boolean(
        "Flows Sync Enabled",
        default=True,
        hidden=True,
        description=(
            "EXPERIMENTAL / not yet implemented. Persist flows to the channel-"
            "backed storage so the cloud holds the canonical copy (history = "
            "versioning). Hidden until the storage module ships — flows currently "
            "always use local file storage regardless of this value."
        ),
    )
    flow_package = config.String(
        "Flow Package",
        default="",
        hidden=True,
        description=(
            "EXPERIMENTAL / not yet implemented. Pinned flow package as "
            "'name@version' (or 'latest') for fleet mode. Hidden until the "
            "supervisor's fetch/install/load apply-loop ships — setting it "
            "currently only echoes the value to the applied-package status tag; "
            "no package is fetched, installed or loaded. Leave blank for dev mode."
        ),
    )
    credential_secret = config.String(
        "Credential Secret",
        default="",
        hidden=True,
        description=(
            "Encryption key for flow credentials. Share across a fleet so a flow "
            "package's credentials decrypt on every device. Generated per-device "
            "if left blank."
        ),
    )
    flow_env = config.Object(
        "Flow Environment Variables",
        name="flow_env",
        additional_elements=True,
        default={},
        description=(
            "Key/value pairs exposed to flows as environment variables "
            "(referenced with ${VAR} in node config) — per-device values for "
            "shared flow packages."
        ),
    )
    memory_limit_mb = config.Integer(
        "Memory Limit (MB)",
        default=256,
        minimum=64,
        description=(
            "V8 heap cap for Node-RED (applied via --max-old-space-size). This "
            "bounds the JS old-space heap, NOT total RSS (native buffers/pools are "
            "extra) — for a hard memory cap set an orchestrator/compose mem_limit. "
            "The runtime typically uses 120-250 MB RSS."
        ),
    )
    timezone = config.String(
        "Timezone",
        default="UTC",
        description=(
            "IANA timezone (e.g. 'Australia/Brisbane') for Node-RED scheduling "
            "nodes. Defaults to UTC."
        ),
    )


def export():
    NodeRedConfig.export(Path(__file__).parents[2] / "doover_config.json", APP_NAME)


if __name__ == "__main__":
    export()

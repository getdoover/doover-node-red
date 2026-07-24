"""Doover UI for the Node-RED app.

Declares the app's status variables (wired to the supervisor tags), an
"Open Editor" action stub, and an empty "Node-RED" container that flow UI
nodes will populate in a later phase (PLAN.md 3.4 / 4.3).
"""

from pathlib import Path

from pydoover import ui

from .app_config import APP_NAME
from .app_tags import NodeRedTags


class NodeRedUI(ui.UI):
    runtime_state = ui.TextVariable(
        "Runtime State",
        value=NodeRedTags.runtime_state,
        name="runtime_state",
    )
    last_deploy_time = ui.TextVariable(
        "Last Deploy",
        value=NodeRedTags.last_deploy_time,
        name="last_deploy_time",
    )
    # NB: a "Flow Errors" variable is deliberately not surfaced yet — the
    # supervisor cannot observe flow error state until it is wired to the Node-RED
    # admin API (later phase). Showing a permanently-0 count misleads operators, so
    # the element is omitted rather than shown as always-healthy.
    memory_mb = ui.NumericVariable(
        "Memory (MB)",
        value=NodeRedTags.memory_mb,
        name="memory_mb",
        precision=1,
    )
    restart_count = ui.NumericVariable(
        "Restarts",
        value=NodeRedTags.restart_count,
        name="restart_count",
    )

    # "Open Editor" affordance. The tunnel/link-out is not yet implemented; the
    # handler publishes a notice for now (PLAN.md 4.3).
    open_editor = ui.Button(
        "Open Editor",
        name="open_editor",
        position=1,
    )

    # Empty container that flow UI nodes populate on deploy in a later phase.
    node_red = ui.Container("Node-RED", name="node_red")


def export():
    NodeRedUI(None, None, None).export(
        Path(__file__).parents[2] / "doover_config.json",
        APP_NAME,
    )


if __name__ == "__main__":
    export()

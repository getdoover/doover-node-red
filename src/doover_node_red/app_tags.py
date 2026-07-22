"""Runtime state tags for the Doover Node-RED supervisor.

These are the health/status signals the supervisor reports about the managed
Node-RED runtime. They are bound to UI status variables in :mod:`app_ui`.
"""

from pydoover.tags import Tag, Tags


class NodeRedTags(Tags):
    # High-level runtime state of the Node-RED child process:
    # "starting" | "running" | "restarting" | "stopped" | "error"
    runtime_state = Tag("string", default="starting")

    # Epoch seconds of the last observed flows deploy (flows file mtime).
    last_deploy_time = Tag("number", default=0)

    # Resident memory of the Node-RED process, in MB.
    memory_mb = Tag("number", default=0)

    # Number of times the supervisor has (re)started Node-RED since boot.
    restart_count = Tag("integer", default=0)

    # Applied flow package "name@version" in fleet mode (empty in dev mode).
    applied_flow_package = Tag("string", default="")

    # NB: flow_error_count and editor_endpoint tags were removed — neither was ever
    # set by the supervisor. They will return once wired to the Node-RED admin API
    # and the editor tunnel respectively (later phases), rather than misleading
    # operators with a permanently-0 / empty value in the meantime.

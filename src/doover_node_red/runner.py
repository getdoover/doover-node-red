"""Node-RED child-process management for the supervisor.

Responsibilities:
- render ``settings.js`` from the packaged template + app config,
- spawn ``node-red`` as a child process pointed at the mapped ``/data`` volume,
- restart it on crash with exponential backoff,
- expose lightweight liveness/memory/deploy introspection for the supervisor's
  health tags.

Kept deliberately free of pydoover imports so it is unit-testable on its own.
"""

import asyncio
import json
import logging
import os
import secrets
import shutil
from pathlib import Path

log = logging.getLogger(__name__)

# Where the Node-RED userDir (flows, settings, node_modules) lives. This is the
# mapped volume in the container image so flows survive restarts.
DEFAULT_USER_DIR = os.environ.get("DOOVER_NODE_RED_USER_DIR", "/data")

# Location of the settings template shipped in the image.
DEFAULT_TEMPLATE = os.environ.get(
    "DOOVER_SETTINGS_TEMPLATE", "/opt/doover/settings/settings.js.tmpl"
)

# Node-RED's default admin/editor listen port inside the container.
NODE_RED_PORT = int(os.environ.get("DOOVER_NODE_RED_PORT", "1880"))

# Backoff bounds for crash-restart (seconds).
_BACKOFF_MIN = 1.0
_BACKOFF_MAX = 60.0
# A process that stayed up at least this long is considered "stable" and resets
# the backoff.
_STABLE_UPTIME = 30.0

# Filename (under the userDir) that holds the auto-generated credential secret so
# it survives restarts. Node-RED encrypts flows_cred.json with this key; a fresh
# key every boot would make the persisted credentials undecryptable.
CREDENTIAL_SECRET_FILENAME = ".doover_credential_secret"


class RuntimeState:
    STARTING = "starting"
    RUNNING = "running"
    RESTARTING = "restarting"
    STOPPED = "stopped"
    ERROR = "error"


def _resolve_template(template_path: str) -> Path:
    """Return the settings template path, falling back to the in-repo copy.

    In the container the template is COPYed to ``/opt/doover/settings``; when the
    supervisor runs from a source checkout (tests, local dev) fall back to the
    repo's ``settings/`` dir.
    """
    p = Path(template_path)
    if p.is_file():
        return p
    repo_copy = Path(__file__).parents[2] / "settings" / "settings.js.tmpl"
    return repo_copy


def render_settings(config: dict, *, user_dir: str, template_path: str) -> str:
    """Render the Node-RED ``settings.js`` from ``config`` and write it to disk.

    ``config`` is a plain dict of the deployment-config values the supervisor
    cares about. Returns the path to the written settings file.
    """
    tmpl = _resolve_template(template_path).read_text()

    disable_editor = not bool(config.get("editor_enabled", True))
    # local-only access still serves the editor, just without a tunnel; that is
    # a supervisor/tunnel concern, not a settings.js one. adminRoot stays "/".
    admin_root = "/"
    allowlist = list(config.get("extra_palette_packages") or [])
    # Always allow the pre-installed Doover palette + its core dep to be loaded
    # as external modules by the editor's palette manager.
    for pkg in ("node-red-contrib-doover", "@doover/nodered-core"):
        if pkg not in allowlist:
            allowlist.append(pkg)

    substitutions = {
        "__ADMIN_ROOT__": json.dumps(admin_root),
        "__DISABLE_EDITOR__": "true" if disable_editor else "false",
        "__FLOW_FILE__": json.dumps("flows.json"),
        "__EXTERNAL_MODULES_ALLOWLIST__": json.dumps(allowlist),
        "__NODE_RED_PORT__": str(NODE_RED_PORT),
    }

    rendered = tmpl
    for marker, value in substitutions.items():
        rendered = rendered.replace(marker, value)

    Path(user_dir).mkdir(parents=True, exist_ok=True)
    out = Path(user_dir) / "settings.js"
    out.write_text(rendered)
    log.info("Rendered Node-RED settings.js to %s", out)
    return str(out)


def _load_or_create_secret(user_dir: str) -> str:
    """Return a stable credential secret persisted under ``user_dir``.

    Reads the secret from :data:`CREDENTIAL_SECRET_FILENAME` if present, otherwise
    generates one and writes it (0600) so it is reused on every subsequent boot.
    This keeps Node-RED able to decrypt ``flows_cred.json`` across restarts when no
    ``credential_secret`` is configured.

    The secret file is the fleet-shared flow-credential encryption key, so its
    permissions are enforced on both paths: an existing file is tightened to 0600
    before its contents are trusted (a file cloned from a template /data may arrive
    world/group-readable), and a freshly generated file is created atomically with
    0600 (never written world-readable and chmod'd afterwards).
    """
    path = Path(user_dir) / CREDENTIAL_SECRET_FILENAME
    try:
        existing = path.read_text().strip()
        if existing:
            # Tighten perms on a pre-existing (possibly loosely-permissioned)
            # secret before returning it, so a cloned/restored 0644 file is not
            # left exposing the fleet credential key.
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
            return existing
    except OSError:
        pass

    secret = secrets.token_hex(32)
    try:
        Path(user_dir).mkdir(parents=True, exist_ok=True)
        # Create atomically with restrictive perms (O_EXCL + 0600) so the secret
        # is never observable at the process umask (typically 0644) during the
        # write window. If the file was created concurrently, fall back to reading
        # it (and tightening its mode).
        try:
            fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            existing = path.read_text().strip()
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
            if existing:
                return existing
            fd = os.open(str(path), os.O_WRONLY | os.O_TRUNC, 0o600)
        try:
            os.write(fd, secret.encode("utf-8"))
        finally:
            os.close(fd)
        # Enforce mode even if the file pre-existed with a looser umask-derived mode.
        os.chmod(path, 0o600)
        log.info(
            "No credential_secret configured; generated and persisted one at %s.",
            path,
        )
    except OSError as e:
        # Could not persist (read-only volume, etc). Fall back to an in-memory
        # secret for this boot; credentials will still work until the next restart.
        log.warning(
            "Could not persist credential secret to %s (%s); using an ephemeral one.",
            path,
            e,
        )
    return secret


# Environment variables the Node-RED child process legitimately needs, inherited
# from the supervisor process. The child env is built from THIS allowlist only —
# not a copy of the whole os.environ — so platform-injected secrets/tokens present
# in the supervisor container are never handed to flow code (Function nodes can
# read process.env / env.get / ${VAR}).
_ENV_PASSTHROUGH = frozenset(
    {
        # Process basics required for Node/npm to run.
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "TERM",
        "TZ",
        "TMPDIR",
        # Node runtime knobs (NODE_OPTIONS is re-derived below for the mem cap).
        "NODE_OPTIONS",
        "NODE_PATH",
        "NODE_ENV",
        "NODE_RED_HOME",
        # Doover local-transport / palette auto-discovery. Local mode uses the
        # DDA HTTPS listener's gRPC-Web mount and needs no API token.
        "APP_KEY",
        "AGENT_ID",
        "DDA_URI",
        "DDA_WEB_URI",
        "DDA_GRPC_WEB_URI",
        "DDA_GRPC_WEB_TLS_VERIFY",
        "PLT_URI",
        "MODBUS_URI",
        # settings.js reads this for the Node-RED console log level.
        "DOOVER_LOG_LEVEL",
    }
)

# flow_env is user-controlled config. These names/prefixes are refused so a
# flow_env entry can never override a supervisor control var (DOOVER_*), the
# memory cap / loader (NODE_OPTIONS, LD_*), PATH, the transport discovery vars, or
# a shell-injection vector (IFS, BASH_ENV, ENV). Comparison is case-insensitive so
# a lowercased spelling can't slip a reserved name past the filter.
_ENV_RESERVED_PREFIXES = ("DOOVER_", "NODE_", "LD_")
_ENV_RESERVED_NAMES = frozenset(
    {
        "PATH",
        "HOME",
        "TZ",
        "APP_KEY",
        "AGENT_ID",
        "DDA_URI",
        "DDA_WEB_URI",
        "DDA_GRPC_WEB_URI",
        "DDA_GRPC_WEB_TLS_VERIFY",
        "PLT_URI",
        "MODBUS_URI",
        "IFS",
        "ENV",
        "BASH_ENV",
    }
)


def _is_allowed_flow_env_key(key: str) -> bool:
    """Return True if ``key`` is safe to accept from user-supplied ``flow_env``."""
    ku = key.upper()
    if ku in _ENV_RESERVED_NAMES:
        return False
    return not any(ku.startswith(p) for p in _ENV_RESERVED_PREFIXES)


def build_child_env(config: dict, *, user_dir: str = DEFAULT_USER_DIR) -> dict:
    """Return the environment for the Node-RED child process.

    Built from an explicit allowlist of the supervisor's own environment (never a
    full copy of ``os.environ``), plus the credential secret, editor-disable flag,
    timezone, memory cap and any *filtered* user-supplied ``flow_env`` values (as
    plain env vars for ${VAR} refs).
    """
    src = os.environ
    env = {k: src[k] for k in _ENV_PASSTHROUGH if k in src}

    # Apply user-supplied flow_env FIRST and filtered, so it can never win over
    # the supervisor's own control vars set below (a flow_env entry colliding with
    # a reserved name is dropped, not allowed to override it).
    flow_env = config.get("flow_env") or {}
    if isinstance(flow_env, dict):
        for k, v in flow_env.items():
            if v is None:
                continue
            key = str(k)
            if not _is_allowed_flow_env_key(key):
                log.warning(
                    "Ignoring reserved flow_env key %r (reserved for supervisor use).",
                    key,
                )
                continue
            env[key] = str(v)

    # ---- Supervisor-controlled vars: set AFTER flow_env so they always win ----
    secret = (config.get("credential_secret") or "").strip()
    if not secret:
        # No configured secret: reuse a persisted per-device secret so credentials
        # keep decrypting across restarts (see _load_or_create_secret).
        secret = _load_or_create_secret(user_dir)
    env["DOOVER_CREDENTIAL_SECRET"] = secret

    env["DOOVER_DISABLE_EDITOR"] = "true" if not config.get("editor_enabled", True) else "false"

    tz = (config.get("timezone") or "").strip()
    if tz:
        env["TZ"] = tz

    mem = config.get("memory_limit_mb")
    if mem:
        # Cap the V8 old-space heap. Append rather than replace so any NODE_OPTIONS
        # already set on the container is preserved. Note this bounds the JS heap,
        # not total RSS — a hard container cap is an orchestrator concern.
        heap_opt = f"--max-old-space-size={int(mem)}"
        existing = env.get("NODE_OPTIONS", "").strip()
        env["NODE_OPTIONS"] = f"{existing} {heap_opt}".strip() if existing else heap_opt

    return env


async def install_palette_packages(
    packages, *, user_dir: str, npm_bin: str | None = None
) -> None:
    """Install extra palette npm packages into the Node-RED ``user_dir``.

    Runs ``npm install`` for the given package names so flows referencing them
    load on boot (the settings allowlist alone does not install anything). A
    no-op when ``packages`` is empty. Best-effort: a failed install is logged, not
    fatal, so the runtime still starts.
    """
    pkgs = [str(p).strip() for p in (packages or []) if str(p).strip()]
    if not pkgs:
        return

    npm = npm_bin or shutil.which("npm") or "npm"
    cmd = [
        npm,
        "install",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--prefix",
        str(user_dir),
        # End-of-options separator: everything after "--" is treated by npm as a
        # positional package specifier, never a flag. Without it a package entry
        # beginning with "-" (e.g. "--registry=http://attacker/") is parsed as an
        # option, redirecting the whole install (argument injection).
        "--",
        *pkgs,
    ]
    log.info("Installing extra palette packages: %s", ", ".join(pkgs))
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except OSError as e:
        log.error("Failed to launch npm to install palette packages: %s", e)
        return

    stdout, _ = await proc.communicate()
    if proc.returncode != 0:
        log.error(
            "npm install of extra palette packages failed (code=%s):\n%s",
            proc.returncode,
            (stdout or b"").decode("utf-8", "replace"),
        )
    else:
        log.info("Extra palette packages installed into %s.", user_dir)


def read_rss_mb(pid: int) -> float:
    """Best-effort resident-set size of a process in MB (Linux /proc)."""
    try:
        with open(f"/proc/{pid}/statm", "r") as fh:
            fields = fh.read().split()
        # statm: total, resident, ... (in pages)
        resident_pages = int(fields[1])
        page_size = os.sysconf("SC_PAGE_SIZE")
        return round(resident_pages * page_size / (1024 * 1024), 1)
    except (OSError, ValueError, IndexError):
        return 0.0


class NodeRedRunner:
    """Spawns and supervises the Node-RED child process."""

    def __init__(
        self,
        config: dict,
        *,
        user_dir: str = DEFAULT_USER_DIR,
        template_path: str = DEFAULT_TEMPLATE,
        on_state_change=None,
    ):
        self.config = config
        self.user_dir = user_dir
        self.template_path = template_path
        self.on_state_change = on_state_change

        self.state = RuntimeState.STARTING
        self.restart_count = 0
        self._proc: asyncio.subprocess.Process | None = None
        self._task: asyncio.Task | None = None
        self._stopping = False
        # Set by restart() so the supervise loop can tell a deliberate,
        # config-driven reconfigure (re-render settings + relaunch) apart from a
        # genuine crash. Only crashes increment restart_count — a reconfigure is
        # not a fault and must not inflate the operator-facing "Restarts" count.
        self._deliberate_restart = False

    @property
    def pid(self) -> int | None:
        return self._proc.pid if self._proc and self._proc.returncode is None else None

    @property
    def flows_path(self) -> Path:
        return Path(self.user_dir) / "flows.json"

    def _set_state(self, state: str):
        if state != self.state:
            log.info("Node-RED runtime state: %s -> %s", self.state, state)
            self.state = state
            if self.on_state_change:
                self.on_state_change(state)

    def _node_red_cmd(self) -> list[str]:
        binary = shutil.which("node-red") or "node-red"
        return [
            binary,
            "--userDir",
            self.user_dir,
            "--settings",
            str(Path(self.user_dir) / "settings.js"),
            "--port",
            str(NODE_RED_PORT),
        ]

    async def start(self):
        """Begin supervising Node-RED in a background task."""
        render_settings(
            self.config, user_dir=self.user_dir, template_path=self.template_path
        )
        # Install any configured extra palette packages before spawning so flows
        # referencing them load on the first boot.
        await install_palette_packages(
            self.config.get("extra_palette_packages"), user_dir=self.user_dir
        )
        self._stopping = False
        self._task = asyncio.create_task(self._supervise())

    async def apply_config(self, config: dict):
        """Re-apply a changed deployment config to the running runtime.

        Re-renders ``settings.js``, installs any newly-added palette packages, and
        restarts the Node-RED child so the new environment/settings take effect.
        Called by the supervisor when it detects a deployment-config change (config
        is otherwise only read once at process start).
        """
        prev = self.config or {}
        self.config = config
        render_settings(
            config, user_dir=self.user_dir, template_path=self.template_path
        )

        prev_pkgs = set(prev.get("extra_palette_packages") or [])
        new_pkgs = [
            p
            for p in (config.get("extra_palette_packages") or [])
            if p not in prev_pkgs
        ]
        if new_pkgs:
            await install_palette_packages(new_pkgs, user_dir=self.user_dir)

        await self.restart()

    async def restart(self):
        """Restart the Node-RED child so a config change takes effect.

        Terminates the current process; the supervise loop respawns it with the
        updated config/environment (a no-op if nothing is running yet).
        """
        proc = self._proc
        if proc and proc.returncode is None:
            log.info("Restarting Node-RED to apply config change (pid=%s)", proc.pid)
            # Flag this as a deliberate restart so _supervise() does not count it
            # as a crash toward restart_count.
            self._deliberate_restart = True
            try:
                proc.terminate()
            except ProcessLookupError:
                self._deliberate_restart = False

    async def _spawn(self) -> asyncio.subprocess.Process:
        env = build_child_env(self.config, user_dir=self.user_dir)
        cmd = self._node_red_cmd()
        log.info("Spawning Node-RED: %s", " ".join(cmd))
        return await asyncio.create_subprocess_exec(*cmd, env=env)

    async def _supervise(self):
        backoff = _BACKOFF_MIN
        while not self._stopping:
            try:
                self._proc = await self._spawn()
            except OSError as e:
                log.error("Failed to spawn Node-RED: %s", e)
                self._set_state(RuntimeState.ERROR)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, _BACKOFF_MAX)
                continue

            self._set_state(RuntimeState.RUNNING)
            started = asyncio.get_event_loop().time()

            returncode = await self._proc.wait()
            uptime = asyncio.get_event_loop().time() - started

            if self._stopping:
                self._set_state(RuntimeState.STOPPED)
                break

            if self._deliberate_restart:
                # A config-driven reconfigure (apply_config -> restart), not a
                # crash. Reset backoff and do NOT count it as a restart so a
                # healthy device that only ever reconfigured still reports 0.
                self._deliberate_restart = False
                backoff = _BACKOFF_MIN
                log.info(
                    "Node-RED stopped (code=%s) for a config reconfigure; relaunching.",
                    returncode,
                )
            else:
                log.warning(
                    "Node-RED exited (code=%s) after %.1fs; restarting.",
                    returncode,
                    uptime,
                )
                if uptime >= _STABLE_UPTIME:
                    backoff = _BACKOFF_MIN  # was stable, reset backoff

                # Count only genuine respawns, not the initial (healthy) spawn nor
                # a deliberate reconfigure — a clean first boot that never crashed
                # must report 0 restarts, not 1.
                self.restart_count += 1
            self._set_state(RuntimeState.RESTARTING)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, _BACKOFF_MAX)

    async def stop(self):
        """Terminate Node-RED and stop supervising."""
        self._stopping = True
        if self._proc and self._proc.returncode is None:
            log.info("Terminating Node-RED (pid=%s)", self._proc.pid)
            try:
                self._proc.terminate()
                try:
                    await asyncio.wait_for(self._proc.wait(), timeout=10)
                except asyncio.TimeoutError:
                    self._proc.kill()
            except ProcessLookupError:
                pass
        if self._task:
            self._task.cancel()
        self._set_state(RuntimeState.STOPPED)

    def last_deploy_epoch(self) -> float:
        """Return the flows file mtime (epoch seconds) as the last-deploy proxy."""
        try:
            return self.flows_path.stat().st_mtime
        except OSError:
            return 0.0

    def memory_mb(self) -> float:
        pid = self.pid
        return read_rss_mb(pid) if pid else 0.0

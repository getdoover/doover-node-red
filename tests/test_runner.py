"""Regression tests for the supervisor runner + application lifecycle fixes.

Covers:
- persisted credential secret across boots (no fresh key every restart),
- NODE_OPTIONS appended, not overwritten,
- extra_palette_packages actually installed at startup,
- runtime config re-apply (apply_config re-renders settings),
- SIGTERM handler installation.
"""

import asyncio
import json
import os
import signal
import stat
from unittest.mock import AsyncMock

import pytest


def _make_fake_npm(directory, outfile):
    """Write a fake `npm` that records its args to ``outfile`` and exits 0."""
    script = directory / "fake_npm.sh"
    script.write_text(f'#!/bin/sh\nprintf "%s" "$*" > "{outfile}"\nexit 0\n')
    script.chmod(script.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return script


# --- default flows ----------------------------------------------------------


def test_prepare_default_flows_removes_stock_warning_and_adds_local_connection(
    tmp_path,
):
    from doover_node_red.runner import (
        DEFAULT_LOCAL_CONNECTION_ID,
        prepare_default_flows,
    )

    flows_path = tmp_path / "flows.json"
    user_node = {
        "id": "user-node",
        "type": "inject",
        "z": "default-tab",
        "name": "keep me",
    }
    flows_path.write_text(
        json.dumps(
            [
                {"id": "default-tab", "type": "tab", "label": "Flow 1"},
                {
                    "id": "stock-warning",
                    "type": "comment",
                    "z": "default-tab",
                    "name": (
                        "WARNING: please check you have started this container "
                        "with a volume that is mounted to /data\notherwise flows are lost"
                    ),
                },
                user_node,
            ]
        )
    )

    assert prepare_default_flows(str(tmp_path)) is True
    flows = json.loads(flows_path.read_text())

    assert user_node in flows
    assert not any(node.get("id") == "stock-warning" for node in flows)
    assert {
        "id": DEFAULT_LOCAL_CONNECTION_ID,
        "type": "doover-connection",
        "name": "Local Device",
        "dooverType": "local",
        "localBaseUrl": "",
        "apiBase": "https://api.doover.com",
        "agentId": "",
    } in flows


def test_prepare_default_flows_is_idempotent(tmp_path):
    from doover_node_red.runner import (
        DEFAULT_LOCAL_CONNECTION_ID,
        prepare_default_flows,
    )

    assert prepare_default_flows(str(tmp_path)) is True
    first = (tmp_path / "flows.json").read_text()

    assert prepare_default_flows(str(tmp_path)) is False
    assert (tmp_path / "flows.json").read_text() == first

    flows = json.loads(first)
    assert sum(node.get("id") == DEFAULT_LOCAL_CONNECTION_ID for node in flows) == 1
    assert any(node.get("type") == "tab" for node in flows)


def test_prepare_default_flows_does_not_overwrite_invalid_json(tmp_path):
    from doover_node_red.runner import prepare_default_flows

    flows_path = tmp_path / "flows.json"
    flows_path.write_text("not valid json")

    assert prepare_default_flows(str(tmp_path)) is False
    assert flows_path.read_text() == "not valid json"


# --- credential secret persistence -----------------------------------------


def test_credential_secret_persisted_across_boots(tmp_path):
    from doover_node_red.runner import build_child_env, CREDENTIAL_SECRET_FILENAME

    cfg = {"editor_enabled": True}  # no credential_secret configured

    env1 = build_child_env(cfg, user_dir=str(tmp_path))
    secret1 = env1["DOOVER_CREDENTIAL_SECRET"]
    assert secret1, "a secret is generated when none is configured"

    secret_file = tmp_path / CREDENTIAL_SECRET_FILENAME
    assert secret_file.read_text().strip() == secret1, "secret persisted to disk"

    # A subsequent boot must reuse the same secret so flows_cred.json still decrypts.
    env2 = build_child_env(cfg, user_dir=str(tmp_path))
    assert env2["DOOVER_CREDENTIAL_SECRET"] == secret1


def test_configured_secret_takes_precedence_and_is_not_persisted(tmp_path):
    from doover_node_red.runner import build_child_env, CREDENTIAL_SECRET_FILENAME

    env = build_child_env({"credential_secret": "explicit"}, user_dir=str(tmp_path))
    assert env["DOOVER_CREDENTIAL_SECRET"] == "explicit"
    assert not (tmp_path / CREDENTIAL_SECRET_FILENAME).exists()


def test_generated_secret_file_is_0600(tmp_path):
    """A freshly generated secret must never be observable at a loose umask."""
    from doover_node_red.runner import build_child_env, CREDENTIAL_SECRET_FILENAME

    build_child_env({}, user_dir=str(tmp_path))
    mode = stat.S_IMODE((tmp_path / CREDENTIAL_SECRET_FILENAME).stat().st_mode)
    assert mode == 0o600


def test_existing_loose_secret_is_tightened_on_read(tmp_path):
    """A cloned/restored 0644 secret file is tightened before its key is trusted."""
    from doover_node_red.runner import build_child_env, CREDENTIAL_SECRET_FILENAME

    path = tmp_path / CREDENTIAL_SECRET_FILENAME
    path.write_text("preexisting-fleet-key")
    os.chmod(path, 0o644)

    env = build_child_env({}, user_dir=str(tmp_path))
    assert env["DOOVER_CREDENTIAL_SECRET"] == "preexisting-fleet-key"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


# --- flow_env hardening -----------------------------------------------------


def test_flow_env_cannot_override_supervisor_control_vars(tmp_path):
    from doover_node_red.runner import build_child_env

    env = build_child_env(
        {
            "credential_secret": "real-secret",
            "editor_enabled": False,  # operator locked the editor down
            "memory_limit_mb": 200,
            "flow_env": {
                # All of these are attacks via the innocuous flow_env config.
                "DOOVER_DISABLE_EDITOR": "false",  # re-enable a locked editor
                "DOOVER_CREDENTIAL_SECRET": "attacker",  # hijack the key
                "NODE_OPTIONS": "--require /data/x.js",  # arbitrary code + wipe cap
                "PATH": "/evil",
                "LD_PRELOAD": "/evil.so",
                "SITE_ID": "pump-42",  # a legitimate value still gets through
            },
        },
        user_dir=str(tmp_path),
    )

    # Supervisor control vars win / are untouched.
    assert env["DOOVER_DISABLE_EDITOR"] == "true"
    assert env["DOOVER_CREDENTIAL_SECRET"] == "real-secret"
    assert "/data/x.js" not in env["NODE_OPTIONS"]
    assert "--max-old-space-size=200" in env["NODE_OPTIONS"]
    assert env.get("PATH") != "/evil"
    assert "LD_PRELOAD" not in env
    # Benign per-device value is still exposed to flows.
    assert env["SITE_ID"] == "pump-42"


def test_child_env_does_not_leak_unrelated_supervisor_env(monkeypatch, tmp_path):
    """Platform-injected secrets in the supervisor env must not reach flow code."""
    from doover_node_red.runner import build_child_env

    monkeypatch.setenv("PLATFORM_SECRET_TOKEN", "topsecret")
    monkeypatch.setenv("DDA_WEB_URI", "http://127.0.0.1:49100")

    env = build_child_env({"credential_secret": "x"}, user_dir=str(tmp_path))

    assert "PLATFORM_SECRET_TOKEN" not in env, "unrelated secret must not pass through"
    # Allowlisted transport-discovery vars still pass through.
    assert env["DDA_WEB_URI"] == "http://127.0.0.1:49100"


# --- NODE_OPTIONS append ----------------------------------------------------


def test_node_options_appended_not_overwritten(monkeypatch, tmp_path):
    from doover_node_red.runner import build_child_env

    monkeypatch.setenv("NODE_OPTIONS", "--enable-source-maps")
    env = build_child_env(
        {"credential_secret": "x", "memory_limit_mb": 200}, user_dir=str(tmp_path)
    )
    assert "--enable-source-maps" in env["NODE_OPTIONS"], "inherited option preserved"
    assert "--max-old-space-size=200" in env["NODE_OPTIONS"]


# --- extra palette package install ------------------------------------------


@pytest.mark.asyncio
async def test_install_palette_packages_noop_when_empty(tmp_path):
    from doover_node_red.runner import install_palette_packages

    marker = tmp_path / "npm_args.txt"
    fake = _make_fake_npm(tmp_path, marker)
    await install_palette_packages([], user_dir=str(tmp_path), npm_bin=str(fake))
    assert not marker.exists(), "npm not invoked for an empty package list"


@pytest.mark.asyncio
async def test_install_palette_packages_invokes_npm(tmp_path):
    from doover_node_red.runner import install_palette_packages

    marker = tmp_path / "npm_args.txt"
    fake = _make_fake_npm(tmp_path, marker)
    await install_palette_packages(
        ["node-red-contrib-modbus", "foo"], user_dir=str(tmp_path), npm_bin=str(fake)
    )
    args = marker.read_text()
    assert "install" in args
    assert "--prefix" in args
    assert "node-red-contrib-modbus" in args
    assert "foo" in args


@pytest.mark.asyncio
async def test_install_palette_packages_uses_end_of_options_separator(tmp_path):
    """A package entry starting with '-' must be a positional spec, not a flag."""
    from doover_node_red.runner import install_palette_packages

    marker = tmp_path / "npm_args.txt"
    fake = _make_fake_npm(tmp_path, marker)
    await install_palette_packages(
        ["--registry=http://attacker.example/", "foo"],
        user_dir=str(tmp_path),
        npm_bin=str(fake),
    )
    args = marker.read_text().split()
    assert "--" in args, "end-of-options separator present"
    sep = args.index("--")
    # The injected flag appears only AFTER the separator (npm treats it positional).
    assert "--registry=http://attacker.example/" not in args[:sep]
    assert "--registry=http://attacker.example/" in args[sep + 1:]


# --- restart_count semantics ------------------------------------------------


class _FakeProc:
    def __init__(self, returncode=0):
        self._rc = returncode
        self.returncode = None
        self.pid = 4321

    async def wait(self):
        self.returncode = self._rc
        return self._rc

    def terminate(self):
        pass


@pytest.mark.asyncio
async def test_restart_count_zero_on_clean_boot(tmp_path):
    """A clean first boot that never crashed must report 0 restarts, not 1."""
    from doover_node_red.runner import NodeRedRunner

    runner = NodeRedRunner(
        {"editor_enabled": True}, user_dir=str(tmp_path), template_path="/nonexistent"
    )
    assert runner.restart_count == 0

    async def fake_spawn():
        # Simulate a stop request so the supervise loop breaks after the first,
        # healthy run without ever respawning.
        runner._stopping = True
        return _FakeProc(returncode=0)

    runner._spawn = fake_spawn
    await runner._supervise()
    assert runner.restart_count == 0


@pytest.mark.asyncio
async def test_restart_count_increments_only_on_respawn(tmp_path, monkeypatch):
    """A genuine crash/respawn increments the counter."""
    import doover_node_red.runner as runner_mod
    from doover_node_red.runner import NodeRedRunner

    async def _no_sleep(_):
        return None

    monkeypatch.setattr(runner_mod.asyncio, "sleep", _no_sleep)

    runner = NodeRedRunner(
        {"editor_enabled": True}, user_dir=str(tmp_path), template_path="/nonexistent"
    )
    calls = {"n": 0}

    async def fake_spawn():
        calls["n"] += 1
        if calls["n"] >= 2:
            # On the second spawn, request stop so the loop ends after this run.
            runner._stopping = True
        return _FakeProc(returncode=1)  # non-zero => treated as a crash

    runner._spawn = fake_spawn
    await runner._supervise()
    # One crash between the two spawns => exactly one restart counted.
    assert runner.restart_count == 1


@pytest.mark.asyncio
async def test_deliberate_config_restart_not_counted(tmp_path, monkeypatch):
    """A deliberate config-driven restart() must NOT inflate restart_count.

    Reconfiguring (apply_config -> restart) relaunches Node-RED but is not a
    crash, so a healthy device that only reconfigured must still report 0.
    """
    import doover_node_red.runner as runner_mod
    from doover_node_red.runner import NodeRedRunner

    async def _no_sleep(_):
        return None

    monkeypatch.setattr(runner_mod.asyncio, "sleep", _no_sleep)

    runner = NodeRedRunner(
        {"editor_enabled": True}, user_dir=str(tmp_path), template_path="/nonexistent"
    )
    calls = {"n": 0}

    async def fake_spawn():
        calls["n"] += 1
        proc = _FakeProc(returncode=0)
        if calls["n"] == 1:
            # Simulate the supervisor flagging a deliberate reconfigure restart
            # (exactly what runner.restart() does) between the two spawns.
            runner._deliberate_restart = True
        else:
            runner._stopping = True
        return proc

    runner._spawn = fake_spawn
    await runner._supervise()
    assert runner.restart_count == 0, "deliberate reconfigure must not count"


@pytest.mark.asyncio
async def test_restart_sets_deliberate_flag(tmp_path):
    """restart() flags the next respawn as deliberate (not a crash)."""
    from doover_node_red.runner import NodeRedRunner

    runner = NodeRedRunner(
        {"editor_enabled": True}, user_dir=str(tmp_path), template_path="/nonexistent"
    )
    runner._proc = _FakeProc(returncode=0)
    runner._proc.returncode = None  # looks alive
    await runner.restart()
    assert runner._deliberate_restart is True


# --- supervised-mode application lifecycle ----------------------------------


@pytest.mark.asyncio
async def test_open_editor_notice_uses_modern_notifications_channel():
    from doover_node_red.application import NodeRedApplication

    app = NodeRedApplication()
    app.create_message = AsyncMock()
    ctx = AsyncMock()

    await app.on_open_editor(ctx, None)

    app.create_message.assert_awaited_once_with(
        "notifications",
        {
            "message": "Open Editor is not implemented yet — coming in a later phase.",
            "topic": "dev/applications/default/node-red/open-editor",
            "severity": "Info",
        },
    )
    ctx.set_value.assert_awaited_once_with(None)


@pytest.mark.asyncio
async def test_close_no_runner_does_not_raise():
    """close() must not AttributeError when setup() never ran (runner unset).

    On a DDA-less boot pydoover's gated startup can raise before setup() runs, so
    self.runner is never assigned; a bare self.runner.stop() there would mask the
    shutdown with an AttributeError (observed crashing the container's teardown).
    """
    import doover_node_red.application as app_mod
    from doover_node_red.application import NodeRedApplication

    app = NodeRedApplication()
    assert not hasattr(app, "runner")

    # Neutralise pydoover's super().close() (it cancels asyncio.all_tasks()).
    async def _noop_super_close(self):
        return None

    monkeypatch_target = app_mod.Application
    orig = monkeypatch_target.close
    monkeypatch_target.close = _noop_super_close
    try:
        await app.close()  # must not raise AttributeError
    finally:
        monkeypatch_target.close = orig


@pytest.mark.asyncio
async def test_supervised_close_leaves_external_runner_and_tasks_alive():
    """Supervised close() must not stop the shared runner or cancel sibling tasks.

    pydoover's Application.close() cancels asyncio.all_tasks(); in supervised mode
    that would kill the supervisor's own Node-RED runner + main loop, so the
    Application must close only its own interfaces.
    """
    from doover_node_red.application import NodeRedApplication

    class _FakeRunner:
        def __init__(self):
            self.stopped = False

        async def stop(self):
            self.stopped = True

    app = NodeRedApplication()
    runner = _FakeRunner()
    app.attach_runner(runner)
    assert app._owns_runner is False

    # A sibling task standing in for the supervisor's own runner/main-loop tasks.
    sibling = asyncio.ensure_future(asyncio.sleep(5))

    await app.close()

    assert runner.stopped is False, "shared runner must not be stopped"
    assert not sibling.cancelled(), "sibling supervisor task must survive"
    sibling.cancel()


# --- runtime config re-apply ------------------------------------------------


@pytest.mark.asyncio
async def test_apply_config_rerenders_and_updates_config(tmp_path):
    from doover_node_red.runner import NodeRedRunner

    runner = NodeRedRunner(
        {"editor_enabled": True, "timezone": "UTC"},
        user_dir=str(tmp_path),
        template_path="/nonexistent-falls-back-to-repo-template",
    )
    # No node-red running: apply_config re-renders settings, updates config, and
    # its restart() is a safe no-op.
    await runner.apply_config(
        {"editor_enabled": False, "timezone": "Australia/Brisbane"}
    )

    assert runner.config["timezone"] == "Australia/Brisbane"
    assert (tmp_path / "settings.js").exists()


# --- SIGTERM handling -------------------------------------------------------


@pytest.mark.asyncio
async def test_sigterm_handler_installed_and_fires():
    from doover_node_red.application import install_sigterm_handler

    loop = asyncio.get_running_loop()
    fired = asyncio.Event()
    installed = install_sigterm_handler(loop, fired.set)
    assert installed, "SIGTERM handler installed on this loop"

    try:
        os.kill(os.getpid(), signal.SIGTERM)
        await asyncio.wait_for(fired.wait(), timeout=2)
    finally:
        loop.remove_signal_handler(signal.SIGTERM)

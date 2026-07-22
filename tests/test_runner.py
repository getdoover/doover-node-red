"""Regression tests for the supervisor runner + application lifecycle fixes.

Covers:
- persisted credential secret across boots (no fresh key every restart),
- NODE_OPTIONS appended, not overwritten,
- extra_palette_packages actually installed at startup,
- runtime config re-apply (apply_config re-renders settings),
- SIGTERM handler installation.
"""

import asyncio
import os
import signal
import stat

import pytest


def _make_fake_npm(directory, outfile):
    """Write a fake `npm` that records its args to ``outfile`` and exits 0."""
    script = directory / "fake_npm.sh"
    script.write_text(f'#!/bin/sh\nprintf "%s" "$*" > "{outfile}"\nexit 0\n')
    script.chmod(script.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return script


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

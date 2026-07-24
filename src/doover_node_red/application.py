"""Doover Node-RED supervisor application.

A pydoover ``Application`` that materialises Node-RED's ``settings.js`` from the
deployment config, spawns and supervises the Node-RED runtime, and reports its
health/status back to the Doover platform as tags. It also declares the app UI
(status variables, an "Open Editor" action stub, and the empty "Node-RED"
container flow UI nodes will populate later).

See PLAN.md sections 4 and 5.4.
"""

import asyncio
import logging
import signal
from datetime import datetime

from pydoover.docker import Application
from pydoover import ui

from .app_config import NodeRedConfig
from .app_tags import NodeRedTags
from .app_ui import NodeRedUI
from .runner import NodeRedRunner, RuntimeState

log = logging.getLogger(__name__)


def install_sigterm_handler(loop, callback) -> bool:
    """Install ``callback`` as the loop's SIGTERM handler.

    pydoover's ``run_app`` only catches ``KeyboardInterrupt`` (SIGINT) and installs
    no SIGTERM handler, so ``docker stop`` (SIGTERM to PID 1) would otherwise kill
    the supervisor without unwinding — skipping ``close()`` / ``runner.stop()``.
    Returns True if the handler was installed.
    """
    try:
        loop.add_signal_handler(signal.SIGTERM, callback)
        return True
    except (NotImplementedError, RuntimeError, ValueError):
        log.warning("Could not install a SIGTERM handler on this platform/loop.")
        return False


def _format_deploy_time(epoch: float) -> str:
    """Render a deploy epoch as a customer-facing string.

    Returns ``"never"`` when no deploy has been observed (epoch falsy), otherwise
    a local-time ``YYYY-MM-DD HH:MM:SS`` datetime — the device's timezone applies
    because the runner runs under the configured ``TZ``. Deliberately stable per
    deploy (not a live "x minutes ago") so it does not churn the status tag /
    activity log every loop.
    """
    if not epoch:
        return "never"
    try:
        return datetime.fromtimestamp(epoch).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    except (OSError, OverflowError, ValueError):
        return "never"


class NodeRedApplication(Application):
    config_cls = NodeRedConfig
    tags_cls = NodeRedTags
    ui_cls = NodeRedUI

    config: NodeRedConfig
    tags: NodeRedTags

    # Set via attach_runner() when the top-level supervisor (``__init__.main``)
    # owns the Node-RED runner and this Application is only the reporting/config
    # layer. When None, the Application owns the runner itself (standalone use).
    _external_runner = None

    def attach_runner(self, runner: NodeRedRunner) -> None:
        """Run in *supervised* mode against a supervisor-owned Node-RED runner.

        The top-level supervisor starts and keeps Node-RED alive independently of
        the DDA (so Node-RED serves even when the device agent is unreachable). In
        that mode this Application does not own the runner's lifecycle: it never
        starts or stops it, and its teardown must not cancel the supervisor's
        tasks. It only re-applies deployment config to, and reports health from,
        the shared runner.
        """
        self._external_runner = runner

    @property
    def _owns_runner(self) -> bool:
        return self._external_runner is None

    async def setup(self):
        self.loop_target_period = 5

        self._applied_config = self._config_snapshot()

        if self._external_runner is not None:
            # Supervised mode: adopt the supervisor's already-running runner and
            # push the real deployment config to it now that we have it (it was
            # booted with defaults before the DDA delivered config). Do NOT start
            # a second Node-RED and do NOT install signal handlers — the
            # supervisor owns process lifecycle and signals.
            self.runner = self._external_runner
            await self.runner.apply_config(self._applied_config)
            return

        # Standalone mode: own the runner and the graceful-shutdown wiring.
        self.runner = NodeRedRunner(
            config=self._applied_config,
            on_state_change=self._on_runtime_state,
        )
        await self.runner.start()

        # Handle SIGTERM (docker stop) so Node-RED gets a graceful shutdown.
        self._sigterm_installed = install_sigterm_handler(
            asyncio.get_running_loop(), self._on_sigterm
        )

    def _on_sigterm(self):
        """SIGTERM handler: route into the existing graceful-shutdown path.

        Re-raising as SIGINT lets ``run_app``'s ``except KeyboardInterrupt`` run
        ``__aexit__`` -> ``close()`` -> ``runner.stop()``, so Node-RED receives
        SIGTERM and its grace window before the container is torn down.
        """
        log.info("SIGTERM received; initiating graceful shutdown of Node-RED.")
        signal.raise_signal(signal.SIGINT)

    def _config_snapshot(self) -> dict:
        """Collect the deployment-config values the runner needs into a dict."""
        c = self.config
        return {
            "editor_enabled": c.editor_enabled.value,
            "editor_access": c.editor_access.value,
            "extra_palette_packages": c.extra_palette_packages.value,
            "flows_sync_enabled": c.flows_sync_enabled.value,
            "flow_package": c.flow_package.value,
            "credential_secret": c.credential_secret.value,
            "flow_env": c.flow_env.value,
            "memory_limit_mb": c.memory_limit_mb.value,
            "timezone": c.timezone.value,
        }

    def _on_runtime_state(self, state: str):
        # Called from the runner's supervise task on every transition. The tag is
        # reported authoritatively in main_loop (every loop_target_period); here
        # we just surface the transition in logs for immediate visibility.
        log.info("Node-RED runtime transitioned to: %s", state)

    async def main_loop(self):
        # Re-apply deployment-config changes to the running runtime. Config is
        # otherwise only read once at process start, so edits (timezone, flow_env,
        # memory, credential secret, extra packages) would be silently ignored
        # until a manual container restart.
        snapshot = self._config_snapshot()
        if snapshot != self._applied_config:
            log.info("Deployment config changed; re-applying to the Node-RED runtime.")
            self._applied_config = snapshot
            await self.runner.apply_config(snapshot)

        # Only publish health tags when the DDA is actually reachable. Dirtying
        # tags while the agent is down makes pydoover's per-loop commit raise
        # (gRPC UNAVAILABLE) and tear the loop down; skipping keeps the reporting
        # layer degrading gracefully until the DDA returns. (Node-RED itself is
        # kept alive by the supervisor regardless.)
        if not self.get_is_dda_available():
            return

        await self.tags.runtime_state.set(self.runner.state)
        await self.tags.restart_count.set(self.runner.restart_count)
        await self.tags.memory_mb.set(self.runner.memory_mb())

        # Report the last deploy as a human-readable string rather than a raw
        # Unix epoch: non-programmer customers see "never" before the first deploy
        # and a local-time datetime after, not "0" / a 10-digit number.
        await self.tags.last_deploy_time.set(
            _format_deploy_time(self.runner.last_deploy_epoch())
        )

        # Reflect fleet-mode pin (apply-loop is a later phase; report the ref).
        pkg = (self.config.flow_package.value or "").strip()
        await self.tags.applied_flow_package.set(pkg)

    @ui.handler("open_editor")
    async def on_open_editor(self, ctx, value):
        """Stub for the editor tunnel. Publishes a not-yet-implemented notice."""
        log.info("Open Editor pressed; tunnel not yet implemented.")
        await self.create_message(
            "significantEvent",
            # The platform notification banner reads `notification_msg` (matches the
            # doover-notify node and pydoover's send_notification payload shape);
            # any other key renders no banner.
            {
                "notification_msg": (
                    "Open Editor is not implemented yet — coming in a later phase."
                )
            },
        )
        await ctx.set_value(None)

    async def close(self):
        if not self._owns_runner:
            # Supervised mode: the supervisor owns Node-RED's lifecycle. Close
            # only this Application's own DDA/platform/modbus interfaces. We must
            # NOT call super().close(): it runs ``asyncio.all_tasks(): cancel()``,
            # which would tear down the supervisor's own Node-RED runner task and
            # main loop, killing Node-RED and the whole container.
            for iface in (
                getattr(self, "device_agent", None),
                getattr(self, "platform_iface", None),
                getattr(self, "modbus_iface", None),
            ):
                if iface is None:
                    continue
                try:
                    await iface.close()
                except Exception as e:  # best-effort teardown
                    log.debug("Error closing %s: %s", type(iface).__name__, e)
            return

        try:
            # Guard: setup() may never have run (e.g. pydoover's DDA-gated startup
            # raised before setup()), so ``self.runner`` can be unset. A bare
            # ``self.runner`` here would raise AttributeError and mask shutdown.
            runner = getattr(self, "runner", None)
            if runner is not None:
                await runner.stop()
        finally:
            await super().close()

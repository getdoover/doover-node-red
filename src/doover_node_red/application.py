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


class NodeRedApplication(Application):
    config_cls = NodeRedConfig
    tags_cls = NodeRedTags
    ui_cls = NodeRedUI

    config: NodeRedConfig
    tags: NodeRedTags

    async def setup(self):
        self.loop_target_period = 5

        self._applied_config = self._config_snapshot()
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

        await self.tags.runtime_state.set(self.runner.state)
        await self.tags.restart_count.set(self.runner.restart_count)
        await self.tags.memory_mb.set(self.runner.memory_mb())

        deploy_epoch = self.runner.last_deploy_epoch()
        if deploy_epoch:
            await self.tags.last_deploy_time.set(deploy_epoch)

        # Reflect fleet-mode pin (apply-loop is a later phase; report the ref).
        pkg = (self.config.flow_package.value or "").strip()
        await self.tags.applied_flow_package.set(pkg)

    @ui.handler("open_editor")
    async def on_open_editor(self, ctx, value):
        """Stub for the editor tunnel. Publishes a not-yet-implemented notice."""
        log.info("Open Editor pressed; tunnel not yet implemented.")
        await self.create_message(
            "significantEvent",
            {"text": "Open Editor is not implemented yet — coming in a later phase."},
        )
        await ctx.set_value(None)

    async def close(self):
        try:
            await self.runner.stop()
        finally:
            await super().close()

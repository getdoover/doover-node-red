"""Entry point + top-level process supervision.

The container runs Node-RED (customer flows) alongside a pydoover Application
that reports health tags and applies deployment config. The hard requirement is
that **Node-RED keeps serving even when the Doover device agent (DDA) is
unreachable** — a fresh device, an agent that is still starting, or a transient
outage must not take Node-RED (or the container) down.

pydoover's ``run_app``/``Application._run`` gates all of ``setup()`` behind a DDA
readiness wait and unwinds the whole process when a DDA call fails (gRPC
UNAVAILABLE). If Node-RED were spawned inside ``setup()``, a device with no DDA
would never serve Node-RED and the container would exit.

So this module owns the split:

* A persistent :class:`NodeRedRunner` is started immediately, independent of the
  DDA, and kept alive for the life of the container.
* The pydoover :class:`NodeRedApplication` runs in *supervised* mode against that
  shared runner purely to report health and apply config. If it exits (because
  the DDA is unreachable and ``_run`` unwinds) it is simply restarted after a
  backoff — Node-RED is never touched.
* SIGTERM/SIGINT (``docker stop``) trigger a graceful shutdown that stops
  Node-RED within its grace window.
"""

import asyncio
import logging
import signal

from pydoover.docker import run_app

from .application import NodeRedApplication
from .runner import NodeRedRunner

log = logging.getLogger(__name__)

# Backoff bounds (seconds) for restarting the pydoover reporting app after it
# exits — almost always because the DDA is unreachable and pydoover's _run()
# unwound. Node-RED stays up throughout; this only paces reporting retries.
_REPORTER_BACKOFF_MIN = 1.0
_REPORTER_BACKOFF_MAX = 30.0


async def _run_reporting_app(runner: NodeRedRunner, *, setup_logging: bool) -> None:
    """Run one lifecycle of the pydoover reporting app against ``runner``.

    Returns when the app's ``_run`` completes or raises (both are normal when the
    DDA is unreachable). ``run_app(..., start=False)`` wires app_key/URIs/config
    from CLI args + env and returns the async runner coroutine without blocking.
    """
    app = NodeRedApplication()
    app.attach_runner(runner)
    await run_app(app, start=False, setup_logging=setup_logging)


async def _run_supervisor() -> None:
    # 1) Bring Node-RED up immediately, independent of the DDA. This is the
    #    critical decoupling: Node-RED must serve regardless of device-agent
    #    reachability, so the runner is owned here — NOT inside the DDA-gated
    #    Application.setup(). It boots with default settings; the reporting app
    #    pushes the real deployment config once the DDA delivers it.
    runner = NodeRedRunner(config={})
    await runner.start()

    shutdown = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _request_shutdown(signame: str) -> None:
        log.info("%s received; initiating graceful shutdown.", signame)
        shutdown.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _request_shutdown, sig.name)
        except (NotImplementedError, RuntimeError, ValueError):
            log.warning("Could not install a %s handler on this platform.", sig.name)

    backoff = _REPORTER_BACKOFF_MIN
    first = True
    try:
        while not shutdown.is_set():
            app_task = asyncio.ensure_future(
                _run_reporting_app(runner, setup_logging=first)
            )
            first = False
            shutdown_task = asyncio.ensure_future(shutdown.wait())
            try:
                await asyncio.wait(
                    {app_task, shutdown_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
            finally:
                shutdown_task.cancel()

            if shutdown.is_set():
                app_task.cancel()
                try:
                    await app_task
                except (asyncio.CancelledError, Exception):
                    pass
                break

            # The reporting app exited on its own — the DDA is unreachable and
            # pydoover's _run() unwound. Node-RED keeps serving; retry the
            # reporting layer after a backoff (interruptible by shutdown).
            exc = None
            try:
                exc = app_task.exception()
            except (asyncio.CancelledError, asyncio.InvalidStateError):
                pass
            log.warning(
                "Reporting app exited (%s); Node-RED stays up, retrying in %.0fs.",
                exc,
                backoff,
            )
            try:
                await asyncio.wait_for(shutdown.wait(), timeout=backoff)
            except asyncio.TimeoutError:
                pass
            backoff = min(backoff * 2, _REPORTER_BACKOFF_MAX)
    finally:
        # Graceful teardown: stop Node-RED (SIGTERM + grace) so `docker stop`
        # completes within its timeout instead of being SIGKILLed.
        log.info("Stopping Node-RED runtime.")
        await runner.stop()


def main():
    """Entry point — supervise Node-RED (DDA-independent) + the reporting app."""
    try:
        asyncio.run(_run_supervisor())
    except KeyboardInterrupt:
        pass

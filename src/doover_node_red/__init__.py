from pydoover.docker import run_app

from .application import NodeRedApplication


def main():
    """Entry point — run the Node-RED supervisor application."""
    run_app(NodeRedApplication())

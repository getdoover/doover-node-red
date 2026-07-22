from pydoover.docker import run_app

from .application import SampleApplication

def main():
    """Run the application."""
    run_app(SampleApplication())

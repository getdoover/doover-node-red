"""Checks for the production deployment package."""

from pathlib import Path


def test_production_mounts_persistent_node_red_data():
    """Node-RED flows must survive container replacement during a redeploy."""
    compose = (
        Path(__file__).parents[1] / "deployment" / "docker-compose.yml"
    ).read_text()

    assert "      - node_red_data:/data\n" in compose
    assert "\nvolumes:\n  node_red_data:\n" in compose

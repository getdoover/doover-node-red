
# Doover App Template

<img src="https://doover.com/wp-content/uploads/Doover-Logo-Landscape-Navy-padded-small.png" alt="App Icon" style="max-width: 300px;">

**A ready template for a Doover Application**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://github.com/getdoover/app-template/blob/main/LICENSE)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/getdoover/app-template?quickstart=1)

[Getting Started](#-getting-started) • [Configuration](#configuration) • [Developer](https://github.com/getdoover/app-template/blob/main/DEVELOPMENT.md) • [Need Help?](#need-help)

<br/>

## 📖 Overview

A ready-to-use template for building Doover applications. This template provides the essential
structure and configuration needed to quickly get started with app development on the Doover
platform, using [pydoover](https://github.com/getdoover/pydoover) 1.0.

Use this repository as a starting point: fork it (or use the "Use this template" button),
rename the `app_template` package, and replace the sample config, tags, UI, and state machine
with your own.

<br/>

## 🚀 Getting Started

### How to Use

#### Quick Start Guide

Click the **Open in GitHub Codespaces** badge above to launch a ready-to-go development environment with:
- Python 3.13, uv, and all project dependencies
- Doover CLI (`doover`) pre-installed — you'll be prompted to log in on first open
- Claude Code with [doover-skills](https://github.com/getdoover/doover-skills) pre-configured

> **Claude Code:** You'll be prompted for your `ANTHROPIC_API_KEY` when creating a Codespace.
> Get a key at [console.anthropic.com](https://console.anthropic.com/settings/keys).
> To skip this prompt in future, save it as a permanent secret at
> [github.com/settings/codespaces](https://github.com/settings/codespaces).

This Doover App can be managed via the Doover CLI, and installed quickly onto devices through the Doover platform.

### Configuration

Configuration fields are declared in [`src/app_template/app_config.py`](src/app_template/app_config.py).
The sample schema ships with:

| Setting | Description | Default |
|---------|-------------|---------|
| **Digital Outputs Enabled** | Toggle whether the app drives digital outputs | `true` |
| **A Funny Message** | Free-text message used by the sample alert button | *(required)* |
| **Simulator App Key** | App key of the simulator supplying `random_value` | *(required)* |

Replace these with your own fields, then regenerate `doover_config.json` with `uv run export-config`.

<br/>

## 🔗 Integrations

### Tags

The sample app publishes a few example tags via [`src/app_template/app_tags.py`](src/app_template/app_tags.py):

| Tag | Description |
|-----|-------------|
| **is_working** | Heartbeat — `true` while the main loop is running |
| **uptime** | Seconds since the app started |
| **battery_voltage** | Example numeric value sourced from the simulator |
| **test_output** | Echoes text entered in the UI |

<br/>

### Need Help?

- 📧 Email: support@doover.com
- 📖 [Doover Documentation](https://docs.doover.com)
- 👨‍💻 [App Developer Documentation](https://github.com/getdoover/app-template/blob/main/DEVELOPMENT.md)

<br/>

## 📄 License

This app is licensed under the [Apache License 2.0](https://github.com/getdoover/app-template/blob/main/LICENSE).

# Node-RED on Doover

Run the Node-RED flow editor and runtime on a Doovit, and wire its flows straight into Doover. Build logic by dragging nodes onto a canvas instead of writing code, and read or write Doover tags, channels and notifications from that same flow.

---

<p align="left">
  <img src="https://raw.githubusercontent.com/getdoover/doover-node-red/main/assets/app-types/app-type-device-coloured.png?v=cf880f3d16a5" alt="App Type: Device — Runs on edge hardware" align="left" width="180" height="180">
  <img src="https://raw.githubusercontent.com/getdoover/doover-node-red/main/assets/app-types/ui-interface-coloured.png?v=f52f45b2e686" alt="UI: Interface — Has a User Interface" align="left" width="180" height="180">
  <img src="https://raw.githubusercontent.com/getdoover/doover-node-red/main/assets/app-types/badge-external-runtime-coloured.png?v=4d38cee9c90b" alt="External Runtime — Installs an external runtime" align="left" width="180" height="180">
  <br clear="all">
</p>

---

- **Build device logic visually.** Drag, wire and deploy — no build step, no code push, no app release.
- **Talk to Doover from a flow.** Dedicated nodes read and write tags, publish and subscribe to channels, and raise Doover notifications.
- **Work with the rest of the device.** Read tags published by the other apps on the same Doovit, or reach another device through the Doover cloud.
- **Watch it from Doover.** Runtime state, last deploy time, memory use and restart count appear on the device page.

## What you get

Node-RED 4.0.9 (Node.js 22) running in its own container on the Doovit, with the Doover node palette already installed. Nothing to install in the editor, and no credentials to enter — nodes connect to the device's local Doover agent automatically.

Flows are stored on the device in a persistent volume, so they survive restarts and app updates. Export a copy from the editor to keep a backup off the device.

## The Doover palette

All nodes appear under the **Doover** category in the editor's node list.

| Node | Use it to |
| --- | --- |
| **doover tag in** | Emit a message whenever a tag changes |
| **doover tag get** | Read a tag's current value into a message property |
| **doover tag out** | Write a tag value, one at a time or a batch of tag/value pairs |
| **doover channel in** | Subscribe to a channel and receive its messages |
| **doover channel out** | Publish to a channel, merging into its aggregate |
| **doover message** | Publish a one-shot channel message |
| **doover aggregate get** | Read a channel's current aggregate |
| **doover notify** | Send a Doover notification, optionally logging it as an activity entry |

Every node points at a **doover-connection** config node, which sets where it talks to:

- **This device (local)** — the default. Talks to the Doover agent on the same Doovit. No configuration needed.
- **Doover Cloud** — talks to `api.doover.com`. Set the target **Agent** id and paste a scoped API **Token**, which is stored as a Node-RED credential.

Tag nodes have a **Scope**: **This app** for the Node-RED app's own tags, **Another app** plus an **App key** to read a different app on the device, or **Global**.

Four example flows ship with the app — open **Import → Examples → node-red-contrib-doover** in the editor to load a tag-to-notification, channel round-trip, cross-app tag read or HTTP-to-Doover flow.

## Opening the editor

Open the editor over the local network, at port 1880 on the device:

```
http://<doovit-ip-address>:1880
```

**The editor has no login.** Anyone who can reach port 1880 on the device can deploy arbitrary flows to it. Only expose it on a trusted network, and turn **Editor Enabled** off on production devices — flows keep running, the editor simply is not served.

## Settings

| Setting | What it does |
| --- | --- |
| **Editor Enabled** | Serve the flow editor. Turn off to lock down a production device; flows still run. |
| **Extra Palette Packages** | npm package names to install at startup, e.g. `node-red-contrib-modbus`. These are also the only packages the editor's palette manager is allowed to install. Installs need connectivity and add boot time. |
| **Flow Environment Variables** | Key/value pairs your flows read as `${VAR}` in node config — the place for per-device values such as a site name or a setpoint. |
| **Memory Limit (MB)** | V8 heap cap, default 256. This bounds the JavaScript heap, not total process memory; the runtime typically uses 120–250 MB RSS. |
| **Timezone** | IANA timezone (e.g. `Australia/Brisbane`) used by scheduling nodes. Defaults to UTC. |

## Getting started

1. Install the app on a Doovit and wait for **Runtime State** on the device page to read `running`.
2. Open `http://<doovit-ip>:1880` from a machine on the same network.
3. Drag a **doover tag in** node onto the canvas, pick a tag, wire it to a **doover notify** node and click **Deploy**.
4. Check **Last Deploy** on the device page to confirm the deploy landed.

## Licence and trademark

The device app is Apache 2.0; the JavaScript palette packages are MIT. Node-RED is a trademark of the OpenJS Foundation — this app embeds and integrates with Node-RED but is not endorsed by or affiliated with the OpenJS Foundation.

## Need help?

- hello@doover.com
- [Doover Documentation](https://docs.doover.com)

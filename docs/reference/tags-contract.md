# Doover Tags Contract Reference

The definitive contract for building a **tag layer** on top of a channel transport,
re-implementing pydoover's tag semantics in `@doover/nodered-core`.

Tags are *not* a distinct platform primitive. They are a convenience layer over a
single channel aggregate named **`tag_values`**. Anything a device-side tag writer
does reduces to three channel operations: **update aggregate** (diff merge),
**create message** (persisted log), and **send one-shot** (ephemeral live value).
This document is the exact behaviour our JS layer must reproduce.

> **Primary source:** `pydoover/pydoover/tags/manager.py` (the `TagsManagerDocker`
> class — the docker/device-agent implementation we mirror). Secondary:
> `pydoover/pydoover/tags/__init__.py` (declarative `Tag`/`Tags` API),
> `pydoover/pydoover/docker/application.py` (the app-facing wrappers),
> `pydoover/pydoover/utils/diff.py` (the diff engine),
> `pydoover/pydoover/models/data/events.py` and `.../aggregate.py` (event shapes),
> `pydoover/docs/12-Tags-and-Channels.md` (conceptual overview).
> All line numbers below refer to those files at the time of writing.

There is a **second** tag manager, `TagsManagerProcessor` (`manager.py:584-682`),
used only in cloud-processor execution. Its storage model differs (see
[§10](#10-the-processor-variant-do-not-copy-this-one)); **do not copy it** — the
device/channel model in `TagsManagerDocker` is what LocalTransport and CloudTransport
both target.

---

## 1. The `tag_values` channel

### 1.1 Channel name and aggregate shape

```
TAG_CHANNEL_NAME       = "tag_values"        # manager.py:20
LIVE_TAG_CHANNEL_NAME  = "tag_values"        # manager.py:25 (same channel today)
```

The tag store is the **aggregate** of the `tag_values` channel. A channel aggregate
is the merged state of every message/aggregate-update ever applied to the channel
(`docs/12-Tags-and-Channels.md:170-182`). Its wire shape is an `Aggregate`
(`models/data/aggregate.py:19-33`):

```jsonc
{
  "data":         { /* the nested tag dict — this is what tags live in */ },
  "attachments":  [ /* unused by tags */ ],
  "last_updated": 1719900000000   // ms since epoch, or null
}
```

Everywhere below, "the aggregate" means `aggregate.data` — a plain nested JSON
object. The manager caches it in `self._tag_values` and treats it as the source of
truth (`manager.py:193`, seeded at `_on_tag_sync` `manager.py:326-327`).

### 1.2 Namespacing by `app_key` — and the global namespace

A tag key is turned into a **path** into `data` by `KeyPath` (see [§2](#2-keypath)).
The only namespacing rule is: **if an `app_key` is supplied, it is inserted as the
first path segment** (`manager.py:62-66`):

```python
if app_key is not None:
    path.insert(0, app_key)
```

So a tag `temperature` written by app `cu_myapp_1234` lands at
`data["cu_myapp_1234"]["temperature"]`. The per-app namespace key is the **exact
`app_key` string** — no transformation, no prefix, no suffix.

**Global tags have NO magic namespace string.** A global tag is written with
`app_key=None`, which means *no segment is inserted*, so the key lands at the **root
of `data`**, un-namespaced, sitting as a sibling of the per-app namespace objects.
This is confirmed by the application wrappers, which implement "global" purely as
`app_key=None`:

- `get_global_tag` → `self.tag_manager.get_tag(tag_key, default=..., app_key=None)`
  (`application.py:953`)
- `set_global_tag` → `self.tag_manager.set_tag(tag_key, value, app_key=None, ...)`
  (`application.py:1039-1045`)
- `subscribe_to_tag(..., global_tag=True)` → subscribes with **no** `app_key`
  (`application.py:881-886`)

> **The exact global "namespace" is: the top level of `data` itself (no wrapper
> key).** Do not invent a `"global"` / `"_global"` / `"__global__"` key — there is
> none in the source. A global tag named `system_mode` is literally
> `data["system_mode"]`.

Resulting aggregate structure:

```jsonc
{
  // ---- global tags: bare keys at the root (app_key = None) ----
  "system_mode":     "auto",
  "emergency_stop":  false,

  // ---- per-app namespaces: key == the exact app_key string ----
  "cu_myapp_1234": {
    "temperature": 25.5,
    "status":      "running",
    "battery":     { "voltage": 12.3, "current": 0.8 }   // nested (see §2)
  },
  "cu_otherapp_5678": {
    "pump_speed": 1450
  }
}
```

**Consequence for our JS layer:** a global tag whose name collides with an app_key
would corrupt that app's namespace (e.g. a global tag literally named
`cu_myapp_1234`). pydoover does not guard against this; global tags are documented
as "use sparingly" (`application.py:930-934`). Our dropdowns should steer users to
app-scoped tags and treat global as an advanced scope.

### 1.3 Key charset (device-agent validation)

The device agent validates every payload before it is accepted
(`device_agent.py:45-78`, `validate_payload`):

- Top level must be a dict.
- **Keys must match `[A-Za-z0-9_-]+`** — only alphanumerics, hyphen, underscore.
- Values may be dict / list / str / int / float / bool / null.

This has a hard consequence for path handling: **a key segment may never contain a
`.`** A dotted string like `"battery.voltage"` used as a *single* key is rejected by
the agent. Dotted paths must therefore be **split into a list** before they reach
the transport (see [§2.3](#23-dot-notation-is-the-js-layers-job-not-keypaths)).

---

## 2. KeyPath

`KeyPath` (`manager.py:42-127`) is the normaliser that maps a caller's key +
optional `app_key` into a list of path segments into `data`.

### 2.1 Construction

`KeyPath(key, app_key=None)` where `key` is `str | list[str] | KeyPath`
(`manager.py:45-69`):

- `KeyPath` in → copies `_path`, `app_key`, `key` (idempotent wrapping,
  `manager.py:46-50`).
- `str` in → `path = [key]` (a single segment — **it is not split on dots**,
  `manager.py:52-53`).
- `list`/iterable in → `path = list(key)` (each element is one segment,
  `manager.py:54-55`).
- Validation: path must be non-empty and every segment a **non-empty string**;
  otherwise `ValueError` (`manager.py:57-60`).
- If `app_key is not None`: it is `insert(0, app_key)`-ed as the leading segment
  (`manager.py:62-66`). `app_key` must be a string.

The instance keeps three things: `.path` (the full normalised segment list incl.
the app_key prefix), `.app_key` (or None), and `.key` (the **original** un-prefixed
key argument — this is what subscription callbacks echo back, [§6](#6-subscriptions--change-detection)).

### 2.2 The four path operations

| Method | Behaviour | Source |
|--------|-----------|--------|
| `get()` / `.path` | Return the normalised segment list. | `manager.py:71-77` |
| `construct_dict(value)` | Wrap a leaf value into nested dicts, **innermost last**: `["a","b"] , 5 → {"a":{"b":5}}`. Reverses the path and nests. | `manager.py:79-84` |
| `lookup_dict(d)` | Walk the path into nested dict `d`; return `None` on any missing key or non-dict node (or raise `KeyError` if `raise_key_error=True`). | `manager.py:86-98` |
| `in_dict(d)` | Boolean: does the full path resolve in `d`? | `manager.py:100-110` |

`construct_dict` is how a single-tag write becomes a partial aggregate:
`set_tag(key, value)` → `KeyPath(key, app_key).construct_dict(value)` →
a minimal nested dict containing only that one leaf (`manager.py:402-405`).

### 2.3 Dot-notation is the JS layer's job, not KeyPath's

`KeyPath` **never splits on `.`** A `str` key is always exactly one segment. Nested
paths are expressed as **arrays**: `["battery","voltage"]`, not `"battery.voltage"`.

The PLAN's "`battery.voltage` dot-notation → KeyPath" (PLAN §3.1) is a UI affordance
we implement in the node/tag layer: **split the user's dotted string on `.` and pass
the resulting array as the key.** Reasons this is mandatory, not optional:

1. The device agent rejects `.` in keys ([§1.3](#13-key-charset-device-agent-validation)),
   so a literal dotted segment can never be stored anyway.
2. Only an array produces the nested-dict structure that `construct_dict` /
   `lookup_dict` / the diff engine operate on.

**JS contract:** accept `"a.b.c"` from the user, store/lookup as `["a","b","c"]`.
Reject any single segment containing characters outside `[A-Za-z0-9_-]` early, with a
clear node error, rather than letting the transport reject it opaquely.

### 2.4 Equality/hashing caveats (relevant if you mirror the dict-keyed subscription map)

`KeyPath.__hash__` is `hash(".".join(self.path))` (`manager.py:124-126`) and
`__eq__` is **destructive** — it mutates the `other` list via `.remove()`
(`manager.py:112-122`). pydoover keys its subscription dict by `KeyPath`. In JS,
**do not port this**; use a stable string key like `path.join(" ")` (a
delimiter that can't appear in a valid segment) for your subscription registry map.

---

## 3. Writing a tag: how `set_tag` builds a channel write

### 3.1 Call chain

`set_tag(key, value, app_key, only_if_changed=True, flush=False, log=False)`
(`manager.py:392-405`) → `construct_dict` → `set_tags(...)`
(`manager.py:407-462`). `set_tags` is where all the logic lives; `set_tag` is a
thin single-leaf wrapper. `set_tags` also accepts a raw multi-key dict for atomic
multi-writes (this is the PLAN's "batch mode", `set_tags` PLAN §3.1).

### 3.2 Writes are **diff-based**, not full-aggregate

This is the single most important implementation fact.

1. **only_if_changed gate** (`manager.py:420-432`): compute
   `generate_diff(current, tags, do_delete=False)` where `current =
   apply_diff(self._tag_values, self._pending_tag_aggregate)` (cached aggregate +
   not-yet-flushed pending writes). If the diff is empty, **return without writing.**
   So a set to an unchanged value is a no-op.
2. **Accumulate into the pending aggregate** (`manager.py:459-462`, default
   `flush=False`): `apply_diff(self._pending_tag_aggregate, tags, do_delete=False,
   clone=False)` merges this write's leaves into a buffer; mark `_tags_dirty = True`.
   Nothing hits the wire yet.
3. **Flush** — at end of the main loop via `commit_tags → flush_tags`
   (`manager.py:464-491`), or immediately if `flush=True` was passed
   (`manager.py:447-457`). The flush issues **one** RPC:

   ```python
   await self.client.update_channel_aggregate(
       TAG_CHANNEL_NAME,          # "tag_values"
       data,                      # the pending aggregate = ONLY changed leaves
       max_age_secs=self.max_age_secs,
   )
   apply_diff(self._tag_values, data, clone=False)   # fold into local cache
   ```

The RPC is **`UpdateAggregate`** (`update_channel_aggregate`,
`device_agent.py:600-623`). Crucially it sends the **diff** (the accumulated changed
leaves), and `replace_data` defaults to **False** → the device agent **merges** the
diff into the stored aggregate. We never send the whole aggregate. Our
`DooverTransport.publish(channel, payload, {maxAge})` for the tag layer must map to
this exact call: partial payload, merge semantics, `max_age_secs`.

> **`max_age_secs`** is a per-write cache-lifetime hint carried on the aggregate
> update. See [§5](#5-max_age-and-the-observed-vs-cloud-constants) for how its value
> is chosen.

### 3.3 `flush=True` vs buffered

- `flush=False` (default): buffer into `_pending_tag_aggregate`, flush once per main
  loop (`commit_tags`). This is the normal path and it **coalesces** many `set_tag`
  calls in one iteration into a single `UpdateAggregate` RPC.
- `flush=True` (`manager.py:447-457`): fold `tags` into the pending aggregate and
  push immediately, then fold into `_tag_values` and clear dirty. Use for
  latency-sensitive one-off writes.

Our JS layer should replicate the **coalescing buffer** with an explicit
"commit at end of tick / flush timer" so a flow that sets ten tags in one message
produces one channel write, not ten.

### 3.4 Deletes and `null` — the `do_delete=False` discipline

The pending buffers are built with `do_delete=False` on purpose (`manager.py:438,
445, 449, 461`). In the diff engine (`diff.py:34-48`):

- `apply_diff(..., do_delete=True)` — a `null` leaf **removes** the key.
- `apply_diff(..., do_delete=False)` — a `null` leaf **is preserved as `null`**.

pydoover deliberately keeps `null` in the *pending* buffer (`do_delete=False`) so
that `tag.set(None)` / `tag.delete()` survives long enough to reach the agent as an
explicit `null` leaf — where the platform interprets `null` as "clear this key"
(`__init__.py:1088-1091`; comment at `manager.py:442-445`). If it used the default
`do_delete=True` locally, the key would be popped from the pending diff and the
delete would never leave the client.

**JS contract:** deletion is communicated as a **`null` value at the leaf path**.
Build your pending/merge buffers so `null` is *retained* locally and *transmitted*;
let the platform do the removal. Model `tag delete` as `set(null)` (prefer an
explicit `delete` verb in the node API, per `BoundTag.delete`,
`__init__.py:704-711`).

### 3.5 What `log` does

`log` is orthogonal to the aggregate write. Every tag change updates the aggregate;
`log` additionally records a **persisted historical data point** — a real channel
*message* (not just an aggregate merge). Two buffers, two flush cadences
(`manager.py:434-445`):

- **`log=False`** (default) → merge into `_pending_tag_log` (the **periodic** log
  buffer, `manager.py:445`). Flushed by `flush_logs` only every
  `tag_log_interval` seconds (= `TAG_CLOUD_MAX_AGE` = 15 min,
  `manager.py:472-476, 552-562`). This is the slow "at least every 15 min, snapshot
  the changed tags into history" path.
- **`log=True`** → merge into `_pending_immediate_log` (the **immediate** log buffer,
  `manager.py:438`) **and** strip those same paths out of the periodic buffer via
  `_strip_paths` so the same change isn't logged twice (`manager.py:439`,
  `_strip_paths` at `manager.py:129-144`). Flushed by `flush_immediate_logs` at the
  **end of the current main loop** (`manager.py:469-471, 564-581`) — i.e. within one
  loop, not up to 15 minutes later.

Both log flushes use the **`CreateMessage`** RPC (`create_message`,
`device_agent.py:534-555`) against `tag_values`, which appends a persisted message.
Contrast with the aggregate write (`UpdateAggregate`) which only updates current
state.

> Note: the auto-log **descriptors** (`Cross`/`Rise`/`Fall`/`Delta`/`AnyChange`/
> `Enter`/`Exit`, `__init__.py:186-390`) live in the *declarative* `Tags` layer, not
> the manager: `Tags._set_tag_value` evaluates a tag's `log_on=` triggers and, if any
> fires, sets `log=True` on the manager call (`__init__.py:1074-1086`). Our JS node
> layer can offer the same "log on threshold crossing / on change" options and
> translate them into `recordLog` on the write; the manager itself only sees the
> boolean.

**JS contract:** `DooverTransport.publish(channel, payload, {recordLog})` maps to
"also `CreateMessage`". The tag layer exposes `log`/`recordLog` per write. You may
collapse pydoover's two-buffer immediate-vs-periodic scheme to a simpler model
(e.g. "log=true → message now; otherwise aggregate-only"), but if you want history
parity you should retain the periodic snapshot so long-lived unchanged tags still
land in history occasionally.

---

## 4. `live=True` tags

### 4.1 What a live tag is

`Tag(..., live=True)` (`__init__.py:47-55, 68-71`) marks a tag whose **current value
is republished as a one-shot (ephemeral, non-persisted) message every main-loop
iteration**, so a UI watching in "live mode" gets high-rate fresh values without
polluting the message history.

### 4.2 The mechanism

- The app framework, after tag setup, calls `Tags.get_live_tag_keys()`
  (`__init__.py:978-998`) to collect `(app_key, tag_name)` for every `live=True`
  tag, and hands them to the manager via `set_live_tags(...)`
  (`manager.py:493-502`), which stores resolved `KeyPath`s in `_live_tag_keys`.
- Each `commit_tags` (end of every loop) calls `flush_live_tags`
  (`manager.py:464-467, 504-550`). It:
  1. No-ops if no live tags declared (`manager.py:516-517`).
  2. Computes the set of tags a user currently has in live mode, from the
     **`dv-ui-sub`** presence channel's `live_tag_open` bucket
     (`_live_tags_opened`, `manager.py:314-320, 519-521`). **If nobody is watching
     any live tag, it does nothing** — no point streaming to no one.
  3. For each declared live key that is *both* currently watched *and* currently has
     a value, adds it to a payload, keyed by its **qualified name**
     `"<app_key>.<tag_name>"` (or bare `tag_name` if global) — this qualification is
     what the customer-site uses to disambiguate same-named tags across apps
     (`manager.py:527-544`; same convention in `is_live_tag_open`,
     `manager.py:287-297`).
  4. Sends the payload via **`send_oneshot_message`** (RPC `SendOneShotMessage`,
     `device_agent.py:557-570`) to `LIVE_TAG_CHANNEL_NAME` (`manager.py:549`).

One-shot messages are delivered to subscribers but **not persisted** to the channel
aggregate or history (`events.py:64-67`, `OneShotMessage`).

### 4.3 Cadence and channel

- **Cadence:** once per main-loop iteration (whatever the app's loop period is),
  gated on "someone is watching".
- **Channel:** `LIVE_TAG_CHANNEL_NAME` = `"tag_values"` **today** — the same channel
  as persisted values (`manager.py:20-25`). The comment notes this can be pointed at
  a dedicated channel later to keep live traffic out of tag-value history. Our JS
  layer should read the channel name from a constant, not hard-code the assumption
  that live == `tag_values`.

**JS contract:** `DooverTransport.sendOneShot(channel, payload)` → `SendOneShotMessage`.
The tag layer's `live` option streams the current value on a timer, ideally gated on
presence (see [§4.4](#44-dv-ui-sub-presence-does-a-device-side-writer-care)) and
**rate-limited** (the PLAN calls for a rate-limit guard, §3.1) so a fast flow can't
flood the transport.

### 4.4 `dv-ui-sub` presence — does a device-side writer care?

```
UI_SUB_CHANNEL_NAME = "dv-ui-sub"   # manager.py:36
UI_SUB_FRESH_MS     = 120_000       # manager.py:37 (120s freshness window)
```

`dv-ui-sub` is a **per-device presence channel** describing "what is a user doing
that touches this device right now". Its aggregate has per-bucket, per-user entries
(`manager.py:27-35`):

```jsonc
{
  "agent_open":    { "<user_id>": <ts_ms> },
  "group_open":    { "<user_id>": <ts_ms> },
  "app_open":      { "<user_id>": { "ts": <ts_ms>, "apps": ["<app_key>", ...] } },
  "live_tag_open": { "<user_id>": { "ts": <ts_ms>, "tags": ["<app_key>.<tag>", ...] } }
}
```

Timestamps are ms-since-epoch; **the customer-site re-stamps every 120 s** while a
tab is visible, so any entry older than `UI_SUB_FRESH_MS` is treated as gone
(`_fresh_bucket_entries`, `manager.py:239-255`). The manager **only ever reads this
channel** — it subscribes at setup (`manager.py:223-227`, `on_ui_sub_update`
`manager.py:236-237`) and uses it for two decisions:

1. **`is_app_open`** → drives `max_age_secs` (fast-publish only when the app is on
   screen; see [§5](#5-max_age-and-the-observed-vs-cloud-constants)).
2. **`live_tag_open.tags`** → which live tags to actually stream ([§4.2](#42-the-mechanism)).

Other read-only helpers: `is_being_observed`, `is_agent_open`, `is_group_open`,
`is_live_tag_open(tag)` (`manager.py:257-320`).

> **A device-side tag *writer* never writes `dv-ui-sub`.** The customer-site (the
> browser) is the writer; the device only reads it to optimise publish cadence and
> to avoid streaming live values nobody is watching.
>
> **Minimum viable JS layer:** you can ignore `dv-ui-sub` entirely and still be
> correct — just always publish at a fixed `max_age` and (if you support `live`)
> stream on a timer/rate-limit without presence gating. You **lose two
> optimisations**: (a) adaptive fast/slow `max_age`, and (b) not wasting one-shots
> when no UI is open. If/when you want them, **subscribe** to `dv-ui-sub`, apply the
> 120 s freshness window, and mirror `is_app_open` / `live_tag_open` — but never
> publish to it.

---

## 5. `max_age` and the observed-vs-cloud constants

```
TAG_CLOUD_MAX_AGE    = 60 * 15   # 900 s / 15 min   — manager.py:18
TAG_OBSERVED_MAX_AGE = 3         # 3 s              — manager.py:19
```

- `default_max_age = TAG_CLOUD_MAX_AGE` (900 s), `observed_max_age =
  TAG_OBSERVED_MAX_AGE` (3 s) (`manager.py:200-202`).
- `max_age_secs` property (`manager.py:322-324`):

  ```python
  return self.observed_max_age if self.is_app_open else self.default_max_age
  ```

`max_age_secs` is passed on **every aggregate write** (`manager.py:453, 489`). What it
means: it is the **cache-lifetime hint** the device agent applies to the aggregate
update — how long the platform should treat this pushed value as "fresh"/authoritative
before it may be considered stale. When a user has the app open on the customer-site
(`is_app_open`), values are published with a **short** 3 s max-age (fast, responsive
live view); otherwise a **long** 15 min max-age (batched, low-traffic, battery/data
friendly).

`tag_log_interval` defaults to `TAG_CLOUD_MAX_AGE` too (`manager.py:187, 200`) — the
periodic (non-`log`) history snapshot also fires at most every 15 min ([§3.5](#35-what-log-does)).

**JS contract:** expose a `maxAge` on tag writes. Default to 900 s. If you implement
`dv-ui-sub` presence, drop to 3 s while `is_app_open`. If you don't, pick a sane fixed
value (900 s is the safe default; a lower fixed value trades cloud traffic for
responsiveness).

---

## 6. Subscriptions & change detection

### 6.1 The two inbound events

The manager registers callbacks on `tag_values` at setup (`manager.py:213-234`):

| Event | Flag | Handler | Fires callbacks? |
|-------|------|---------|------------------|
| Channel sync (initial aggregate on subscribe) | `channel_sync` | `_on_tag_sync` (`manager.py:326-327`) | **No** — only seeds `_tag_values`. |
| Aggregate update (a change arrived) | `aggregate_update` | `_on_tag_update` (`manager.py:329-332`) | **Yes** — diffs and dispatches. |

`ChannelSyncEvent` is emitted once, right after the transport fetches the initial
aggregate on subscription (`events.py:156-165`; dispatched in
`device_agent.py:254-265`). It is how a subscriber gets boot state, but note it does
**not** trigger tag callbacks — see [§6.3](#63-initial-value-behaviour).

`AggregateUpdateEvent` (`events.py:114-153`) carries **`aggregate`** (the *full*
merged aggregate after the update) and **`request_data`** (the diff that was just
applied). The manager uses **`aggregate`**, not `request_data`.

### 6.2 How change detection works

`_on_tag_update` (`manager.py:329-332`):

```python
diff = generate_diff(self._tag_values, event.aggregate.data, do_delete=False)
self._tag_values = event.aggregate.data or {}
await self.fulfill_tag_subscriptions(diff)
```

So the manager **recomputes the diff itself** by comparing its cached aggregate to
the new full aggregate (`generate_diff`, `diff.py:51-72`) — it does *not* trust
`event.request_data`. Then `fulfill_tag_subscriptions` (`manager.py:334-349`): for
each subscribed `KeyPath`, if that path is present in the computed diff
(`k.in_dict(diff)`), invoke its callback with `(k.key, k.lookup_dict(diff))` — i.e.
the **original key** the caller subscribed with, and the **new value at that path**.
Each callback is wrapped with a **1-second timeout** and exceptions are swallowed and
logged (`manager.py:339-349`).

Two important properties of `generate_diff(..., do_delete=False)` (`diff.py:51-72`):

1. **Only changed/added leaves appear in the diff.** An unchanged tag does not fire
   its callback.
2. **`do_delete=False` means deletions are NOT surfaced.** If a key disappears from
   the new aggregate, `generate_diff` with `do_delete=False` will not emit a
   `key: null` entry (the `do_delete` branch at `diff.py:69-71` is skipped). So a
   subscriber is **not notified when a tag is deleted upstream** via the aggregate
   diff path. (Deletes still update `_tag_values` because the whole aggregate is
   replaced.) Mirror this behaviour, or consciously improve on it — but know it's the
   pydoover baseline.

### 6.3 Initial-value behaviour

**A subscription never fires for the value that existed at subscribe time.** Sync
seeds the cache silently; only subsequent `aggregate_update`s that actually change
the subscribed path fire the callback. The PLAN's "emit current value on
deploy/connect" option (PLAN §3.1) is therefore **not** a subscription feature — the
node must implement it by explicitly calling `get_tag`/reading the aggregate after
sync and emitting once, then letting change events drive subsequent emits.

### 6.4 Reading a tag: `get_tag`

`get_tag(key, default=None, app_key=None, raise_key_error=False)`
(`manager.py:370-390`) reads from **cache + unflushed pending writes**:

```python
current_values = apply_diff(self._tag_values, self._pending_tag_aggregate, do_delete=False)
if not key_path.in_dict(current_values):
    return default            # (or raise KeyError if raise_key_error)
return key_path.lookup_dict(current_values)
```

So a read reflects writes made this loop before they've been flushed. Our
`getAggregate`-backed tag read should likewise overlay any locally-buffered pending
writes on top of the last-known aggregate.

### 6.5 The one-callback-per-tag footgun — our JS layer MUST multiplex

```python
def subscribe_to_tag(self, key, callback, app_key=None):
    key_path = KeyPath(key, app_key=app_key)
    self._tag_subscriptions[key_path] = callback     # manager.py:359-360
```

`_tag_subscriptions` is a **dict keyed by `KeyPath`, one callback per path**. A second
`subscribe_to_tag` for the same path **silently replaces** the first — the earlier
callback is lost with no error or warning. `unsubscribe_from_tag`
(`manager.py:362-368`) deletes the single entry. `KeyPath.__eq__`/`__hash__` mean
`"temperature"` and `["temperature"]` (same app) collide as the same key.

This is the footgun the PLAN calls out (PLAN §2.1, §3.1). In Node-RED, many nodes
(and many deploys of the same node) will subscribe to the same tag. **Our tag layer
must maintain a list/Set of callbacks per path and fan out to all of them**, so N
`doover tag in` nodes on the same tag all fire. Concretely:

- Registry: `Map<pathKey, Set<callback>>` where `pathKey` is a stable string
  (e.g. `path.join(" ")`; **do not** reuse pydoover's destructive `KeyPath`
  equality — [§2.4](#24-equalityhashing-caveats-relevant-if-you-mirror-the-dict-keyed-subscription-map)).
- Subscribe to the underlying `tag_values` channel **once** per transport; on each
  aggregate update, diff against the cached aggregate exactly as
  [§6.2](#62-how-change-detection-works) does, then for each changed path notify every
  callback registered under that path (and, per Doover semantics, any callback whose
  subscribed path is a **prefix** of a changed leaf — decide and document your
  nesting granularity; pydoover matches on `in_dict`, i.e. the subscribed path exists
  in the diff, which covers a subscribed parent object when any child changed).
- Unsubscribe removes one callback from the Set; only tear down the channel
  subscription when the Set for every path is empty.

---

## 7. Type conventions and defaults

### 7.1 Declared types

Tag types are plain strings on the declaration (`__init__.py`):

- Numeric family: `"number"`, `"integer"`, `"float"`
  (`_NUMERIC_TAG_TYPES`, `__init__.py:397`).
- State family: `"boolean"`, `"string"` (`_STATE_TAG_TYPES`, `__init__.py:398`).
- The app template additionally documents `"array"` and `"object"` as valid tag
  types (repo `CLAUDE.md`, "Tags" section) for structured values.

Typed declaration classes: `Number`, `Boolean`, `String` (`__init__.py:433-521`),
plus `RemoteTag` (`__init__.py:551-638`, a tag that resolves to another app's tag).
`RemoteTag` cross-**agent** references are accepted in schema but raise
`NotImplementedError` at runtime (`__init__.py:633-637`) — out of scope for v1.

### 7.2 Coercion (JSON int/float ambiguity)

`_coerce_tag_value(value, tag_type)` (`__init__.py:11-25`) is applied on **read**
(`__init__.py:1053-1058`):

- `None` / unset → returned as-is.
- `tag_type == "integer"` and value is a `float` that `is_integer()` → cast to `int`.
  (JSON/channels don't distinguish `2` from `2.0`.)
- `tag_type == "boolean"` and value not already `bool` → `bool(value)`.
- Otherwise value passes through unchanged (numbers/strings not otherwise coerced).

**JS contract:** the equivalent coercions matter because JSON round-trips lose the
int/float distinction. For `"integer"` tags, floor/verify integrality; for
`"boolean"` tags, coerce truthiness to a real boolean. The PLAN's "configurable strict
mode that errors instead of coercing" (PLAN §3.1) is our addition — default to
predictable coercion, offer strict as an option.

### 7.3 Defaults and the `NotSet` sentinel

- Unset default is the sentinel `NotSet` (`__init__.py:7-8`), distinct from `None`.
- `get_tag`'s `default` is what a read returns when the path is absent
  (`manager.py:388-389`); the declarative layer passes the tag's declared `default`
  through as that default (`__init__.py:1053-1057`).
- `tag.is_set()` is "value is not `NotSet`" (`__init__.py:716-718`); `tag.clear()`
  resets to the declared default (`__init__.py:712-714`); `tag.delete()` sends `null`
  ([§3.4](#34-deletes-and-null-the-do_delete-false-discipline)).
- `Tag.to_dict()` schema form (`__init__.py:64-71`): `{"type": <tag_type>}`, plus
  `"default"` if one was declared, plus `"live": true` if declared live.

**JS contract:** distinguish "no value stored" (→ return configured default / a
`NotSet`-like sentinel) from "stored value is `null`" (an explicit clear). Don't
conflate them, or `delete` and "never set" become indistinguishable to downstream
nodes.

---

## 8. The diff engine (exact semantics to reproduce)

`pydoover/utils/diff.py`. Both functions are recursive over nested dicts and are the
backbone of change detection and aggregate merging.

**`apply_diff(data, diff, do_delete=True, clone=True)`** (`diff.py:14-48`):

- If `clone` (default), deep-copies `data` first; pass `clone=False` to mutate in
  place (the manager uses `clone=False` on its pending buffers for speed).
- If either arg isn't a dict, returns `diff` (the diff replaces the value).
- For each `k, v` in `diff`: if `v` is a dict, recurse into `data[k]` (default `{}`);
  if `v is None`, **delete** `data[k]` when `do_delete` else **set** `data[k] = None`;
  otherwise `data[k] = v`.

**`generate_diff(old, new, do_delete=True)`** (`diff.py:51-72`):

- If either isn't a dict, returns `new`.
- For each `k, v` in `new`: nested dicts recurse (only included if the sub-diff is
  non-empty); scalars included when `k` is new or `old[k] != v`.
- Keys in `old` but not `new`: emitted as `k: None` **only if `do_delete`** — the tag
  paths all call with `do_delete=False`, so deletions are not surfaced
  ([§6.2](#62-how-change-detection-works)).

**JS contract:** implement both with identical semantics, including the
`do_delete` switch — the manager's correctness (null-as-clear on writes, no
delete-notify on reads) depends on which value it passes.

---

## 9. End-to-end summary for the JS tag layer

A device-side (LocalTransport) tag layer built on `DooverTransport` needs exactly
this, all against the single channel **`tag_values`**:

1. **Subscribe once** to `tag_values`. Keep a cached aggregate (`Aggregate.data`).
   Seed it from the initial sync (no callbacks fired). On each aggregate update,
   `generate_diff(cache, newAggregate, do_delete=false)`, replace the cache, and fan
   out changed paths to a **multiplexed** registry (`Map<pathKey, Set<cb>>`).
2. **Read** = overlay pending writes on the cache, then `lookup_dict(path)`; return
   the configured default when absent.
3. **Write** = `construct_dict(path, value)` → merge into a pending buffer
   (`apply_diff(..., do_delete=false)`), coalesce per tick, flush via
   **`UpdateAggregate`** (partial payload, merge, `max_age_secs`). Skip no-op writes
   (only_if_changed). `null` at a leaf = delete (retain it locally, transmit it).
4. **log/recordLog** = additionally emit a persisted **`CreateMessage`** on
   `tag_values`.
5. **live** = timer-driven **`SendOneShotMessage`** of current values on
   `tag_values` (rate-limited; optionally presence-gated via `dv-ui-sub`).
6. **Namespacing** = `app_key` is the leading path segment; `app_key=None` → root
   (= the global namespace, no magic string). Reject `.` in individual segments;
   split dotted user input into an array.
7. **max_age** = 900 s default; 3 s when the app is observed (optional, needs
   `dv-ui-sub`).
8. **Types** = coerce `integer` floats-with-no-fraction to int and `boolean`
   non-bools to bool on read; distinguish "unset" from `null`.

Everything else pydoover's `Tags`/`Tag` classes do (declarative descriptors, log-on
triggers, RemoteTag resolution) is **above** the transport and is our node/config
layer's concern, not the transport's.

---

## 10. The processor variant (do NOT copy this one)

For completeness: `TagsManagerProcessor` (`manager.py:584-682`) is the cloud-processor
tag manager and has a **different, flatter storage model**:

- Storage is strictly two levels: `self._tag_values[app_key][key]`
  (`get_tag` at `manager.py:603-617`, `set_tag` at `manager.py:619-652`). **No
  `KeyPath`, no nesting, no dotted/array paths.**
- `app_key` defaults to the processor's own `app_key` (`manager.py:611, 633`).
- Writes are buffered in-memory and flushed by `commit_tags` (`manager.py:654-681`)
  via `update_channel_aggregate(TAG_CHANNEL_NAME, update)` — but the payload is the
  `{app_key: {...}}` map, external-app namespaces are only published when explicitly
  requested (`_update_external_tags`, `manager.py:651-669`), and `record_log`/`log`
  optionally also `create_message`.

Our JS layer targets the **docker/device model** (`TagsManagerDocker`), which supports
nested paths and the global root namespace. Treat this section as a warning: if you
ever read processor-produced aggregates, they are still just `{app_key: {tag: value}}`
under the same `tag_values` channel, so they interoperate — but the *manager
behaviour* to reproduce is the docker one.

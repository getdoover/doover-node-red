"""Differential-fuzzing Python driver.

Reads one JSON case per line on stdin, runs the *pydoover* reference
implementation for the requested target, and writes one JSON result per line on
stdout. pydoover is the contract: whatever this driver emits is ground truth.

Run (from anywhere) via:
    uv run --project /Users/tomwyatt/pydoover python py-driver.py

Case  line: {"id": <int>, "target": <str>, "args": {...}}
Result line: {"id": <int>, "ok": true, "result": <value>}
          or {"id": <int>, "ok": false, "error": <str>}

Result-value normalisation (kept minimal so no real divergence is hidden):
  * lookup_dict "not found" and "found None" both collapse to null on this side
    anyway (Python cannot distinguish them); run.js normalises JS `undefined`
    to null to match, so only genuine value differences surface.
"""

import sys
import json

from pydoover.utils.diff import apply_diff, generate_diff
from pydoover.tags.manager import KeyPath


def handle(target: str, args: dict):
    if target == "generateDiff":
        return generate_diff(args["old"], args["new"], do_delete=bool(args["doDelete"]))

    if target == "applyDiff":
        # clone defaults True (matches JS applyDiff default) — do not mutate the
        # input, return a fresh merged object.
        return apply_diff(
            args["data"], args["diff"], do_delete=bool(args["doDelete"]), clone=True
        )

    if target == "constructDict":
        return KeyPath(list(args["path"])).construct_dict(args["value"])

    if target == "lookupDict":
        return KeyPath(list(args["path"])).lookup_dict(args["obj"])

    if target == "inDict":
        return KeyPath(list(args["path"])).in_dict(args["obj"])

    if target == "setTagPayload":
        # Mirror TagsManagerDocker.set_tag -> set_tags(only_if_changed) shape:
        #   tags    = KeyPath(key, app_key).construct_dict(value)
        #   current = apply_diff(tag_values, pending_aggregate={}, do_delete=False)
        #   send    = generate_diff(current, tags, do_delete=False)
        app_key = args["appKey"]
        kp = KeyPath(list(args["key"]), app_key=app_key)
        tags = kp.construct_dict(args["value"])
        current = apply_diff(args["current"], {}, do_delete=False)
        return generate_diff(current, tags, do_delete=False)

    raise ValueError(f"unknown target: {target}")


def main() -> None:
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        case = json.loads(line)
        cid = case.get("id")
        try:
            result = handle(case["target"], case["args"])
            out.write(
                json.dumps(
                    {"id": cid, "ok": True, "result": result},
                    ensure_ascii=True,
                    allow_nan=False,
                )
            )
        except Exception as exc:  # noqa: BLE001 - report, don't crash the stream
            out.write(
                json.dumps({"id": cid, "ok": False, "error": f"{type(exc).__name__}: {exc}"})
            )
        out.write("\n")
        out.flush()


if __name__ == "__main__":
    main()

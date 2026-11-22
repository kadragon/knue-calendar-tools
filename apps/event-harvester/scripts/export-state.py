#!/usr/bin/env python3
"""Export the legacy harvester's SQLite state for a Durable Object import."""

import argparse
from contextlib import closing
import json
from pathlib import Path
import re
import sqlite3


LEGACY_FEED = "bbs28"
WATERMARK = "_max_processed_id"
FAILURE_PREFIX = "_item_failure_count:"


def non_negative_integer(value):
    match = re.match(r"^\s*\+?([0-9]+)", value)
    if not match:
        return 0
    digits = match[1].lstrip("0")
    if len(digits) > 16:
        return 0
    number = int(digits or "0")
    return number if number <= 9007199254740991 else 0


def read_snapshot(path):
    with closing(sqlite3.connect(path.resolve(strict=True).as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("BEGIN")
        rows = db.execute(
            "SELECT ntt_no, event_id, processed_at, hash FROM processed_items"
        ).fetchall()
        meta = dict(db.execute("SELECT key, value FROM meta"))

    records = {}
    for key, event_id, processed_at, digest in rows:
        feed, separator, item = key.partition(":")
        if not separator:
            feed, item = LEGACY_FEED, key
        record = {
            "feedId": feed,
            "nttNo": item,
            "eventId": event_id,
            "processedAt": processed_at,
            "hash": digest,
        }
        if separator:
            records[(feed, item)] = record
        else:
            records.setdefault((feed, item), record)

    watermarks = {
        key.removeprefix(WATERMARK + ":"): non_negative_integer(value)
        for key, value in meta.items()
        if key.startswith(WATERMARK + ":")
    }
    if WATERMARK in meta:
        watermarks.setdefault(LEGACY_FEED, non_negative_integer(meta[WATERMARK]))

    failures = []
    for key, value in sorted(meta.items()):
        if key.startswith(FAILURE_PREFIX):
            feed, separator, item = key.removeprefix(FAILURE_PREFIX).partition(":")
            count = non_negative_integer(value)
            if separator and count:
                failures.append({"feedId": feed, "nttNo": item, "count": count})

    return {
        "version": 1,
        "records": [records[key] for key in sorted(records)],
        "watermarks": [{"feedId": feed, "id": value} for feed, value in sorted(watermarks.items())],
        "failures": failures,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path)
    args = parser.parse_args()
    try:
        snapshot = read_snapshot(args.database)
    except (OSError, sqlite3.Error) as error:
        parser.exit(1, f"Cannot export harvester state: {error}\n")
    print(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()

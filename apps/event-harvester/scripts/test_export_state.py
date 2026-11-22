import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


class ExportStateTest(unittest.TestCase):
    def test_exports_normalized_sqlite_state_and_leaves_source_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "state.db"
            with sqlite3.connect(source) as database:
                database.executescript("""
                    CREATE TABLE processed_items (
                        ntt_no TEXT PRIMARY KEY, event_id TEXT,
                        processed_at TEXT, hash TEXT
                    );
                    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
                    INSERT INTO processed_items VALUES
                        ('123', 'legacy', '2026-01-01', 'old'),
                        ('456', 'legacy-only', '2026-01-01', 'legacy-hash'),
                        ('bbs28:123', 'current', '2026-01-02', 'current-hash'),
                        ('bbs50:123', '', '2026-01-03', '');
                    INSERT INTO meta VALUES
                        ('_max_processed_id', '123'),
                        ('_max_processed_id:bbs28', '456'),
                        ('_max_processed_id:bbs50', '234'),
                        ('_item_failure_count:bbs28:987', '2'),
                        ('_item_failure_count:bbs50:bad', 'invalid'),
                        ('unrelated', 'value');
                """)
            before = source.read_bytes()
            result = subprocess.check_output([
                sys.executable, str(Path(__file__).with_name("export-state.py")), str(source)
            ])
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(json.loads(result), {
                "version": 1,
                "records": [
                    {"feedId": "bbs28", "nttNo": "123", "eventId": "current",
                     "processedAt": "2026-01-02", "hash": "current-hash"},
                    {"feedId": "bbs28", "nttNo": "456", "eventId": "legacy-only",
                     "processedAt": "2026-01-01", "hash": "legacy-hash"},
                    {"feedId": "bbs50", "nttNo": "123", "eventId": "",
                     "processedAt": "2026-01-03", "hash": ""},
                ],
                "watermarks": [{"feedId": "bbs28", "id": 456}, {"feedId": "bbs50", "id": 234}],
                "failures": [{"feedId": "bbs28", "nttNo": "987", "count": 2}],
            })

    def test_falls_back_to_legacy_watermark(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "state.db"
            with sqlite3.connect(source) as database:
                database.executescript("""
                    CREATE TABLE processed_items
                      (ntt_no TEXT PRIMARY KEY, event_id TEXT, processed_at TEXT, hash TEXT);
                    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
                    INSERT INTO meta VALUES ('_max_processed_id', '123');
                """)
            result = subprocess.check_output([
                sys.executable, str(Path(__file__).with_name("export-state.py")), str(source)
            ])
            self.assertEqual(json.loads(result)["watermarks"], [{"feedId": "bbs28", "id": 123}])


if __name__ == "__main__":
    unittest.main()

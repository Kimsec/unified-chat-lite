from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path

logger = logging.getLogger(__name__)

SAVE_INTERVAL_SECONDS = 60


class Stats:
    def __init__(self):
        configured = os.getenv("STATS_FILE")
        if configured:
            self.path = Path(configured)
        else:
            data_dir = Path(__file__).resolve().parent.parent / "data"
            self.path = data_dir / "stats.json" if data_dir.is_dir() else None
        self.active_viewers = 0
        self.total_connections = 0
        self.peak_viewers = 0
        self.since = int(time.time() * 1000)
        self._started = time.monotonic()
        self._dirty = False
        self._load()

    def _load(self) -> None:
        if self.path is None:
            return
        try:
            data = json.loads(self.path.read_text())
            self.total_connections = int(data.get("total_connections") or 0)
            self.peak_viewers = int(data.get("peak_viewers") or 0)
            self.since = int(data.get("since") or self.since)
        except FileNotFoundError:
            pass
        except Exception as exc:
            logger.warning("stats load failed: %s", exc)

    def connection_opened(self) -> None:
        self.active_viewers += 1
        self.total_connections += 1
        self.peak_viewers = max(self.peak_viewers, self.active_viewers)
        self._dirty = True

    def connection_closed(self) -> None:
        self.active_viewers = max(self.active_viewers - 1, 0)

    def snapshot(self, channel_count: int) -> dict:
        return {
            "viewers": self.active_viewers,
            "channels": channel_count,
            "uptime_seconds": int(time.monotonic() - self._started),
            "total_connections": self.total_connections,
            "peak_viewers": self.peak_viewers,
            "since": self.since,
        }

    def save(self) -> None:
        if self.path is None or not self._dirty:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps({
                "total_connections": self.total_connections,
                "peak_viewers": self.peak_viewers,
                "since": self.since,
            }))
            self._dirty = False
        except Exception as exc:
            logger.debug("stats save skipped: %s", exc)

    async def autosave(self) -> None:
        while True:
            await asyncio.sleep(SAVE_INTERVAL_SECONDS)
            self.save()

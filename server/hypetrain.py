"""Hype train status via anonymous Twitch GQL polling (EventSub needs OAuth)."""
from __future__ import annotations

import asyncio
import logging

from curl_cffi.requests import AsyncSession

logger = logging.getLogger(__name__)

GQL_URL = "https://gql.twitch.tv/gql"
GQL_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"
IDLE_POLL_SECONDS = 60
ACTIVE_POLL_SECONDS = 15
MAX_BACKOFF_SECONDS = 600
HIDE_AFTER_MS = 5000

QUERY = """
query($login: String) {
  user(login: $login) {
    channel {
      hypeTrain {
        execution {
          isActive
          progress { goal progression level { value } }
        }
      }
    }
  }
}
"""


class HypeTrainPoller:
    """Fully firewalled: any failure logs and backs off, nothing else is affected."""

    def __init__(self, hub):
        self.hub = hub
        self.tasks: dict[str, asyncio.Task] = {}

    def start(self, channel: str) -> None:
        if channel not in self.tasks or self.tasks[channel].done():
            self.tasks[channel] = asyncio.create_task(self._run(channel))

    def stop(self, channel: str) -> None:
        task = self.tasks.pop(channel, None)
        if task is not None:
            task.cancel()

    async def _run(self, channel: str) -> None:
        last_sent: dict | None = None
        delay = IDLE_POLL_SECONDS
        while True:
            try:
                train = await self._fetch(channel)
                if train is not None:
                    delay = ACTIVE_POLL_SECONDS
                    if train != last_sent:
                        last_sent = train
                        await self.hub.publish_hype_train(channel, {"phase": "progress", **train})
                else:
                    delay = IDLE_POLL_SECONDS
                    if last_sent is not None:
                        await self.hub.publish_hype_train(
                            channel, {"phase": "end", **last_sent, "hide_after_ms": HIDE_AFTER_MS}
                        )
                        last_sent = None
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("hype train poll failed for %s: %s", channel, exc)
                delay = min(max(delay, IDLE_POLL_SECONDS) * 2, MAX_BACKOFF_SECONDS)
            await asyncio.sleep(delay)

    async def _fetch(self, channel: str) -> dict | None:
        async with AsyncSession(impersonate="chrome") as session:
            response = await session.post(
                GQL_URL,
                json={"query": QUERY, "variables": {"login": channel}},
                headers={"Client-ID": GQL_CLIENT_ID},
                timeout=15,
            )
            data = response.json()
        channel_data = ((data.get("data") or {}).get("user") or {}).get("channel")
        if not isinstance(channel_data, dict) or "hypeTrain" not in channel_data:
            raise RuntimeError("unexpected GQL response shape")
        execution = (channel_data.get("hypeTrain") or {}).get("execution")
        if not execution or not execution.get("isActive"):
            return None
        progress = execution.get("progress") or {}
        return {
            "level": int((progress.get("level") or {}).get("value") or 1),
            "progress": int(progress.get("progression") or 0),
            "goal": int(progress.get("goal") or 0),
        }

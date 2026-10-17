"""Live viewer counts for the combined viewer badge.

Twitch and Kick are polled here for every channel someone is watching; YouTube
reads the count off the live page its connector already polls, and TikTok gets
it from the room's own event stream.
"""

from __future__ import annotations

import asyncio
import logging
import time

from curl_cffi.requests import AsyncSession

from .connectors.kick import fetch_channel as fetch_kick_channel
from .connectors.twitch import GQL_CLIENT_ID, GQL_URL

logger = logging.getLogger(__name__)

POLL_SECONDS = 45
TICK_SECONDS = 5  # how soon a newly watched channel gets its first count
MAX_CONCURRENT = 8
POLLED_PLATFORMS = ("twitch", "kick")


async def run(hub) -> None:
    last_polled: dict[tuple[str, str], float] = {}
    limit = asyncio.Semaphore(MAX_CONCURRENT)

    async def poll(key: tuple[str, str]) -> None:
        async with limit:
            try:
                count = await (_twitch_count if key[0] == "twitch" else _kick_count)(key[1])
            except Exception as exc:
                logger.warning("%s viewer count failed for %s: %s", key[0], key[1], exc)
                return
        await hub.publish_viewers(key[0], key[1], count)

    while True:
        now = time.monotonic()
        for key in [key for key in last_polled if key not in hub.channels]:
            del last_polled[key]
        due = [
            key for key in list(hub.channels)
            if key[0] in POLLED_PLATFORMS and now - last_polled.get(key, 0) >= POLL_SECONDS
        ]
        for key in due:
            last_polled[key] = now
        if due:
            await asyncio.gather(*(poll(key) for key in due))
        await asyncio.sleep(TICK_SECONDS)


async def _twitch_count(login: str) -> int | None:
    query = {
        "query": "query($login: String){user(login: $login){stream{viewersCount}}}",
        "variables": {"login": login},
    }
    async with AsyncSession(impersonate="chrome") as session:
        response = await session.post(
            GQL_URL, json=query, headers={"Client-ID": GQL_CLIENT_ID}, timeout=10
        )
    stream = (((response.json().get("data") or {}).get("user")) or {}).get("stream")
    return stream.get("viewersCount") if stream else None


async def _kick_count(slug: str) -> int | None:
    livestream = ((await fetch_kick_channel(slug)) or {}).get("livestream")
    return livestream.get("viewer_count") if livestream else None

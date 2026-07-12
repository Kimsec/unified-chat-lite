"""Third-party Twitch emotes (7TV, BTTV, FFZ) — public APIs, no keys.

Fetched once per channel and cached by the hub; the frontend does the
word-to-image matching, so the message pipeline stays untouched.
"""
from __future__ import annotations

import asyncio
import logging

from curl_cffi.requests import AsyncSession

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 15

_global_cache: dict[str, str] | None = None
_global_lock = asyncio.Lock()


async def fetch_channel_emotes(channel: str) -> dict[str, str]:
    """Return {emote_name: image_url} for a Twitch channel, globals included."""
    async with AsyncSession(impersonate="chrome") as session:
        emotes = dict(await _global_emotes(session))

        ffz = await _get_json(session, f"https://api.frankerfacez.com/v1/room/{channel}")
        twitch_id = (ffz.get("room") or {}).get("twitch_id") if ffz else None
        if ffz:
            emotes.update(_parse_ffz(ffz))
        if twitch_id:
            bttv = await _get_json(
                session, f"https://api.betterttv.net/3/cached/users/twitch/{twitch_id}"
            )
            if bttv:
                emotes.update(_parse_bttv((bttv.get("channelEmotes") or []) + (bttv.get("sharedEmotes") or [])))
            stv = await _get_json(session, f"https://7tv.io/v3/users/twitch/{twitch_id}")
            if stv:
                emotes.update(_parse_7tv((stv.get("emote_set") or {}).get("emotes") or []))
        return emotes


async def _global_emotes(session: AsyncSession) -> dict[str, str]:
    global _global_cache
    async with _global_lock:
        if _global_cache is None:
            emotes: dict[str, str] = {}
            ffz = await _get_json(session, "https://api.frankerfacez.com/v1/set/global")
            if ffz:
                emotes.update(_parse_ffz(ffz))
            bttv = await _get_json(session, "https://api.betterttv.net/3/cached/emotes/global")
            if isinstance(bttv, list):
                emotes.update(_parse_bttv(bttv))
            stv = await _get_json(session, "https://7tv.io/v3/emote-sets/global")
            if stv:
                emotes.update(_parse_7tv(stv.get("emotes") or []))
            _global_cache = emotes
        return _global_cache


async def _get_json(session: AsyncSession, url: str):
    try:
        response = await session.get(url, timeout=REQUEST_TIMEOUT)
        if response.status_code >= 400:
            return None
        return response.json()
    except Exception as exc:
        logger.warning("emote fetch failed for %s: %s", url, exc)
        return None


def _parse_ffz(data: dict) -> dict[str, str]:
    emotes: dict[str, str] = {}
    for emote_set in (data.get("sets") or {}).values():
        for emote in emote_set.get("emoticons") or []:
            name = emote.get("name")
            urls = emote.get("urls") or {}
            url = urls.get("2") or urls.get("1") or ""
            if url.startswith("//"):
                url = f"https:{url}"
            if name and url:
                emotes[name] = url
    return emotes


def _parse_bttv(items: list) -> dict[str, str]:
    return {
        item["code"]: f"https://cdn.betterttv.net/emote/{item['id']}/1x"
        for item in items
        if item.get("code") and item.get("id")
    }


def _parse_7tv(items: list) -> dict[str, str]:
    return {
        item["name"]: f"https://cdn.7tv.app/emote/{item['id']}/1x.webp"
        for item in items
        if item.get("name") and item.get("id")
    }

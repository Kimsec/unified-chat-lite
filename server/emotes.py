"""Third-party emotes (7TV, BTTV, FFZ) — public APIs, no keys.

Fetched once per channel and cached by the hub; the frontend does the
word-to-image matching, so the message pipeline stays untouched. Twitch
channels get all three sources; Kick channels get 7TV, the one service
with linked Kick accounts.
"""
from __future__ import annotations

import asyncio
import logging

from curl_cffi.requests import AsyncSession

from .connectors.kick import CHANNEL_API as KICK_CHANNEL_API
from .connectors.twitch import GQL_CLIENT_ID, GQL_URL

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 15

_twitch_global_cache: dict[str, str] | None = None
_stv_global_cache: dict[str, str] | None = None
_global_lock = asyncio.Lock()


async def fetch_channel_emotes(channel: str) -> dict[str, str]:
    """Return {emote_name: image_url} for a Twitch channel, globals included."""
    async with AsyncSession(impersonate="chrome") as session:
        emotes = dict(await _twitch_globals(session))

        twitch_id = await _twitch_user_id(session, channel)
        ffz = await _get_json(session, f"https://api.frankerfacez.com/v1/room/{channel}")
        if ffz:
            emotes.update(_parse_ffz(ffz))
            # Fallback id source for when the GQL lookup fails
            twitch_id = twitch_id or (ffz.get("room") or {}).get("twitch_id")
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


async def fetch_kick_emotes(slug: str) -> dict[str, str]:
    async with AsyncSession(impersonate="chrome") as session:
        emotes = dict(await _stv_globals(session))
        data = await _get_json(session, KICK_CHANNEL_API.format(slug=slug))
        user_id = (data or {}).get("user_id")
        if user_id:
            stv = await _get_json(session, f"https://7tv.io/v3/users/kick/{user_id}")
            if stv:
                emotes.update(_parse_7tv((stv.get("emote_set") or {}).get("emotes") or []))
        return emotes


async def _twitch_user_id(session: AsyncSession, login: str) -> int | None:
    query = {
        "query": "query($login: String){user(login: $login){id}}",
        "variables": {"login": login},
    }
    try:
        response = await session.post(
            GQL_URL, json=query, headers={"Client-ID": GQL_CLIENT_ID}, timeout=REQUEST_TIMEOUT
        )
        user = (response.json().get("data") or {}).get("user") or {}
        return int(user["id"]) if user.get("id") else None
    except Exception as exc:
        logger.warning("twitch id lookup failed for %s: %s", login, exc)
        return None


async def _twitch_globals(session: AsyncSession) -> dict[str, str]:
    global _twitch_global_cache
    async with _global_lock:
        if _twitch_global_cache is None:
            emotes: dict[str, str] = {}
            ffz = await _get_json(session, "https://api.frankerfacez.com/v1/set/global")
            if ffz:
                emotes.update(_parse_ffz(ffz))
            bttv = await _get_json(session, "https://api.betterttv.net/3/cached/emotes/global")
            if isinstance(bttv, list):
                emotes.update(_parse_bttv(bttv))
            emotes.update(await _fetch_stv_globals(session))
            _twitch_global_cache = emotes
        return _twitch_global_cache


async def _stv_globals(session: AsyncSession) -> dict[str, str]:
    async with _global_lock:
        return await _fetch_stv_globals(session)


async def _fetch_stv_globals(session: AsyncSession) -> dict[str, str]:
    """Only ever called with _global_lock held."""
    global _stv_global_cache
    if _stv_global_cache is None:
        stv = await _get_json(session, "https://7tv.io/v3/emote-sets/global")
        _stv_global_cache = _parse_7tv((stv or {}).get("emotes") or [])
    return _stv_global_cache


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

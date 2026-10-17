"""Live HLS playlist URLs for the native player (AirPlay, Chromecast, plain-HTTP hosts).

Only the playlist URL is resolved here; the browser or cast device fetches the
video straight from the platform's CDN, so no video passes through this server.
"""

from __future__ import annotations

import json
import logging
import random
import re
import time
from urllib.parse import urlencode

from curl_cffi.requests import AsyncSession

from .connectors.kick import fetch_channel as fetch_kick_channel
from .connectors.twitch import GQL_CLIENT_ID, GQL_URL
from .connectors.youtube import COOKIES as YOUTUBE_COOKIES

logger = logging.getLogger(__name__)

# YouTube's live page carries the HLS playlist; googlevideo locks it to the requesting
# IP, so it plays for viewers sharing the server's IP (self-hosting at home).
YOUTUBE_HLS_RE = re.compile(r'"hlsManifestUrl":("(?:[^"\\]|\\.)*")')

TWITCH_USHER_URL = "https://usher.ttvnw.net/api/channel/hls/{login}.m3u8"
# Twitch's persisted PlaybackAccessToken query (the same one Streamlink uses).
TWITCH_TOKEN_QUERY_HASH = "0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712"

CACHE_TTL = 60
CACHE_MAX = 500
_cache: dict[tuple[str, str], tuple[float, str | None]] = {}


async def stream_url(platform: str, channel: str) -> str | None:
    """Playlist URL for a live channel, None when offline/unknown. Cached briefly."""
    key = (platform, channel)
    cached = _cache.get(key)
    if cached and time.monotonic() - cached[0] < CACHE_TTL:
        return cached[1]
    resolver = {"twitch": _twitch_url, "kick": _kick_url, "youtube": _youtube_url}[platform]
    try:
        url = await resolver(channel)
    except Exception as exc:
        logger.warning("%s stream lookup failed for %s: %s", platform, channel, exc)
        return None
    if len(_cache) >= CACHE_MAX:
        _cache.clear()
    _cache[key] = (time.monotonic(), url)
    return url


async def _twitch_url(login: str) -> str | None:
    query = {
        "operationName": "PlaybackAccessToken",
        "extensions": {"persistedQuery": {"version": 1, "sha256Hash": TWITCH_TOKEN_QUERY_HASH}},
        "variables": {"isLive": True, "login": login, "isVod": False, "vodID": "", "playerType": "embed"},
    }
    async with AsyncSession(impersonate="chrome") as session:
        response = await session.post(
            GQL_URL, json=query, headers={"Client-ID": GQL_CLIENT_ID}, timeout=10
        )
    token = ((response.json().get("data") or {}).get("streamPlaybackAccessToken")) or {}
    if not token.get("value") or not token.get("signature"):
        return None
    params = {
        "client_id": GQL_CLIENT_ID,
        "token": token["value"],
        "sig": token["signature"],
        "allow_source": "true",
        "allow_audio_only": "true",
        "fast_bread": "true",
        "playlist_include_framerate": "true",
        "p": random.randint(0, 9_999_999),
    }
    return f"{TWITCH_USHER_URL.format(login=login)}?{urlencode(params)}"


async def _kick_url(slug: str) -> str | None:
    data = await fetch_kick_channel(slug) or {}
    if not data.get("livestream"):
        return None
    return data.get("playback_url") or None


async def _youtube_url(name: str) -> str | None:
    handle = name if name.startswith("@") else f"@{name}"
    async with AsyncSession(impersonate="chrome", cookies=YOUTUBE_COOKIES) as session:
        response = await session.get(f"https://www.youtube.com/{handle}/live", timeout=20)
    if response.status_code >= 400:
        return None
    match = YOUTUBE_HLS_RE.search(response.text)
    return json.loads(match.group(1)) if match else None

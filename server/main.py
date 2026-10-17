from __future__ import annotations

import asyncio
import logging
import os
import re
import secrets
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .connectors.kick import KickChat
from .connectors.tiktok import TikTokChat
from .connectors.twitch import TwitchChat
from .connectors.youtube import YouTubeChat
from . import airplay, streams, viewercounts
from .hub import Hub, Viewer
from .stats import Stats

logging.basicConfig(level=logging.WARNING)

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
SUPPORTED_PLATFORMS = ("twitch", "kick", "youtube", "tiktok")

# Names go straight into IRC commands and URLs, so reject anything outside
# each platform's own username charset.
CHANNEL_PATTERNS = {
    "twitch": re.compile(r"^[a-z0-9_]{1,25}$"),
    "kick": re.compile(r"^[a-z0-9_-]{1,50}$"),
    "youtube": re.compile(r"^@?[a-z0-9._-]{1,50}$"),
    "tiktok": re.compile(r"^@?[a-z0-9._]{1,50}$"),
}

# Site-wide announcement banner; in-memory on purpose — a restart clears it.
ANNOUNCE_TOKEN = os.getenv("ANNOUNCE_TOKEN", "")
ANNOUNCE_MAX_CHARS = 300
announcement = {"text": ""}
viewers: set[Viewer] = set()

app = FastAPI(title="Unified Chat Lite")

# Pages, scripts and styles must be re-checked on every load, or browsers keep
# running a stale app.js after an update; the ETag makes unchanged ones a 304.
NO_CACHE_SUFFIXES = (".html", ".js", ".css", ".json")


@app.middleware("http")
async def revalidate_app_files(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if (path.endswith("/") or path.endswith(NO_CACHE_SUFFIXES) or path in ("/popout", "/overlay")) and "cache-control" not in response.headers:
        response.headers["Cache-Control"] = "no-cache"
    return response
stats = Stats()
hub = Hub()
hub.register_connector("twitch", TwitchChat(hub))
hub.register_connector("kick", KickChat(hub))
hub.register_connector("youtube", YouTubeChat(hub))
hub.register_connector("tiktok", TikTokChat(hub))
airplay_chat = airplay.AirPlayChat(hub)


@app.on_event("startup")
async def start_stats_autosave() -> None:
    asyncio.create_task(stats.autosave())


@app.on_event("startup")
async def start_viewer_counts() -> None:
    asyncio.create_task(viewercounts.run(hub))
    asyncio.create_task(airplay_chat.reap())


@app.on_event("shutdown")
async def save_stats() -> None:
    stats.save()


@app.websocket("/ws")
async def viewer_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    viewer = Viewer(websocket)
    stats.connection_opened()
    viewers.add(viewer)
    if announcement["text"]:
        await viewer.send({"type": "announce", "text": announcement["text"]})
    try:
        while True:
            payload = await websocket.receive_json()
            if isinstance(payload, dict) and payload.get("type") == "subscribe":
                await handle_subscribe(viewer, payload.get("channels") or {})
    except WebSocketDisconnect:
        pass
    finally:
        viewers.discard(viewer)
        stats.connection_closed()
        await hub.drop_viewer(viewer)


async def handle_subscribe(viewer: Viewer, channels: dict) -> None:
    desired = set()
    for platform in SUPPORTED_PLATFORMS:
        channel = channels.get(platform)
        if not isinstance(channel, str):
            continue
        channel = channel.strip().lstrip("#").lower()
        if channel and CHANNEL_PATTERNS[platform].match(channel):
            desired.add((platform, channel))

    for key in viewer.keys - desired:
        await hub.unsubscribe(viewer, key)
    for platform, channel in desired - viewer.keys:
        await hub.subscribe(viewer, platform, channel)

    await viewer.send(hub.bootstrap_payload(viewer))


@app.get("/announcement")
async def get_announcement() -> dict:
    return {"text": announcement["text"]}


@app.post("/announce")
async def announce(request: Request) -> dict:
    if not ANNOUNCE_TOKEN:
        raise HTTPException(status_code=404)
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400)
    token = str(data.get("token") or "")
    if not secrets.compare_digest(token, ANNOUNCE_TOKEN):
        raise HTTPException(status_code=403)
    text = str(data.get("text") or "").strip()[:ANNOUNCE_MAX_CHARS]
    announcement["text"] = text
    await asyncio.gather(
        *(viewer.send({"type": "announce", "text": text}) for viewer in list(viewers))
    )
    return {"ok": True, "viewers": len(viewers)}


@app.get("/stream/{platform}/{channel}")
async def stream(platform: str, channel: str) -> dict:
    channel = channel.strip().lstrip("#").lower()
    if platform not in ("twitch", "kick", "youtube") or not CHANNEL_PATTERNS[platform].match(channel):
        raise HTTPException(status_code=404)
    url = await streams.stream_url(platform, channel)
    if not url:
        raise HTTPException(status_code=404, detail="offline")
    return {"url": url}


def _clean_channel(platform: str, channel: str) -> str | None:
    channel = channel.strip().lstrip("#").lower()
    pattern = CHANNEL_PATTERNS.get(platform)
    return channel if pattern and pattern.match(channel) else None


async def _airplay_session(platform: str, channel: str, chat: str) -> airplay.Session:
    """chat is "twitch:name+kick:name+…" — in the path so relative playlist URIs keep it."""
    video_channel = _clean_channel(platform, channel)
    if platform not in ("twitch", "kick", "youtube") or not video_channel:
        raise HTTPException(status_code=404)
    channels = {}
    for part in chat.split("+"):
        chat_platform, _, chat_channel = part.partition(":")
        cleaned = _clean_channel(chat_platform, chat_channel)
        if cleaned and chat_platform not in channels:
            channels[chat_platform] = cleaned
    return await airplay_chat.session(platform, video_channel, channels)


def _playlist_response(body: str | None, media_type: str) -> PlainTextResponse:
    if body is None:
        raise HTTPException(status_code=404)
    return PlainTextResponse(body, media_type=media_type, headers={"Cache-Control": "no-cache"})


@app.get("/airplay/{platform}/{channel}/{chat}/master.m3u8")
async def airplay_master(platform: str, channel: str, chat: str) -> PlainTextResponse:
    session = await _airplay_session(platform, channel, chat)
    return _playlist_response(await airplay_chat.master(session), airplay.PLAYLIST_TYPE)


@app.get("/airplay/{platform}/{channel}/{chat}/chat.m3u8")
async def airplay_chat_playlist(platform: str, channel: str, chat: str) -> PlainTextResponse:
    session = await _airplay_session(platform, channel, chat)
    return _playlist_response(await airplay_chat.chat_playlist(session), airplay.PLAYLIST_TYPE)


@app.get("/airplay/{platform}/{channel}/{chat}/chat/{sequence}.vtt")
async def airplay_chat_segment(platform: str, channel: str, chat: str, sequence: int) -> PlainTextResponse:
    session = await _airplay_session(platform, channel, chat)
    return _playlist_response(await airplay_chat.chat_segment(session, sequence), "text/vtt")


@app.post("/airplay/{platform}/{channel}/{chat}/filters")
async def airplay_filters(platform: str, channel: str, chat: str, request: Request) -> dict:
    """The phone's filter chips: platforms to leave out of the TV captions."""
    session = await _airplay_session(platform, channel, chat)
    try:
        hidden = (await request.json()).get("hidden") or []
    except Exception:
        raise HTTPException(status_code=400)
    session.hidden_platforms = {p for p in hidden if p in SUPPORTED_PLATFORMS}
    return {"hidden": sorted(session.hidden_platforms)}


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/stats")
async def stats_endpoint() -> dict:
    return stats.snapshot(len(hub.channels))


@app.get("/popout")
@app.get("/overlay")
async def popout_page() -> FileResponse:
    return FileResponse(WEB_DIR / "popout.html")


@app.get("/popout.html")
async def popout_legacy(request: Request) -> RedirectResponse:
    query = f"?{request.url.query}" if request.url.query else ""
    return RedirectResponse(f"/popout{query}", status_code=301)


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
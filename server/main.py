from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .connectors.kick import KickChat
from .connectors.tiktok import TikTokChat
from .connectors.twitch import TwitchChat
from .connectors.youtube import YouTubeChat
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

app = FastAPI(title="Unified Chat Lite")
stats = Stats()
hub = Hub()
hub.register_connector("twitch", TwitchChat(hub))
hub.register_connector("kick", KickChat(hub))
hub.register_connector("youtube", YouTubeChat(hub))
hub.register_connector("tiktok", TikTokChat(hub))


@app.on_event("startup")
async def start_stats_autosave() -> None:
    asyncio.create_task(stats.autosave())


@app.on_event("shutdown")
async def save_stats() -> None:
    stats.save()


@app.websocket("/ws")
async def viewer_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    viewer = Viewer(websocket)
    stats.connection_opened()
    try:
        while True:
            payload = await websocket.receive_json()
            if isinstance(payload, dict) and payload.get("type") == "subscribe":
                await handle_subscribe(viewer, payload.get("channels") or {})
    except WebSocketDisconnect:
        pass
    finally:
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
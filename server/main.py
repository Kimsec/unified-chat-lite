from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from .connectors.kick import KickChat
from .connectors.tiktok import TikTokChat
from .connectors.twitch import TwitchChat
from .connectors.youtube import YouTubeChat
from .hub import Hub, Viewer

logging.basicConfig(level=logging.INFO)

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
SUPPORTED_PLATFORMS = ("twitch", "kick", "youtube", "tiktok")

app = FastAPI(title="Unified Chat Lite")
hub = Hub()
hub.register_connector("twitch", TwitchChat(hub))
hub.register_connector("kick", KickChat(hub))
hub.register_connector("youtube", YouTubeChat(hub))
hub.register_connector("tiktok", TikTokChat(hub))


@app.websocket("/ws")
async def viewer_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    viewer = Viewer(websocket)
    try:
        while True:
            payload = await websocket.receive_json()
            if isinstance(payload, dict) and payload.get("type") == "subscribe":
                await handle_subscribe(viewer, payload.get("channels") or {})
    except WebSocketDisconnect:
        pass
    finally:
        await hub.drop_viewer(viewer)


async def handle_subscribe(viewer: Viewer, channels: dict) -> None:
    desired = set()
    for platform in SUPPORTED_PLATFORMS:
        channel = channels.get(platform)
        if isinstance(channel, str) and channel.strip():
            desired.add((platform, channel.strip().lstrip("#").lower()))

    for key in viewer.keys - desired:
        await hub.unsubscribe(viewer, key)
    for platform, channel in desired - viewer.keys:
        await hub.subscribe(viewer, platform, channel)

    await viewer.send(hub.bootstrap_payload(viewer))


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
"""Shared-connection hub.

The server keeps ONE upstream connection per unique (platform, channel) —
not per viewer. Ten viewers watching the same streamer share a single
upstream, and the hub fans every event out to all of them. Load grows with
the number of unique channels, not the number of users.
"""
from __future__ import annotations

import asyncio
from collections import deque
from typing import Protocol

from .models import Message

RECENT_LIMIT = 100
LINGER_SECONDS = 30


class Connector(Protocol):
    # Positional-only (/) so implementations may name the parameter to fit
    # their platform (channel/slug/name) and still satisfy the protocol.
    async def join(self, channel: str, /) -> None: ...
    async def part(self, channel: str, /) -> None: ...


class Viewer:
    """One frontend WebSocket client and the channel keys it subscribes to."""

    def __init__(self, websocket):
        self.websocket = websocket
        self.keys: set[tuple[str, str]] = set()

    async def send(self, payload: dict) -> None:
        try:
            await self.websocket.send_json(payload)
        except Exception:
            pass


class ChannelHandle:
    """Hub-side state for one unique (platform, channel)."""

    def __init__(self, key: tuple[str, str]):
        self.key = key
        self.viewers: set[Viewer] = set()
        self.recent: deque[Message] = deque(maxlen=RECENT_LIMIT)
        self.status = {
            "platform": key[0],
            "channel": key[1],
            "dot": "warn",
            "state": "connecting",
            "detail": "Starting…",
        }
        self.linger_task: asyncio.Task | None = None


class Hub:
    def __init__(self):
        self.channels: dict[tuple[str, str], ChannelHandle] = {}
        self.connectors: dict[str, Connector] = {}

    def register_connector(self, platform: str, connector: Connector) -> None:
        self.connectors[platform] = connector

    async def subscribe(self, viewer: Viewer, platform: str, channel: str) -> None:
        key = (platform, channel)
        handle = self.channels.get(key)
        created = False
        if handle is None:
            created = True
            handle = ChannelHandle(key)
            self.channels[key] = handle
        if handle.linger_task is not None:
            handle.linger_task.cancel()
            handle.linger_task = None
        handle.viewers.add(viewer)
        viewer.keys.add(key)
        if created:
            await self.connectors[platform].join(channel)

    async def unsubscribe(self, viewer: Viewer, key: tuple[str, str]) -> None:
        viewer.keys.discard(key)
        handle = self.channels.get(key)
        if handle is None:
            return
        handle.viewers.discard(viewer)
        if not handle.viewers and handle.linger_task is None:
            handle.linger_task = asyncio.create_task(self._linger(handle))

    async def drop_viewer(self, viewer: Viewer) -> None:
        for key in list(viewer.keys):
            await self.unsubscribe(viewer, key)

    async def _linger(self, handle: ChannelHandle) -> None:
        try:
            await asyncio.sleep(LINGER_SECONDS)
        except asyncio.CancelledError:
            return
        if handle.viewers:
            handle.linger_task = None
            return
        platform, channel = handle.key
        self.channels.pop(handle.key, None)
        await self.connectors[platform].part(channel)


    async def publish_message(self, message: Message) -> None:
        handle = self.channels.get((message.platform, message.channel))
        if handle is None:
            return
        handle.recent.append(message)
        await self._broadcast(handle, {"type": "message", "message": message.to_payload()})

    async def publish_deleted(
        self,
        platform: str,
        channel: str,
        *,
        message_id: str | None = None,
        author_login: str | None = None,
    ) -> None:
        """Single deleted message (message_id), ban/timeout (author_login),
        or full chat clear (neither)."""
        handle = self.channels.get((platform, channel))
        if handle is None:
            return
        ids = []
        for message in handle.recent:
            if message.deleted:
                continue
            if message_id is not None and message.id != message_id:
                continue
            if author_login is not None and message.author_login != author_login:
                continue
            message.deleted = True
            ids.append(message.id)
        if ids:
            await self._broadcast(handle, {"type": "deleted", "ids": ids})

    async def publish_status(
        self, platform: str, channel: str, dot: str, state: str, detail: str = ""
    ) -> None:
        handle = self.channels.get((platform, channel))
        if handle is None:
            return
        handle.status = {
            "platform": platform,
            "channel": channel,
            "dot": dot,
            "state": state,
            "detail": detail,
        }
        await self._broadcast(handle, {"type": "status", "status": handle.status})

    async def _broadcast(self, handle: ChannelHandle, payload: dict) -> None:
        await asyncio.gather(*(viewer.send(payload) for viewer in handle.viewers))


    def bootstrap_payload(self, viewer: Viewer) -> dict:
        messages: list[dict] = []
        statuses: list[dict] = []
        for key in viewer.keys:
            handle = self.channels.get(key)
            if handle is None:
                continue
            messages.extend(message.to_payload() for message in handle.recent)
            statuses.append(handle.status)
        messages.sort(key=lambda message: message["timestamp"])
        return {"type": "bootstrap", "messages": messages, "statuses": statuses}

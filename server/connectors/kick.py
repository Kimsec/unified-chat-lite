"""Anonymous Kick connector.

Kick chat rides on a public Pusher WebSocket that accepts subscriptions to
"chatrooms.<id>.v2" without any auth. Like the Twitch connector this holds ONE
Pusher socket for the whole process and subscribes/unsubscribes per chatroom.

The only awkward part is resolving channel slug → chatroom id: that endpoint
sits behind Cloudflare, which 403s plain HTTP clients, so the lookup uses
curl_cffi impersonating Chrome.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import re
import time
from datetime import datetime

import websockets
from curl_cffi.requests import AsyncSession

from ..models import Message

logger = logging.getLogger(__name__)

PUSHER_URL = (
    "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679"
    "?protocol=7&client=js&version=8.4.0-rc2&flash=false"
)
CHANNEL_API = "https://kick.com/api/v2/channels/{slug}"

CHAT_EVENT = "App\\Events\\ChatMessageEvent"
DELETED_EVENT = "App\\Events\\MessageDeletedEvent"
SUB_EVENT = "App\\Events\\SubscriptionEvent"
GIFT_EVENT = "App\\Events\\GiftedSubscriptionsEvent"
HOST_EVENT = "App\\Events\\StreamHostEvent"
CLEAR_EVENT = "App\\Events\\ChatroomClearEvent"

EMOTE_MARKER_RE = re.compile(r"\[emote:(\d+):([^\]]*)\]")


def parse_kick_emotes(content: str) -> tuple[str, list[dict]]:
    """Replace "[emote:id:name]" markers with the name and return
    (clean_text, emotes). Emote begin/end refer to the cleaned text, matching
    how Twitch emote fragments are recorded, so the frontend renders both
    identically."""
    emotes: list[dict] = []
    parts: list[str] = []
    cursor = 0
    length = 0
    for match in EMOTE_MARKER_RE.finditer(content):
        before = content[cursor:match.start()]
        parts.append(before)
        length += len(before)
        emote_id = match.group(1)
        name = match.group(2) or emote_id
        parts.append(name)
        emotes.append({"id": emote_id, "begin": length, "end": length + len(name), "text": name})
        length += len(name)
        cursor = match.end()
    parts.append(content[cursor:])
    return "".join(parts), emotes


def parse_timestamp(value: str) -> int:
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return int(time.time() * 1000)


class KickChat:
    platform = "kick"

    def __init__(self, hub):
        self.hub = hub
        self.rooms: dict[str, int] = {}  # slug -> chatroom id
        self.slugs: dict[int, str] = {}  # chatroom id -> slug
        self._ws = None
        self._task: asyncio.Task | None = None
        self._backoff = 1.0

    async def join(self, slug: str) -> None:
        await self.hub.publish_status(
            self.platform, slug, "warn", "connecting", f"Looking up {slug}…"
        )
        try:
            chatroom_id = await self._lookup_chatroom_id(slug)
        except Exception as exc:
            logger.warning("kick channel lookup failed for %s: %s", slug, exc)
            await self.hub.publish_status(
                self.platform, slug, "error", "error", f"Channel lookup failed: {exc}"
            )
            return
        if chatroom_id is None:
            await self.hub.publish_status(
                self.platform, slug, "error", "not found", f"No Kick channel named “{slug}”"
            )
            return

        self.rooms[slug] = chatroom_id
        self.slugs[chatroom_id] = slug
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())
        elif self._ws is not None:
            await self._subscribe(chatroom_id)

    async def part(self, slug: str) -> None:
        chatroom_id = self.rooms.pop(slug, None)
        if chatroom_id is None:
            return
        self.slugs.pop(chatroom_id, None)
        if self._ws is not None:
            await self._send({
                "event": "pusher:unsubscribe",
                "data": {"channel": f"chatrooms.{chatroom_id}.v2"},
            })

    async def _lookup_chatroom_id(self, slug: str) -> int | None:
        async with AsyncSession(impersonate="chrome") as session:
            response = await session.get(CHANNEL_API.format(slug=slug), timeout=20)
            if response.status_code == 404:
                return None
            if response.status_code >= 400:
                raise RuntimeError(f"kick.com returned {response.status_code}")
            data = response.json()
        return (data.get("chatroom") or {}).get("id")

    async def _send(self, payload: dict) -> None:
        try:
            await self._ws.send(json.dumps(payload))
        except Exception:
            pass  # the read loop notices the dead socket and reconnects

    async def _subscribe(self, chatroom_id: int) -> None:
        await self._send({
            "event": "pusher:subscribe",
            "data": {"auth": "", "channel": f"chatrooms.{chatroom_id}.v2"},
        })

    async def _run(self) -> None:
        while self.rooms:
            try:
                async with websockets.connect(PUSHER_URL) as ws:
                    self._ws = ws
                    for chatroom_id in list(self.rooms.values()):
                        await self._subscribe(chatroom_id)
                    self._backoff = 1.0
                    async for frame in ws:
                        await self._handle_frame(str(frame))
            except Exception as exc:
                logger.warning("kick pusher connection error: %s", exc)
            finally:
                self._ws = None
            if not self.rooms:
                break
            for slug in self.rooms:
                await self.hub.publish_status(
                    self.platform, slug, "error", "disconnected",
                    f"Reconnecting in {int(self._backoff)}s…",
                )
            await asyncio.sleep(self._backoff)
            self._backoff = min(self._backoff * 2, 30.0)

    async def _handle_frame(self, raw: str) -> None:
        try:
            frame = json.loads(raw)
        except json.JSONDecodeError:
            return
        event = frame.get("event") or ""

        if event == "pusher:ping":
            await self._send({"event": "pusher:pong", "data": "{}"})
            return

        match = re.match(r"chatrooms\.(\d+)\.", frame.get("channel") or "")
        slug = self.slugs.get(int(match.group(1))) if match else None
        if slug is None:
            return

        if event == "pusher_internal:subscription_succeeded":
            await self.hub.publish_status(
                self.platform, slug, "ok", "connected", f"Connected to {slug}"
            )
        elif event == CHAT_EVENT:
            try:
                data = json.loads(frame.get("data") or "{}")
            except json.JSONDecodeError:
                return
            await self._handle_chat(slug, data)
        elif event == DELETED_EVENT:
            try:
                data = json.loads(frame.get("data") or "{}")
            except json.JSONDecodeError:
                return
            message_id = (data.get("message") or {}).get("id")
            if message_id:
                await self.hub.publish_deleted(self.platform, slug, message_id=str(message_id))
        elif event == CLEAR_EVENT:
            await self.hub.publish_deleted(self.platform, slug)
        elif event in (SUB_EVENT, GIFT_EVENT, HOST_EVENT):
            try:
                data = json.loads(frame.get("data") or "{}")
            except json.JSONDecodeError:
                return
            await self._handle_system_event(slug, event, data)

    async def _handle_system_event(self, slug: str, event: str, data: dict) -> None:
        if event == SUB_EVENT:
            author = str(data.get("username") or "Someone")
            months = data.get("months")
            if isinstance(months, int) and months > 1:
                text = f"{author} subscribed! They've been subscribed for {months} months!"
            else:
                text = f"{author} subscribed!"
        elif event == GIFT_EVENT:
            author = str(data.get("gifter_username") or "Anonymous")
            count = max(len(data.get("gifted_usernames") or []), 1)
            plural = "subscription" if count == 1 else "subscriptions"
            text = f"{author} gifted {count} {plural}!"
        else:  # HOST_EVENT
            author = str(data.get("host_username") or "Someone")
            viewers = data.get("number_viewers")
            text = f"{author} is hosting with {viewers} viewers!" if viewers else f"{author} is hosting!"

        await self.hub.publish_message(Message(
            platform=self.platform,
            id=f"{time.time()}-{random.random()}",  # these events carry no id
            channel=slug,
            author=author,
            color="",
            badges=[],
            text=text,
            emotes=[],
            timestamp=int(time.time() * 1000),
            author_login=author.lower(),
            kind="system",
        ))

    async def _handle_chat(self, slug: str, data: dict) -> None:
        sender = data.get("sender") or {}
        identity = sender.get("identity") or {}
        content = str(data.get("content") or "")
        text, emotes = parse_kick_emotes(content)
        if not emotes:
            text = text.strip()
        if not text:
            return
        await self.hub.publish_message(Message(
            platform=self.platform,
            id=str(data.get("id") or f"{time.time()}-{random.random()}"),
            channel=slug,
            author=str(sender.get("username") or "Unknown"),
            color=str(identity.get("color") or ""),
            badges=[
                str(badge.get("type") or "")
                for badge in identity.get("badges") or []
                if isinstance(badge, dict)
            ],
            text=text,
            emotes=emotes,
            timestamp=parse_timestamp(str(data.get("created_at") or "")),
            author_login=str(sender.get("slug") or "").lower(),
        ))

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
        self.channel_ids: dict[str, int] = {}  # slug -> channel id
        self.channel_slugs: dict[int, str] = {}  # channel id -> slug
        self._ws = None
        self._task: asyncio.Task | None = None
        self._backoff = 1.0

    async def join(self, slug: str) -> None:
        await self.hub.publish_status(
            self.platform, slug, "warn", "connecting", f"Looking up {slug}…"
        )
        try:
            ids = await self._lookup_ids(slug)
        except Exception as exc:
            logger.warning("kick channel lookup failed for %s: %s", slug, exc)
            await self.hub.publish_status(
                self.platform, slug, "error", "error", f"Channel lookup failed: {exc}"
            )
            return
        if ids is None:
            await self.hub.publish_status(
                self.platform, slug, "error", "not found", f"No Kick channel named “{slug}”"
            )
            return

        chatroom_id, channel_id = ids
        self.rooms[slug] = chatroom_id
        self.slugs[chatroom_id] = slug
        if channel_id:
            self.channel_ids[slug] = channel_id
            self.channel_slugs[channel_id] = slug
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())
        elif self._ws is not None:
            await self._subscribe(slug)

    async def part(self, slug: str) -> None:
        chatroom_id = self.rooms.pop(slug, None)
        if chatroom_id is None:
            return
        self.slugs.pop(chatroom_id, None)
        channel_id = self.channel_ids.pop(slug, None)
        if channel_id:
            self.channel_slugs.pop(channel_id, None)
        if self._ws is not None:
            names = [f"chatrooms.{chatroom_id}.v2"]
            if channel_id:
                names += [f"channel.{channel_id}", f"channel_{channel_id}"]
            for name in names:
                await self._send({"event": "pusher:unsubscribe", "data": {"channel": name}})

    async def _lookup_ids(self, slug: str) -> tuple[int, int | None] | None:
        async with AsyncSession(impersonate="chrome") as session:
            response = await session.get(CHANNEL_API.format(slug=slug), timeout=20)
            if response.status_code == 404:
                return None
            if response.status_code >= 400:
                raise RuntimeError(f"kick.com returned {response.status_code}")
            data = response.json()
        chatroom_id = (data.get("chatroom") or {}).get("id")
        if chatroom_id is None:
            return None
        return chatroom_id, data.get("id")

    async def _send(self, payload: dict) -> None:
        try:
            await self._ws.send(json.dumps(payload))
        except Exception:
            pass  # the read loop notices the dead socket and reconnects

    async def _subscribe(self, slug: str) -> None:
        names = [f"chatrooms.{self.rooms[slug]}.v2"] if slug in self.rooms else []
        channel_id = self.channel_ids.get(slug)
        if channel_id:
            names += [f"channel.{channel_id}", f"channel_{channel_id}"]
        for name in names:
            await self._send({"event": "pusher:subscribe", "data": {"auth": "", "channel": name}})

    async def _run(self) -> None:
        while self.rooms:
            try:
                async with websockets.connect(PUSHER_URL) as ws:
                    self._ws = ws
                    for slug in list(self.rooms):
                        await self._subscribe(slug)
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

        channel_name = frame.get("channel") or ""
        match = re.match(r"chatrooms\.(\d+)\.", channel_name)
        slug = self.slugs.get(int(match.group(1))) if match else None
        if slug is None:
            alt = re.match(r"channel[._](\d+)$", channel_name)
            alt_slug = self.channel_slugs.get(int(alt.group(1))) if alt else None
            if alt_slug and event == "KicksGifted":
                try:
                    data = json.loads(frame.get("data") or "{}")
                except json.JSONDecodeError:
                    return
                await self._handle_kicks(alt_slug, data)
            elif alt_slug and not event.startswith("pusher"):
                logger.debug("kick channel event on %s: %s %s", alt_slug, event, str(frame.get("data"))[:500])
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
        elif event.startswith("App\\"):
            logger.debug("unhandled kick event on %s: %s %s", slug, event, str(frame.get("data"))[:500])

    async def _handle_kicks(self, slug: str, data: dict) -> None:
        sender = data.get("sender") or {}
        gift = data.get("gift") or {}
        author = str(sender.get("username") or "Someone")
        base = f"{author} sent {gift.get('name') or 'a gift'} ({gift.get('amount') or 0} Kicks)"
        user_msg = str(data.get("message") or "").strip()
        text = f"{base}: {user_msg}" if user_msg else f"{base}!"
        await self.hub.publish_message(Message(
            platform=self.platform,
            id=str(data.get("gift_transaction_id") or f"{time.time()}-{random.random()}"),
            channel=slug,
            author=author,
            color=str(sender.get("username_color") or ""),
            badges=[],
            text=text,
            emotes=[],
            timestamp=int(time.time() * 1000),
            author_login=author.lower(),
            kind="system",
        ))

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

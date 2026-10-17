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
import uuid
from datetime import datetime
from urllib.parse import urljoin

import websockets
from curl_cffi.requests import AsyncSession

from ..models import Message

logger = logging.getLogger(__name__)

PUSHER_URL = (
    "wss://ws-us2.pusher.com/app/34bf7a0ff419a2a775b9"
    "?protocol=7&client=js&version=8.4.0-rc2&flash=false"
)
PUSHER_QUERY = "?protocol=7&client=js&version=8.4.0-rc2&flash=false"
# Kick rotates its Pusher key/cluster (the socket then answers 4001, "app key not
# in this cluster"). The current one comes from Kick's realtime API, falling back
# to kick.com's web bundle and then to the old key on other clusters.
PUSHER_MISS_RETRY_SECONDS = 600
PUSHER_DISCOVERY_MAX_SCRIPTS = 120
SCRIPT_SRC_RE = re.compile(r'<script[^>]+src="([^"]+)"')
# Matches cluster:"us2", "cluster":"us2" and env-style PUSHER_APP_CLUSTER:"us2".
PUSHER_CLUSTER_RE = re.compile(r'cluster["\']?\s*[:=]\s*["\']([a-z]{2,4}\d?)["\']', re.I)
PUSHER_KEY_RE = re.compile(r'["\']([0-9a-f]{20})["\']')
PUSHER_WS_HOST_RE = re.compile(r'wsHost["\']?\s*[:=]\s*["\']([a-z0-9.-]+)["\']', re.I)
PUSHER_SOCKET_URL_RE = re.compile(r'wss://([a-z0-9.-]+)/app/([0-9a-f]{20})', re.I)
PUSHER_WINDOW = 600
# kick.com's env schema: NEXT_PUBLIC_X:o.z.string().optional().default("value")
ENV_DEFAULT_RE = re.compile(r'(NEXT_PUBLIC_[A-Z0-9_]+):[^,{}]{0,120}?\.default\(\s*"([^"]*)"\s*\)')
# Same key, other cluster: what 4001 "app key not in this cluster" can mean.
PUSHER_CLUSTERS = ("us2", "mt1", "us3", "eu", "ap1", "ap2", "ap3", "ap4", "sa1")
PUSHER_DEFAULT_KEY = "34bf7a0ff419a2a775b9"
# kick.com now hands out the chat socket's credentials per channel, the way its
# own chat does: POST this with the providers we accept, get {app_key, cluster}.
REALTIME_API_BASES = ("https://web.kick.com/api", "https://kick.com/api")
REALTIME_CHAT_CONNECTION = "/v1/realtime/channels/{channel_id}/chat/connection"
# v1 is the fallback when Cloudflare refuses v2 for this IP.
CHANNEL_APIS = (
    "https://kick.com/api/v2/channels/{slug}",
    "https://kick.com/api/v1/channels/{slug}",
)
CHANNEL_CACHE_SECONDS = 20
LOOKUP_RETRY_MAX_SECONDS = 120

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


_channel_cache: dict[str, tuple[float, dict | None]] = {}
_channel_locks: dict[str, asyncio.Lock] = {}


async def fetch_channel(slug: str) -> dict | None:
    """Kick channel JSON, or None when there's no such channel.

    Shared by chat, viewer counts and the native player, and cached briefly
    so they don't triple the requests Kick's Cloudflare sees from this IP.
    """
    async with _channel_locks.setdefault(slug, asyncio.Lock()):
        cached = _channel_cache.get(slug)
        if cached and time.monotonic() - cached[0] < CHANNEL_CACHE_SECONDS:
            return cached[1]
        error: Exception = RuntimeError("kick.com lookup failed")
        async with AsyncSession(impersonate="chrome") as session:
            for url in CHANNEL_APIS:
                try:
                    response = await session.get(url.format(slug=slug), timeout=20)
                except Exception as exc:
                    error = exc
                    continue
                if response.status_code == 404:
                    data = None
                    break
                if response.status_code >= 400:
                    error = RuntimeError(f"kick.com returned {response.status_code}")
                    continue
                try:
                    data = response.json()
                    break
                except ValueError:
                    error = RuntimeError("kick.com returned a challenge page")
            else:
                raise error
        _channel_cache[slug] = (time.monotonic(), data)
        return data


async def fetch_realtime_pusher_url(channel_id: int) -> str | None:
    """Pusher socket URL Kick assigns this channel's chat, or None."""
    body = {
        "client": {"id": str(uuid.uuid4()), "type": "web"},
        "capabilities": {"accepted_providers": [{"provider": "pusher"}]},
    }
    path = REALTIME_CHAT_CONNECTION.format(channel_id=channel_id)
    async with AsyncSession(impersonate="chrome") as session:
        for base in REALTIME_API_BASES:
            try:
                response = await session.post(
                    base + path, json=body, headers={"Accept": "application/json"}, timeout=20
                )
                data = response.json().get("data") if response.status_code < 400 else None
            except Exception as exc:
                logger.warning("kick realtime lookup failed at %s: %s", base, exc)
                continue
            if data is None:
                logger.warning("kick realtime lookup at %s returned %s", base, response.status_code)
                continue
            found = _find_pusher_credentials(data)
            if found:
                key, cluster, host = found
                return f"wss://{host or f'ws-{cluster}.pusher.com'}/app/{key}{PUSHER_QUERY}"
            logger.warning("kick realtime reply at %s has no pusher key: %s", base, json.dumps(data)[:400])
    return None


def _find_pusher_credentials(node) -> tuple[str, str, str | None] | None:
    """(key, cluster, host) from wherever Kick nests them in a realtime reply."""
    if isinstance(node, list):
        return next((found for item in node if (found := _find_pusher_credentials(item))), None)
    if not isinstance(node, dict):
        return None
    key = next((node[k] for k in ("app_key", "appKey", "key") if isinstance(node.get(k), str)), None)
    cluster = node.get("cluster")
    if key and re.fullmatch(r"[0-9a-f]{20}", key) and isinstance(cluster, str) and cluster:
        host = next((node[k] for k in ("host", "ws_host", "wsHost") if isinstance(node.get(k), str)), None)
        return key, cluster, re.sub(r"^\w+://", "", host).split("/")[0] if host else None
    return next((found for value in node.values() if (found := _find_pusher_credentials(value))), None)


def pusher_from_env(text: str) -> tuple[str, str, str | None] | None:
    """(key, cluster, host) from kick.com's NEXT_PUBLIC_PUSHER_* env defaults."""
    env = {name: value for name, value in ENV_DEFAULT_RE.findall(text) if "PUSHER" in name}
    key = next((v for n, v in env.items() if "KEY" in n and re.fullmatch(r"[0-9a-f]{20}", v)), None)
    if not key:
        return None
    cluster = next((v for n, v in env.items() if "CLUSTER" in n and v), "us2")
    host = next((v for n, v in env.items() if "HOST" in n and v), None)
    if host:
        host = re.sub(r"^\w+://", "", host).split("/")[0]
    return key, cluster, host


def find_pusher_config(text: str) -> tuple[str, str, str | None] | None:
    """(key, cluster, wsHost) from a Pusher client config in kick.com's JS."""
    from_env = pusher_from_env(text)
    if from_env:
        return from_env
    socket_url = PUSHER_SOCKET_URL_RE.search(text)
    if socket_url:
        return socket_url.group(2), "", socket_url.group(1)
    for cluster in PUSHER_CLUSTER_RE.finditer(text):
        window = text[max(0, cluster.start() - PUSHER_WINDOW):cluster.end() + PUSHER_WINDOW]
        key = PUSHER_KEY_RE.search(window)
        if key:
            host = PUSHER_WS_HOST_RE.search(window)
            return key.group(1), cluster.group(1), host.group(1) if host else None
    return None


async def discover_pusher_url() -> str | None:
    """Pusher socket URL from kick.com's current web bundle, or None."""
    async with AsyncSession(impersonate="chrome") as session:
        page = await session.get("https://kick.com/", timeout=20)
        if page.status_code >= 400:
            raise RuntimeError(f"kick.com returned {page.status_code}")
        texts = [page.text]
        scripts = [urljoin("https://kick.com/", src) for src in SCRIPT_SRC_RE.findall(page.text)]
        found = find_pusher_config(page.text)
        for src in scripts[:PUSHER_DISCOVERY_MAX_SCRIPTS]:
            if found:
                break
            try:
                response = await session.get(src, timeout=20)
            except Exception:
                continue
            if response.status_code < 400 and ("cluster" in response.text or "PUSHER" in response.text):
                found = find_pusher_config(response.text)
    if not found:
        return None
    key, cluster, host = found
    host = host or f"ws-{cluster.lower()}.pusher.com"
    return f"wss://{host}/app/{key}{PUSHER_QUERY}"


async def probe_pusher(url: str) -> str:
    """"ok", or Pusher's error for this socket URL."""
    try:
        async with websockets.connect(url, open_timeout=8) as ws:
            frame = json.loads(await asyncio.wait_for(ws.recv(), 8))
    except Exception as exc:
        return f"connect failed: {exc}"
    if frame.get("event") == "pusher:connection_established":
        return "ok"
    data = frame.get("data")
    return str(data if not isinstance(data, str) else data)[:160]


async def find_pusher_cluster(key: str = PUSHER_DEFAULT_KEY) -> str | None:
    """Socket URL of the first Pusher cluster that accepts the key, or None."""
    for cluster in PUSHER_CLUSTERS:
        url = f"wss://ws-{cluster}.pusher.com/app/{key}{PUSHER_QUERY}"
        if await probe_pusher(url) == "ok":
            return url
    return None


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
        self._lookups: dict[str, asyncio.Task] = {}  # slug -> lookup still retrying
        self._pusher_url = PUSHER_URL
        self._pusher_retry_at = 0.0  # after a failed lookup, when to try again
        # Look the socket up before the first connect; again whenever it refuses our key.
        self._pusher_rejected = True

    async def join(self, slug: str) -> None:
        await self.hub.publish_status(
            self.platform, slug, "warn", "connecting", f"Looking up {slug}…"
        )
        self._lookups[slug] = asyncio.create_task(self._join(slug))

    async def _join(self, slug: str) -> None:
        # A refused lookup (Cloudflare 403/429, challenge page) is usually
        # temporary, so keep retrying instead of leaving the chat dead.
        delay = 5.0
        while True:
            try:
                ids = await self._lookup_ids(slug)
                break
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("kick channel lookup failed for %s: %s", slug, exc)
                await self.hub.publish_status(
                    self.platform, slug, "error", "error",
                    f"Channel lookup failed: {exc} — retrying in {int(delay)}s",
                )
                await asyncio.sleep(delay)
                delay = min(delay * 2, LOOKUP_RETRY_MAX_SECONDS)
        self._lookups.pop(slug, None)
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
        lookup = self._lookups.pop(slug, None)
        if lookup is not None:
            lookup.cancel()
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
        data = await fetch_channel(slug)
        if data is None:
            return None
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

    async def _refresh_pusher_url(self) -> None:
        if time.monotonic() < self._pusher_retry_at:
            return
        url = None
        for channel_id in list(self.channel_ids.values())[:1]:
            url = await fetch_realtime_pusher_url(channel_id)
        if not url:
            try:
                url = await discover_pusher_url()
            except Exception as exc:
                logger.warning("kick pusher key discovery failed: %s", exc)
        if not url:
            url = await find_pusher_cluster()
        if url:
            self._pusher_retry_at = 0.0
            if url != self._pusher_url:
                logger.warning("kick pusher endpoint changed: %s", url)
            self._pusher_url = url
        else:
            # A miss is retried after 10 minutes rather than on every reconnect.
            self._pusher_retry_at = time.monotonic() + PUSHER_MISS_RETRY_SECONDS
            logger.warning("kick pusher endpoint not found; keeping %s", self._pusher_url)

    async def _run(self) -> None:
        while self.rooms:
            if self._pusher_rejected:
                self._pusher_rejected = False
                await self._refresh_pusher_url()
            try:
                async with websockets.connect(self._pusher_url) as ws:
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
        if event == "pusher:error":
            data = frame.get("data")
            if isinstance(data, str):
                try:
                    data = json.loads(data)
                except json.JSONDecodeError:
                    data = {}
            code = (data or {}).get("code")
            logger.warning("kick pusher error %s: %s", code, (data or {}).get("message"))
            # 4000-4099: the socket won't accept this app key/connection; reconnecting
            # with the same key is pointless, so look up Kick's current key first.
            if isinstance(code, int) and 4000 <= code < 4100:
                self._pusher_rejected = True
                for slug in self.rooms:
                    await self.hub.publish_status(
                        self.platform, slug, "error", "error",
                        f"Kick chat socket refused the key ({code}) — looking up the current one…",
                    )
                if self._ws is not None:
                    await self._ws.close()
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

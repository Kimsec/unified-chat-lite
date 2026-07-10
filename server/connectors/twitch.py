"""Anonymous Twitch IRC connector.

Read-only "justinfan<digits>" nick, no PASS, no account. Unlike the browser
POC this holds ONE IRC socket for the whole process and JOINs/PARTs channels
on demand — Twitch IRC happily multiplexes many channels per connection.
"""
from __future__ import annotations

import asyncio
import logging
import random
import re
import time

import websockets

from ..models import Message, prefix_text as _prefix_text

logger = logging.getLogger(__name__)

TWITCH_IRC_URL = "wss://irc-ws.chat.twitch.tv:443"

TAG_ESCAPES = {"\\:": ";", "\\s": " ", "\\\\": "\\", "\\r": "\r", "\\n": "\n"}
TAG_ESCAPE_RE = re.compile(r"\\[:s\\rn]")


def _unescape_tag(value: str) -> str:
    return TAG_ESCAPE_RE.sub(lambda m: TAG_ESCAPES.get(m.group(0), m.group(0)), value)


def parse_tags(raw: str) -> dict[str, str]:
    tags = {}
    for part in raw.split(";"):
        key, _, value = part.partition("=")
        tags[key] = _unescape_tag(value)
    return tags


def parse_line(line: str) -> dict | None:
    """IRC line: [@tags ][:prefix ]COMMAND [params][ :trailing]"""
    rest = line
    tags: dict[str, str] = {}
    prefix = None

    if rest.startswith("@"):
        raw_tags, sep, rest = rest[1:].partition(" ")
        if not sep:
            return None
        tags = parse_tags(raw_tags)
    if rest.startswith(":"):
        prefix, sep, rest = rest[1:].partition(" ")
        if not sep:
            return None

    trailing = None
    head, sep, tail = rest.partition(" :")
    if sep:
        trailing = tail
        rest = head

    parts = rest.split()
    if not parts:
        return None
    return {
        "tags": tags,
        "prefix": prefix,
        "command": parts[0],
        "params": parts[1:],
        "trailing": trailing,
    }


def parse_emotes(raw_tag: str, text: str) -> list[dict]:
    """emotes tag: "25:0-4,12-16/1902:6-10" → [{id, begin, end, text}] with an
    exclusive end. Offsets count code points, which Python indexes natively."""
    if not raw_tag:
        return []
    emotes = []
    for group in raw_tag.split("/"):
        emote_id, _, ranges = group.partition(":")
        if not emote_id or not ranges:
            continue
        for range_part in ranges.split(","):
            begin_raw, _, end_raw = range_part.partition("-")
            try:
                begin, end = int(begin_raw), int(end_raw) + 1
            except ValueError:
                continue
            emotes.append({"id": emote_id, "begin": begin, "end": end, "text": text[begin:end]})
    return emotes


class TwitchChat:
    platform = "twitch"

    def __init__(self, hub):
        self.hub = hub
        self.channels: set[str] = set()
        self._ws = None
        self._task: asyncio.Task | None = None
        self._backoff = 1.0

    async def join(self, channel: str) -> None:
        self.channels.add(channel)
        await self.hub.publish_status(
            self.platform, channel, "warn", "connecting", f"Connecting to #{channel}…"
        )
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())
        elif self._ws is not None:
            await self._send(f"JOIN #{channel}")

    async def part(self, channel: str) -> None:
        self.channels.discard(channel)
        if self._ws is not None:
            await self._send(f"PART #{channel}")

    async def _send(self, line: str) -> None:
        try:
            await self._ws.send(line)
        except Exception:
            pass  # the read loop notices the dead socket and reconnects

    async def _run(self) -> None:
        while self.channels:
            try:
                async with websockets.connect(TWITCH_IRC_URL) as ws:
                    self._ws = ws
                    await ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands")
                    await ws.send(f"NICK justinfan{random.randint(10000, 99999)}")
                    for channel in sorted(self.channels):
                        await ws.send(f"JOIN #{channel}")
                    self._backoff = 1.0
                    async for frame in ws:
                        for line in str(frame).split("\r\n"):
                            if line:
                                await self._handle_line(line)
            except Exception as exc:
                logger.warning("twitch irc connection error: %s", exc)
            finally:
                self._ws = None
            if not self.channels:
                break
            for channel in self.channels:
                await self.hub.publish_status(
                    self.platform, channel, "error", "disconnected",
                    f"Reconnecting in {int(self._backoff)}s…",
                )
            await asyncio.sleep(self._backoff)
            self._backoff = min(self._backoff * 2, 30.0)

    async def _handle_line(self, line: str) -> None:
        parsed = parse_line(line)
        if parsed is None:
            return
        command = parsed["command"]
        params = parsed["params"]
        channel = params[0].lstrip("#") if params else ""

        if command == "PING":
            await self._send(f"PONG :{parsed['trailing'] or 'tmi.twitch.tv'}")
        elif command == "JOIN" and (parsed["prefix"] or "").startswith("justinfan"):
            await self.hub.publish_status(
                self.platform, channel, "ok", "connected", f"Connected to #{channel}"
            )
        elif command == "PRIVMSG":
            await self._handle_privmsg(parsed, channel)
        elif command == "USERNOTICE":
            await self._handle_usernotice(parsed, channel)
        elif command == "CLEARMSG":
            message_id = parsed["tags"].get("target-msg-id")
            if message_id:
                await self.hub.publish_deleted(self.platform, channel, message_id=message_id)
        elif command == "CLEARCHAT":
            # Trailing user = ban/timeout; no trailing = full chat clear.
            login = (parsed["trailing"] or "").lower() or None
            await self.hub.publish_deleted(self.platform, channel, author_login=login)
        elif command == "RECONNECT":
            if self._ws is not None:
                await self._ws.close()

    async def _handle_privmsg(self, parsed: dict, channel: str) -> None:
        tags = parsed["tags"]
        login = (parsed["prefix"] or "").split("!")[0] or "unknown"
        author = tags.get("display-name") or login
        text = parsed["trailing"] or ""
        emotes = parse_emotes(tags.get("emotes", ""), text)

        # Cheers arrive as ordinary PRIVMSGs with a bits tag; surface them as
        # system notices so they stand out like subs/gifts do.
        kind = "chat"
        bits = tags.get("bits")
        if bits:
            kind = "system"
            text, emotes = _prefix_text(f"{author} cheered {bits} bits", text, emotes)

        await self.hub.publish_message(Message(
            platform=self.platform,
            id=tags.get("id") or f"{time.time()}-{random.random()}",
            channel=channel,
            author=author,
            color=tags.get("color", ""),
            badges=[badge for badge in tags.get("badges", "").split(",") if badge],
            text=text,
            emotes=emotes,
            timestamp=int(tags.get("tmi-sent-ts") or time.time() * 1000),
            author_login=login.lower(),
            kind=kind,
        ))

    async def _handle_usernotice(self, parsed: dict, channel: str) -> None:
        """Subs, resubs, gift subs, raids, announcements… Twitch ships a
        ready-made human-readable line in the system-msg tag; any user message
        (e.g. a resub comment) rides in the trailing part."""
        tags = parsed["tags"]
        system_msg = (tags.get("system-msg") or "").strip()
        user_msg = parsed["trailing"] or ""
        emotes = parse_emotes(tags.get("emotes", ""), user_msg) if user_msg else []

        if system_msg and user_msg:
            text, emotes = _prefix_text(system_msg, user_msg, emotes)
        else:
            text = system_msg or user_msg
        if not text:
            return

        login = tags.get("login") or (parsed["prefix"] or "").split("!")[0] or "unknown"
        await self.hub.publish_message(Message(
            platform=self.platform,
            id=tags.get("id") or f"{time.time()}-{random.random()}",
            channel=channel,
            author=tags.get("display-name") or login,
            color=tags.get("color", ""),
            badges=[badge for badge in tags.get("badges", "").split(",") if badge],
            text=text,
            emotes=emotes,
            timestamp=int(tags.get("tmi-sent-ts") or time.time() * 1000),
            author_login=login.lower(),
            kind="system",
        ))

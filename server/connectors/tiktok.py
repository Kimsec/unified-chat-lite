"""Anonymous TikTok live chat connector.

TikTok live chat is readable without login, but the webcast endpoints demand
signed request parameters. The TikTokLive library handles the protobuf
protocol and routes room-entry signing through Euler Stream (a third-party
signing service with a free rate-limited tier) — the TikTok equivalent of
Kick's Cloudflare hurdle. One client (and task) per channel; if the channel
is not live we recheck every 60s, like the YouTube connector.
"""
from __future__ import annotations

import asyncio
import logging
import random
import time

from TikTokLive import TikTokLiveClient
from TikTokLive.events import (
    CommentEvent,
    ConnectEvent,
    GiftEvent,
    LiveEndEvent,
    SubscribeEvent,
)

try:
    from TikTokLive.client.errors import UserNotFoundError, UserOfflineError
except Exception:  # library layout changed — fall back to generic handling
    class UserOfflineError(Exception):  # type: ignore[no-redef]
        pass

    class UserNotFoundError(Exception):  # type: ignore[no-redef]
        pass

from ..models import Message

logger = logging.getLogger(__name__)

OFFLINE_RECHECK_SECONDS = 60


class TikTokChat:
    platform = "tiktok"

    def __init__(self, hub):
        self.hub = hub
        self.tasks: dict[str, asyncio.Task] = {}

    async def join(self, name: str) -> None:
        await self.hub.publish_status(
            self.platform, name, "warn", "connecting", f"Looking up @{name.lstrip('@')}…"
        )
        self.tasks[name] = asyncio.create_task(self._run(name))

    async def part(self, name: str) -> None:
        task = self.tasks.pop(name, None)
        if task is not None:
            task.cancel()

    async def _run(self, name: str) -> None:
        backoff = 5.0
        while True:
            client = TikTokLiveClient(unique_id=f"@{name.lstrip('@')}")
            self._register_handlers(client, name)
            try:
                await client.connect()  # runs until the stream/connection ends
                await self.hub.publish_status(
                    self.platform, name, "warn", "offline",
                    f"Stream ended — rechecking every {OFFLINE_RECHECK_SECONDS}s",
                )
                backoff = 5.0
                await asyncio.sleep(OFFLINE_RECHECK_SECONDS)
            except asyncio.CancelledError:
                try:
                    await client.disconnect()
                except Exception:
                    pass
                raise
            except UserOfflineError:
                await self.hub.publish_status(
                    self.platform, name, "warn", "offline",
                    f"Not live right now — rechecking every {OFFLINE_RECHECK_SECONDS}s",
                )
                backoff = 5.0
                await asyncio.sleep(OFFLINE_RECHECK_SECONDS)
            except UserNotFoundError:
                await self.hub.publish_status(
                    self.platform, name, "error", "not found",
                    f"No TikTok user named @{name.lstrip('@')}",
                )
                return
            except Exception as exc:
                logger.warning("tiktok error for %s: %s", name, exc)
                await self.hub.publish_status(
                    self.platform, name, "error", "error", f"{exc} — retrying in {int(backoff)}s"
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 120.0)

    def _register_handlers(self, client: TikTokLiveClient, name: str) -> None:
        @client.on(ConnectEvent)
        async def _on_connect(event: ConnectEvent) -> None:
            await self.hub.publish_status(
                self.platform, name, "ok", "connected",
                f"Connected to @{name.lstrip('@')}",
            )

        @client.on(CommentEvent)
        async def _on_comment(event: CommentEvent) -> None:
            user = event.user
            author = (getattr(user, "nickname", "") or getattr(user, "unique_id", "") or "Unknown")
            await self._publish(name, author, user, str(event.comment or ""), kind="chat")

        @client.on(GiftEvent)
        async def _on_gift(event: GiftEvent) -> None:
            gift = event.gift
            # Streakable gifts fire once per tap; only report the final total.
            if getattr(gift, "streakable", False) and getattr(event, "streaking", False):
                return
            user = event.user
            author = (getattr(user, "nickname", "") or getattr(user, "unique_id", "") or "Someone")
            count = getattr(event, "repeat_count", 1) or 1
            gift_name = getattr(gift, "name", "") or "a gift"
            text = f"{author} sent {count}x {gift_name}!" if count > 1 else f"{author} sent {gift_name}!"
            await self._publish(name, author, user, text, kind="system")

        @client.on(SubscribeEvent)
        async def _on_subscribe(event: SubscribeEvent) -> None:
            user = event.user
            author = (getattr(user, "nickname", "") or getattr(user, "unique_id", "") or "Someone")
            await self._publish(name, author, user, f"{author} subscribed!", kind="system")

        @client.on(LiveEndEvent)
        async def _on_live_end(event: LiveEndEvent) -> None:
            await self.hub.publish_status(
                self.platform, name, "warn", "offline", "Stream ended",
            )

    async def _publish(self, name: str, author: str, user, text: str, *, kind: str) -> None:
        if not text.strip():
            return
        message_id = getattr(getattr(user, "common", None), "msg_id", None)
        await self.hub.publish_message(Message(
            platform=self.platform,
            id=str(message_id or f"{time.time()}-{random.random()}"),
            channel=name,
            author=author,
            color="",  # TikTok has no per-user chat colors
            badges=[],
            text=text,
            emotes=[],
            timestamp=int(time.time() * 1000),
            author_login=str(getattr(user, "unique_id", "") or author).lower(),
            kind=kind,
        ))

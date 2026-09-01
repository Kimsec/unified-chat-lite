"""Anonymous YouTube live chat connector.

No API key of our own, no OAuth: this speaks InnerTube — the internal API the
YouTube web player itself uses. Flow per channel:

  1. GET youtube.com/@handle/live → canonical watch URL → live video id
  2. GET youtube.com/live_chat?v=<id> → scrape INNERTUBE_API_KEY, client
     version and the first chat continuation token from the page
  3. POST youtubei/v1/live_chat/get_live_chat with the continuation, render
     the actions, repeat with the next continuation at the pace YouTube asks

Unlike Twitch/Kick there is no push socket, so this polls. A channel can run
a regular live and a live Short at the same time; /@handle/live only ever
resolves to one of them, so the Shorts tab is scanned too and every live
broadcast found gets its own chat task, all feeding the same channel key.
If the channel is not live we recheck every 60s and attach when it goes
live. Requests use curl_cffi with a Chrome fingerprint plus the SOCS
consent cookie so EU consent redirects don't get in the way.
"""
from __future__ import annotations

import asyncio
import logging
import random
import re
import time

from curl_cffi.requests import AsyncSession

from ..models import Message, prefix_text

logger = logging.getLogger(__name__)

OFFLINE_RECHECK_SECONDS = 60
COOKIES = {"SOCS": "CAI"}

CANONICAL_WATCH_RE = re.compile(
    r'<link rel="canonical" href="https://www\.youtube\.com/watch\?v=([\w-]{11})"'
)
API_KEY_RE = re.compile(r'"INNERTUBE_API_KEY":"([^"]+)"')
CLIENT_VERSION_RE = re.compile(r'"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"')
CONTINUATION_RE = re.compile(r'"continuation":"([^"]+)"')

# Shorts tab (/@handle/shorts): each grid item is a shortsLockupViewModel

SHORTS_ITEM_RE = re.compile(r'"shortsLockupViewModel":\{"entityId":"shorts-shelf-item-([\w-]{11})"')
SHORTS_LIVE_RE = re.compile(r'"liveBadgeText"|"badgeStyle":"THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE"')
SHORTS_BLOCK_WINDOW = 4000


def parse_runs(runs: list[dict]) -> tuple[str, list[dict]]:
    """Flatten InnerTube message runs into (text, emotes). Custom channel
    emojis become emotes whose id is the image URL itself; standard unicode
    emoji are inlined as plain text."""
    parts: list[str] = []
    emotes: list[dict] = []
    length = 0
    for run in runs:
        if "text" in run:
            text = str(run["text"])
            parts.append(text)
            length += len(text)
            continue
        emoji = run.get("emoji") or {}
        if emoji.get("isCustomEmoji"):
            shortcuts = emoji.get("shortcuts") or []
            name = str(shortcuts[0] if shortcuts else emoji.get("emojiId") or "emoji").strip(":")
            thumbnails = (emoji.get("image") or {}).get("thumbnails") or []
            url = str(thumbnails[-1].get("url", "")) if thumbnails else ""
            parts.append(name)
            if url:
                emotes.append({"id": url, "begin": length, "end": length + len(name), "text": name})
            length += len(name)
        else:
            char = str(emoji.get("emojiId") or "")
            parts.append(char)
            length += len(char)
    return "".join(parts), emotes


class YouTubeChat:
    platform = "youtube"

    def __init__(self, hub):
        self.hub = hub
        self.tasks: dict[str, asyncio.Task] = {}

    async def join(self, name: str) -> None:
        await self.hub.publish_status(
            self.platform, name, "warn", "connecting", f"Looking up {name}…"
        )
        self.tasks[name] = asyncio.create_task(self._run(name))

    async def part(self, name: str) -> None:
        task = self.tasks.pop(name, None)
        if task is not None:
            task.cancel()

    async def _run(self, name: str) -> None:
        backoff = 5.0
        chats: dict[str, asyncio.Task] = {}
        try:
            while True:
                try:
                    async with AsyncSession(impersonate="chrome", cookies=COOKIES) as session:
                        live_ids = await self._find_live_videos(session, name)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning("youtube lookup error for %s: %s", name, exc)
                    if any(not task.done() for task in chats.values()):
                        await asyncio.sleep(OFFLINE_RECHECK_SECONDS)
                    else:
                        await self.hub.publish_status(
                            self.platform, name, "error", "error",
                            f"{exc} — retrying in {int(backoff)}s",
                        )
                        await asyncio.sleep(backoff)
                        backoff = min(backoff * 2, 60.0)
                    continue
                backoff = 5.0

                for video_id in [vid for vid, task in chats.items() if task.done()]:
                    del chats[video_id]
                if live_ids:
                    suffix = " (+ live Short)" if len(live_ids) > 1 else ""
                    for video_id in live_ids:
                        if video_id not in chats:
                            # Only the featured broadcast owns the status card
                            # (and the player's video id).
                            detail = (
                                f"Connected to @{name.lstrip('@')}{suffix}"
                                if video_id == live_ids[0] else None
                            )
                            chats[video_id] = asyncio.create_task(
                                self._chat_loop(name, video_id, chats, detail)
                            )
                elif not chats:
                    await self.hub.publish_status(
                        self.platform, name, "warn", "offline",
                        f"Not live right now — rechecking every {OFFLINE_RECHECK_SECONDS}s",
                    )
                await asyncio.sleep(OFFLINE_RECHECK_SECONDS)
        except asyncio.CancelledError:
            for task in chats.values():
                task.cancel()
            raise

    async def _chat_loop(
        self, name: str, video_id: str, chats: dict[str, asyncio.Task],
        status_detail: str | None,
    ) -> None:
        backoff = 5.0
        while True:
            try:
                async with AsyncSession(impersonate="chrome", cookies=COOKIES) as session:
                    bootstrap = await self._chat_bootstrap(session, video_id)
                    if bootstrap is None:
                        if status_detail:
                            await self.hub.publish_status(
                                self.platform, name, "warn", "offline",
                                "Live page found but no chat yet — rechecking",
                            )
                        return
                    api_key, client_version, first_continuation = bootstrap
                    continuation: str | None = first_continuation
                    if status_detail:
                        await self.hub.publish_status(
                            self.platform, name, "ok", "connected",
                            status_detail, video_id=video_id,
                        )
                    backoff = 5.0

                    while continuation:
                        data = await self._fetch_chat(session, api_key, client_version, continuation)
                        continuation, timeout_ms = await self._process(name, data)
                        if continuation:
                            await asyncio.sleep(max(timeout_ms, 800) / 1000)

                    if not any(
                        not task.done()
                        for vid, task in chats.items() if vid != video_id
                    ):
                        await self.hub.publish_status(
                            self.platform, name, "warn", "offline",
                            "Live chat ended — rechecking",
                        )
                    return
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("youtube chat error for %s: %s", name, exc)
                if status_detail:
                    await self.hub.publish_status(
                        self.platform, name, "error", "error",
                        f"{exc} — retrying in {int(backoff)}s",
                    )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)

    async def _find_live_video(self, session: AsyncSession, name: str) -> str | None:
        handle = name if name.startswith("@") else f"@{name}"
        for url in (
            f"https://www.youtube.com/{handle}/live",
            f"https://www.youtube.com/c/{name.lstrip('@')}/live",
        ):
            response = await session.get(url, timeout=20)
            if response.status_code >= 400:
                continue
            match = CANONICAL_WATCH_RE.search(response.text)
            if match:
                return match.group(1)
        return None

    async def _find_live_videos(self, session: AsyncSession, name: str) -> list[str]:
        """Every live broadcast currently running, featured first. /live only
        ever resolves to one broadcast, so the Shorts tab is scanned too."""
        featured, short = await asyncio.gather(
            self._find_live_video(session, name),
            self._find_live_short(session, name),
        )
        return list(dict.fromkeys(vid for vid in (featured, short) if vid))

    async def _find_live_short(self, session: AsyncSession, name: str) -> str | None:
        handle = name if name.startswith("@") else f"@{name}"
        response = await session.get(f"https://www.youtube.com/{handle}/shorts", timeout=20)
        if response.status_code >= 400:
            return None
        html = response.text
        matches = list(SHORTS_ITEM_RE.finditer(html))
        for i, match in enumerate(matches):
            end = match.start() + SHORTS_BLOCK_WINDOW
            if i + 1 < len(matches):
                end = min(end, matches[i + 1].start())
            if SHORTS_LIVE_RE.search(html, match.start(), end):
                return match.group(1)
        return None

    async def _chat_bootstrap(
        self, session: AsyncSession, video_id: str
    ) -> tuple[str, str, str] | None:
        response = await session.get(
            f"https://www.youtube.com/live_chat?is_popout=1&v={video_id}", timeout=20
        )
        if response.status_code >= 400:
            return None
        html = response.text
        api_key = API_KEY_RE.search(html)
        client_version = CLIENT_VERSION_RE.search(html)
        continuation = CONTINUATION_RE.search(html)
        if not (api_key and client_version and continuation):
            return None
        return api_key.group(1), client_version.group(1), continuation.group(1)

    async def _fetch_chat(
        self, session: AsyncSession, api_key: str, client_version: str, continuation: str
    ) -> dict:
        response = await session.post(
            f"https://www.youtube.com/youtubei/v1/live_chat/get_live_chat"
            f"?key={api_key}&prettyPrint=false",
            json={
                "context": {"client": {"clientName": "WEB", "clientVersion": client_version}},
                "continuation": continuation,
            },
            timeout=20,
        )
        if response.status_code >= 400:
            raise RuntimeError(f"get_live_chat returned {response.status_code}")
        return response.json()

    async def _process(self, name: str, data: dict) -> tuple[str | None, int]:
        chat = (data.get("continuationContents") or {}).get("liveChatContinuation") or {}

        for action in chat.get("actions") or []:
            add = action.get("addChatItemAction")
            if add:
                item = add.get("item") or {}
                renderer = item.get("liveChatTextMessageRenderer")
                if renderer:
                    await self._publish(name, renderer)
                else:
                    await self._publish_system(name, item)
                continue
            deleted = action.get("markChatItemAsDeletedAction")
            if deleted and deleted.get("targetItemId"):
                await self.hub.publish_deleted(
                    self.platform, name, message_id=str(deleted["targetItemId"])
                )

        for continuation in chat.get("continuations") or []:
            for kind in (
                "invalidationContinuationData",
                "timedContinuationData",
                "reloadContinuationData",
            ):
                found = continuation.get(kind)
                if found and found.get("continuation"):
                    return found["continuation"], int(found.get("timeoutMs") or 2000)
        return None, 0

    async def _publish_system(self, name: str, item: dict) -> None:
        """Super Chats, Super Stickers, new/renewed memberships and gifted
        memberships arrive as their own renderer types in the same feed."""
        paid = item.get("liveChatPaidMessageRenderer")
        sticker = item.get("liveChatPaidStickerRenderer")
        member = item.get("liveChatMembershipItemRenderer")
        gift = item.get("liveChatSponsorshipsGiftPurchaseAnnouncementRenderer")
        renderer = paid or sticker or member or gift
        if renderer is None:
            return

        emotes: list[dict] = []
        if gift is not None:
            header = (gift.get("header") or {}).get("liveChatSponsorshipsHeaderRenderer") or {}
            author = str((header.get("authorName") or {}).get("simpleText") or "Someone")
            primary, _ = parse_runs((header.get("primaryText") or {}).get("runs") or [])
            text = f"{author} {primary}".strip() if primary else f"{author} gifted memberships!"
        else:
            author = str((renderer.get("authorName") or {}).get("simpleText") or "Someone")
            if paid is not None:
                amount = str((paid.get("purchaseAmountText") or {}).get("simpleText") or "").strip()
                base = f"{author} sent a {amount} Super Chat" if amount else f"{author} sent a Super Chat"
                message, message_emotes = parse_runs((paid.get("message") or {}).get("runs") or [])
                text, emotes = prefix_text(base, message, message_emotes)
            elif sticker is not None:
                amount = str((sticker.get("purchaseAmountText") or {}).get("simpleText") or "").strip()
                text = f"{author} sent a {amount} Super Sticker!" if amount else f"{author} sent a Super Sticker!"
            else:  # membership — the only renderer left given the guard above
                assert member is not None
                header_runs = (
                    (member.get("headerSubtext") or {}).get("runs")
                    or (member.get("headerPrimaryText") or {}).get("runs")
                    or []
                )
                header_text, _ = parse_runs(header_runs)
                base = f"{author} · {header_text}" if header_text else f"{author} became a member"
                message, message_emotes = parse_runs((member.get("message") or {}).get("runs") or [])
                text, emotes = prefix_text(base, message, message_emotes)

        timestamp_usec = int(renderer.get("timestampUsec") or 0)
        await self.hub.publish_message(Message(
            platform=self.platform,
            id=str(renderer.get("id") or f"{time.time()}-{random.random()}"),
            channel=name,
            author=author,
            color="",
            badges=[],
            text=text,
            emotes=emotes,
            timestamp=timestamp_usec // 1000 if timestamp_usec else int(time.time() * 1000),
            author_login=author.lower(),
            kind="system",
        ))

    async def _publish(self, name: str, renderer: dict) -> None:
        text, emotes = parse_runs((renderer.get("message") or {}).get("runs") or [])
        if not text.strip():
            return
        author = str((renderer.get("authorName") or {}).get("simpleText") or "Unknown")
        badges = []
        for badge in renderer.get("authorBadges") or []:
            badge_renderer = badge.get("liveChatAuthorBadgeRenderer") or {}
            icon_type = (badge_renderer.get("icon") or {}).get("iconType")
            label = icon_type or badge_renderer.get("tooltip")
            if label:
                badges.append(str(label).lower())
        timestamp_usec = int(renderer.get("timestampUsec") or 0)
        await self.hub.publish_message(Message(
            platform=self.platform,
            id=str(renderer.get("id") or f"{time.time()}-{random.random()}"),
            channel=name,
            author=author,
            color="",  # YouTube has no per-user chat colors
            badges=badges,
            text=text,
            emotes=emotes,
            timestamp=timestamp_usec // 1000 if timestamp_usec else int(time.time() * 1000),
            author_login=author.lower(),
        ))

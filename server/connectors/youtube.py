"""Anonymous YouTube live chat connector.

No API key of our own, no OAuth: this speaks InnerTube — the internal API the
YouTube web player itself uses. Flow per channel:

  1. GET youtube.com/@handle/live → resolve the vanity URL's embedded
     redirect command to a live video id (see `_find_featured_live`)
  2. GET youtube.com/live_chat?v=<id> → scrape INNERTUBE_API_KEY, client
     version and the first chat continuation token from the page
  3. POST youtubei/v1/live_chat/get_live_chat with the continuation, render
     the actions, repeat with the next continuation at the pace YouTube asks

Unlike Twitch/Kick there is no push socket, so this polls — one task per
channel. If the channel is not live we recheck every 60s and attach when it
goes live. Requests use curl_cffi with a Chrome fingerprint plus the SOCS
consent cookie so EU consent redirects don't get in the way.

There is no dedicated "YouTube Shorts" API either: a Shorts-style live is
just a live broadcast published in a vertical (9:16) aspect ratio, and a
channel can run one of each at the same time (a regular live plus a live
Short) — `/@handle/live` only ever resolves to one of them, so it can't be
the only source. The same InnerTube scraping is reused for both the
"youtube" and "youtube_shorts" platforms — one `YouTubeChat` instance per
platform — but each poll gathers *every* live broadcast currently running on
the channel (`_find_live_videos`) from sources YouTube itself already
segregates by content type:

  - `/@handle/streams` — the channel's Streams tab, scanned for the entry
    carrying a "LIVE" thumbnail badge. Primary source for the horizontal
    live, found independently of whatever `/live` happens to redirect to.
  - `/@handle/live` — the vanity URL, used only as a fallback for the
    horizontal live when the Streams tab hasn't picked up a brand-new
    broadcast yet.
  - `/@handle/shorts` — the channel's Shorts tab, scanned the same way for
    an entry carrying a "LIVE" badge.

Orientation can no longer be read off reliable width/height metadata (recent
YouTube markup dropped the og:video/og:image dimension tags this used to
rely on). A broadcast found via the Shorts tab is vertical by definition —
that tab only ever lists Shorts. Anything else is treated as horizontal
*unless* its own title is self-tagged with "#shorts", the same fallback a
human would use to tell them apart.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import re
import time

from curl_cffi.requests import AsyncSession

from ..models import Message, prefix_text

logger = logging.getLogger(__name__)

OFFLINE_RECHECK_SECONDS = 60
COOKIES = {"SOCS": "CAI"}

# The vanity URL (/@handle/live) no longer canonicalizes via a <link
# rel="canonical"> tag; instead the page embeds the resolved navigation as a
# small inline JS object we can parse as JSON.
YT_COMMAND_RE = re.compile(r"window\['ytCommand'\] = (\{.*?\});window\['ytUrl'\]", re.DOTALL)
LIVE_TITLE_RE = re.compile(r'"playerOverlayVideoDetailsRenderer":\{"title":\{"simpleText":"([^"]*)"')
SHORTS_HASHTAG_RE = re.compile(r"#shorts\b", re.IGNORECASE)

API_KEY_RE = re.compile(r'"INNERTUBE_API_KEY":"([^"]+)"')
CLIENT_VERSION_RE = re.compile(r'"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"')
CONTINUATION_RE = re.compile(r'"continuation":"([^"]+)"')

# Shorts tab (/@handle/shorts) scanning: each grid item is a
# shortsLockupViewModel; rather than fully parsing the surrounding minified
# JSON we anchor on the item boundary and search a generous fixed window
# after it for the fields we need.
SHORTS_ITEM_ANCHOR = '"shortsLockupViewModel":{"entityId":"shorts-shelf-item-'
SHORTS_BLOCK_WINDOW = 4000
SHORTS_VIDEO_ID_RE = re.compile(r'"videoId":"([\w-]{11})"')
SHORTS_TITLE_RE = re.compile(r'"primaryText":\{"content":"([^"]*)"')
SHORTS_LIVE_BADGE_RE = re.compile(r'"badgeStyle":"THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE"')
SHORTS_LIVE_WATCHING_RE = re.compile(r'"secondaryText":\{"content":"[^"]*\bwatching\b', re.IGNORECASE)

# Streams tab (/@handle/streams) scanning: the currently-live entry (if any)
# is the only one whose thumbnail badge carries this style, with the video id
# right there in the same badge object — no windowing needed to find it. Its
# title sits further into the same lockupViewModel entry.
LIVE_STREAM_BADGE_RE = re.compile(
    r'"badgeStyle":"THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE","animationActivationTargetId":"([\w-]{11})"'
)
STREAM_TITLE_RE = re.compile(r'"lockupMetadataViewModel":\{"title":\{"content":"([^"]*)"')
STREAM_TITLE_WINDOW = 6000

VERTICAL = "vertical"
HORIZONTAL = "horizontal"


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
    def __init__(self, hub, platform: str = "youtube"):
        self.hub = hub
        self.platform = platform
        self.expected_orientation = VERTICAL if platform == "youtube_shorts" else HORIZONTAL
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
        while True:
            try:
                async with AsyncSession(impersonate="chrome", cookies=COOKIES) as session:
                    candidates = await self._find_live_videos(session, name)
                    if not candidates:
                        await self.hub.publish_status(
                            self.platform, name, "warn", "offline",
                            f"Not live right now — rechecking every {OFFLINE_RECHECK_SECONDS}s",
                        )
                        await asyncio.sleep(OFFLINE_RECHECK_SECONDS)
                        continue

                    match = next((c for c in candidates if c[1] == self.expected_orientation), None)
                    if match is None:
                        found_orientations = ", ".join(sorted({c[1] for c in candidates}))
                        await self.hub.publish_status(
                            self.platform, name, "warn", "offline",
                            f"Live now, but only in {found_orientations} format — waiting for a "
                            f"{self.expected_orientation} live — rechecking every {OFFLINE_RECHECK_SECONDS}s",
                        )
                        await asyncio.sleep(OFFLINE_RECHECK_SECONDS)
                        continue

                    video_id, _orientation, _title = match
                    bootstrap = await self._chat_bootstrap(session, video_id)
                    if bootstrap is None:
                        await self.hub.publish_status(
                            self.platform, name, "warn", "offline",
                            "Live page found but no chat yet — rechecking",
                        )
                        await asyncio.sleep(OFFLINE_RECHECK_SECONDS)
                        continue

                    api_key, client_version, first_continuation = bootstrap
                    continuation: str | None = first_continuation
                    await self.hub.publish_status(
                        self.platform, name, "ok", "connected",
                        f"Connected to @{name.lstrip('@')}",
                        video_id=video_id,
                    )
                    backoff = 5.0

                    while continuation:
                        data = await self._fetch_chat(session, api_key, client_version, continuation)
                        continuation, timeout_ms = await self._process(name, data)
                        if continuation:
                            await asyncio.sleep(max(timeout_ms, 800) / 1000)

                    # Stream (or just the chat) ended; fall through to the
                    # liveness recheck.
                    await self.hub.publish_status(
                        self.platform, name, "warn", "offline",
                        "Live chat ended — rechecking",
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("youtube chat error for %s: %s", name, exc)
                await self.hub.publish_status(
                    self.platform, name, "error", "error",
                    f"{exc} — retrying in {int(backoff)}s",
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)

    async def _find_live_videos(self, session: AsyncSession, name: str) -> list[tuple[str, str, str]]:
        """Every live broadcast currently running on the channel, as
        (video_id, orientation, title). A channel can run a horizontal live
        and a live Short at the same time, and `/live` only ever resolves to
        one broadcast, so the Streams and Shorts tabs are scanned
        independently every poll rather than stopping at the first hit.

        The channel's "Live" tab (served at /streams) isn't necessarily
        limited to horizontal content — it can list a live Short too — so
        each entry found there is classified from its own title's "#shorts"
        tag rather than assumed horizontal. When that tab and the dedicated
        Shorts tab both surface the same video id (the Short showing up in
        both places), the Shorts tab wins: it's structural proof the id is a
        Short even when the title itself carries no "#shorts" tag."""
        streams, live_short = await asyncio.gather(
            self._find_live_streams(session, name),
            self._find_live_short(session, name),
        )
        if not streams:
            # The Streams tab can lag a few seconds behind a brand-new
            # broadcast; the vanity redirect tends to update first.
            featured = await self._find_featured_live(session, name)
            if featured is not None:
                streams = [featured]

        by_id: dict[str, tuple[str, str, str]] = {c[0]: c for c in streams}
        if live_short is not None:
            by_id[live_short[0]] = live_short

        return list(by_id.values())

    async def _find_live_streams(self, session: AsyncSession, name: str) -> list[tuple[str, str, str]]:
        """Scan the channel's Live/Streams tab for every entry carrying a
        LIVE badge — the primary source for the horizontal live, found
        independently of whatever `/live` happens to redirect to. Orientation
        is decided per entry from its own title's "#shorts" tag, since this
        tab is not guaranteed to be horizontal-only."""
        handle = name if name.startswith("@") else f"@{name}"
        response = await session.get(f"https://www.youtube.com/{handle}/streams", timeout=20)
        if response.status_code >= 400:
            return []
        html = response.text
        results: list[tuple[str, str, str]] = []
        for match in LIVE_STREAM_BADGE_RE.finditer(html):
            video_id = match.group(1)
            title_match = STREAM_TITLE_RE.search(html, match.end(), match.end() + STREAM_TITLE_WINDOW)
            title = title_match.group(1) if title_match else ""
            orientation = VERTICAL if SHORTS_HASHTAG_RE.search(title) else HORIZONTAL
            results.append((video_id, orientation, title))
        return results

    async def _find_featured_live(self, session: AsyncSession, name: str) -> tuple[str, str, str] | None:
        """Fallback for _find_live_streams: the channel's featured live via
        the /@handle/live vanity URL. Horizontal unless the title self-tags
        with "#shorts" — YouTube no longer exposes reliable video dimensions
        for this page, so that hashtag is the only orientation signal left
        for whatever shows up here."""
        handle = name if name.startswith("@") else f"@{name}"
        for url in (
            f"https://www.youtube.com/{handle}/live",
            f"https://www.youtube.com/c/{name.lstrip('@')}/live",
        ):
            response = await session.get(url, timeout=20)
            if response.status_code >= 400:
                continue
            html = response.text
            # An offline channel resolves this vanity URL to its channel page
            # (webPageType "WEB_PAGE_TYPE_CHANNEL"); only a live channel
            # resolves it to an actual watch page.
            match = YT_COMMAND_RE.search(html)
            if not match:
                continue
            try:
                command = json.loads(match.group(1))
            except ValueError:
                continue
            web_page_type = (
                (command.get("commandMetadata") or {}).get("webCommandMetadata") or {}
            ).get("webPageType")
            video_id = (command.get("watchEndpoint") or {}).get("videoId")
            if web_page_type != "WEB_PAGE_TYPE_WATCH" or not video_id:
                continue
            title_match = LIVE_TITLE_RE.search(html)
            title = title_match.group(1) if title_match else ""
            orientation = VERTICAL if SHORTS_HASHTAG_RE.search(title) else HORIZONTAL
            return video_id, orientation, title
        return None

    async def _find_live_short(self, session: AsyncSession, name: str) -> tuple[str, str, str] | None:
        """Scan the channel's Shorts tab for an entry carrying a LIVE badge.
        Anything found here is vertical by definition — the Shorts tab only
        ever lists Shorts."""
        handle = name if name.startswith("@") else f"@{name}"
        response = await session.get(f"https://www.youtube.com/{handle}/shorts", timeout=20)
        if response.status_code >= 400:
            return None
        html = response.text
        for match in re.finditer(re.escape(SHORTS_ITEM_ANCHOR), html):
            block = html[match.start(): match.start() + SHORTS_BLOCK_WINDOW]
            if not (SHORTS_LIVE_BADGE_RE.search(block) or SHORTS_LIVE_WATCHING_RE.search(block)):
                continue
            video_id_match = SHORTS_VIDEO_ID_RE.search(block)
            if not video_id_match:
                continue
            title_match = SHORTS_TITLE_RE.search(block)
            return video_id_match.group(1), VERTICAL, (title_match.group(1) if title_match else "")
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

"""AirPlay with chat: the stream's own HLS playlist plus a live "Chat" subtitle track.

AirPlay plays media, not web pages, so the chat reaches the TV as captions.
The master playlist is the platform's own with one extra WebVTT subtitle
rendition; video segments still stream straight from the platform CDN. Each
subtitle segment mirrors a video segment and is pinned to that segment's
first PTS (X-TIMESTAMP-MAP), so captions move in step with the picture. The
chat lines a segment shows are snapshotted when the segment first appears at
the live edge, which keeps them in sync with the stream's delay.

While a TV is polling, the session holds its own hub subscription, so the
chat keeps flowing after the phone that started AirPlay locks.
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from urllib.parse import urljoin

from curl_cffi.requests import AsyncSession

from . import streams
from .hub import Hub, Viewer

PLAYLIST_TYPE = "application/vnd.apple.mpegurl"
SESSION_IDLE_SECONDS = 60
PLAYLIST_CACHE_SECONDS = 1.0
CHAT_LINES = 6
CHAT_LINE_CHARS = 90
SNAPSHOTS_KEPT = 120
TS_HEAD_BYTES = 188 * 64

# Captions can't show images, so each line gets a platform-coloured marker and the
# name a WebVTT default colour class (Apple's players render both).
PLATFORM_MARKERS = {"twitch": "🟣", "kick": "🟢", "youtube": "🔴", "tiktok": "🎵"}
PLATFORM_NAME_CLASS = {"twitch": "magenta", "kick": "lime", "youtube": "red", "tiktok": "cyan"}

ATTR_RE = re.compile(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)')


@dataclass
class Segment:
    sequence: int
    duration: float
    uri: str
    discontinuity: bool
    program_date_time: str


@dataclass
class Session:
    platform: str
    channel: str
    channels: dict[str, str]
    viewer: Viewer
    last_used: float = field(default_factory=time.monotonic)
    master_url: str = ""
    reference_url: str = ""
    playlist: tuple[float, list[Segment], int, float] | None = None  # fetched_at, segments, disc. seq, target
    snapshots: dict[int, str] = field(default_factory=dict)
    pts: dict[str, int] = field(default_factory=dict)
    hidden_platforms: set[str] = field(default_factory=set)  # the viewer's filter chips


class _TvViewer(Viewer):
    """The AirPlay session's hub subscription: no socket, so fan-out is a no-op."""

    async def send(self, payload: dict) -> None:
        pass

    async def send_text(self, text: str) -> None:
        pass


class AirPlayChat:
    def __init__(self, hub: Hub):
        self.hub = hub
        self.sessions: dict[tuple, Session] = {}
        self._http_client: AsyncSession | None = None
        self._http_loop: asyncio.AbstractEventLoop | None = None

    def _http(self) -> AsyncSession:
        """One shared client per event loop, so a TV polling every ~2s reuses its CDN
        connections instead of a new TLS handshake per request."""
        loop = asyncio.get_running_loop()
        if self._http_client is None or self._http_loop is not loop:
            self._http_client = AsyncSession(impersonate="chrome")
            self._http_loop = loop
        return self._http_client

    async def session(self, platform: str, channel: str, channels: dict[str, str]) -> Session:
        key = (platform, channel, tuple(sorted(channels.items())))
        session = self.sessions.get(key)
        if session is None:
            session = Session(platform, channel, channels, _TvViewer(None))
            self.sessions[key] = session
            for chat_platform, chat_channel in channels.items():
                await self.hub.subscribe(session.viewer, chat_platform, chat_channel)
        session.last_used = time.monotonic()
        return session

    async def reap(self) -> None:
        """Drop sessions no TV has polled for a while (runs forever)."""
        while True:
            await asyncio.sleep(SESSION_IDLE_SECONDS / 2)
            cutoff = time.monotonic() - SESSION_IDLE_SECONDS
            for key, session in list(self.sessions.items()):
                if session.last_used < cutoff:
                    del self.sessions[key]
                    await self.hub.drop_viewer(session.viewer)

    # --- Playlists ---

    async def master(self, session: Session) -> str | None:
        session.master_url = await streams.stream_url(session.platform, session.channel) or ""
        if not session.master_url:
            return None
        response = await self._http().get(session.master_url, timeout=10)
        if response.status_code >= 400:
            return None
        lines = response.text.splitlines()
        out: list[str] = []
        variants: list[tuple[int, bool, str]] = []
        pending_inf: dict | None = None
        for line in lines:
            if line.startswith("#EXT-X-STREAM-INF:"):
                pending_inf = dict(ATTR_RE.findall(line.split(":", 1)[1]))
                line += ',SUBTITLES="chat"'
            elif line and not line.startswith("#"):
                line = urljoin(session.master_url, line)
                if pending_inf is not None:
                    audio_only = "avc1" not in pending_inf.get("CODECS", "") and "hvc1" not in pending_inf.get("CODECS", "")
                    variants.append((int(pending_inf.get("BANDWIDTH", "0") or 0), audio_only, line))
                    pending_inf = None
            elif 'URI="' in line:
                line = re.sub(r'URI="([^"]+)"', lambda m: f'URI="{urljoin(session.master_url, m.group(1))}"', line)
            out.append(line)
        if not variants:
            return None
        # Any rendition shares the media sequence and timeline; the lightest is cheapest to read.
        session.reference_url = min(variants, key=lambda v: (not v[1], v[0]))[2]
        session.playlist = None
        header_end = 1 if out and out[0].startswith("#EXTM3U") else 0
        out.insert(
            header_end,
            '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="chat",NAME="Chat",LANGUAGE="en",'
            'DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI="chat.m3u8"',
        )
        return "\n".join(out) + "\n"

    async def chat_playlist(self, session: Session) -> str | None:
        if not session.reference_url:  # e.g. the server restarted mid-stream
            await self.master(session)
        playlist = await self._reference_playlist(session)
        if playlist is None:
            return None
        segments, discontinuity_sequence, target = playlist
        snapshot = None
        for segment in segments:
            if segment.sequence not in session.snapshots:
                snapshot = snapshot if snapshot is not None else self._chat_text(session)
                session.snapshots[segment.sequence] = snapshot
        for old in sorted(session.snapshots)[:-SNAPSHOTS_KEPT]:
            del session.snapshots[old]

        out = [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            f"#EXT-X-TARGETDURATION:{int(target + 0.999)}",
            f"#EXT-X-MEDIA-SEQUENCE:{segments[0].sequence if segments else 0}",
        ]
        if discontinuity_sequence:
            out.append(f"#EXT-X-DISCONTINUITY-SEQUENCE:{discontinuity_sequence}")
        for segment in segments:
            if segment.discontinuity:
                out.append("#EXT-X-DISCONTINUITY")
            if segment.program_date_time:
                out.append(f"#EXT-X-PROGRAM-DATE-TIME:{segment.program_date_time}")
            out.append(f"#EXTINF:{segment.duration:.3f},")
            out.append(f"chat/{segment.sequence}.vtt")
        return "\n".join(out) + "\n"

    async def chat_segment(self, session: Session, sequence: int) -> str | None:
        playlist = await self._reference_playlist(session)
        if playlist is None:
            return None
        segment = next((s for s in playlist[0] if s.sequence == sequence), None)
        if segment is None:
            return None
        pts = await self._segment_pts(session, segment.uri)
        text = session.snapshots.get(sequence) or self._chat_text(session)
        out = ["WEBVTT"]
        if pts is not None:
            out.append(f"X-TIMESTAMP-MAP=MPEGTS:{pts},LOCAL:00:00:00.000")
        out.append("")
        if text:
            out += [f"00:00:00.000 --> {_vtt_time(segment.duration)} line:-1 align:start", text, ""]
        return "\n".join(out) + "\n"

    # --- Helpers ---

    async def _reference_playlist(self, session: Session) -> tuple[list[Segment], int, float] | None:
        if not session.reference_url:
            return None
        now = time.monotonic()
        if session.playlist and now - session.playlist[0] < PLAYLIST_CACHE_SECONDS:
            return session.playlist[1:]
        response = await self._http().get(session.reference_url, timeout=10)
        if response.status_code >= 400:
            return None
        segments, discontinuity_sequence, target = _parse_media_playlist(response.text, session.reference_url)
        session.playlist = (now, segments, discontinuity_sequence, target)
        return segments, discontinuity_sequence, target

    async def _segment_pts(self, session: Session, uri: str) -> int | None:
        if uri in session.pts:
            return session.pts[uri]
        try:
            response = await self._http().get(
                uri, headers={"Range": f"bytes=0-{TS_HEAD_BYTES - 1}"}, timeout=10
            )
            pts = _first_pts(response.content[:TS_HEAD_BYTES]) if response.status_code < 400 else None
        except Exception:
            pts = None
        if len(session.pts) > SNAPSHOTS_KEPT:
            session.pts.clear()
        session.pts[uri] = pts
        return pts

    def _chat_text(self, session: Session) -> str:
        messages = []
        for key in session.viewer.keys:
            if key[0] in session.hidden_platforms:
                continue
            handle = self.hub.channels.get(key)
            if handle is not None:
                messages.extend(m for m in handle.recent if not m.deleted and m.text.strip())
        messages.sort(key=lambda m: m.timestamp)
        lines = []
        for message in messages[-CHAT_LINES:]:
            body = message.text
            if len(body) > CHAT_LINE_CHARS:
                body = body[: CHAT_LINE_CHARS - 1].rstrip() + "…"
            body = _vtt_escape(body)
            if message.kind != "system":
                name_class = PLATFORM_NAME_CLASS.get(message.platform, "white")
                body = f"<c.{name_class}>{_vtt_escape(message.author)}</c>: {body}"
            lines.append(f"{PLATFORM_MARKERS.get(message.platform, '•')} {body}")
        return "\n".join(lines)


def _parse_media_playlist(text: str, base_url: str) -> tuple[list[Segment], int, float]:
    segments: list[Segment] = []
    sequence = 0
    discontinuity_sequence = 0
    target = 2.0
    duration = None
    discontinuity = False
    program_date_time = ""
    for line in text.splitlines():
        if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            sequence = int(line.split(":", 1)[1])
        elif line.startswith("#EXT-X-DISCONTINUITY-SEQUENCE:"):
            discontinuity_sequence = int(line.split(":", 1)[1])
        elif line.startswith("#EXT-X-TARGETDURATION:"):
            target = float(line.split(":", 1)[1])
        elif line.startswith("#EXTINF:"):
            duration = float(line.split(":", 1)[1].split(",", 1)[0])
        elif line == "#EXT-X-DISCONTINUITY":
            discontinuity = True
        elif line.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
            program_date_time = line.split(":", 1)[1]
        elif line and not line.startswith("#") and duration is not None:
            segments.append(Segment(
                sequence, duration, urljoin(base_url, line), discontinuity, program_date_time
            ))
            sequence += 1
            duration = None
            discontinuity = False
            program_date_time = ""
    return segments, discontinuity_sequence, target


def _first_pts(data: bytes) -> int | None:
    """PTS of the first PES packet in an MPEG-TS segment head."""
    for offset in range(0, len(data) - 187, 188):
        packet = data[offset:offset + 188]
        if packet[0] != 0x47 or not packet[1] & 0x40:  # sync byte, payload_unit_start
            continue
        start = 4
        if packet[3] & 0x20:  # adaptation field present
            start += 1 + packet[4]
        pes = packet[start:]
        if len(pes) < 14 or pes[:3] != b"\x00\x00\x01" or not 0xC0 <= pes[3] <= 0xEF:
            continue
        if not pes[7] & 0x80:  # PTS flag
            continue
        b = pes[9:14]
        return (((b[0] >> 1) & 0x07) << 30) | (b[1] << 22) | ((b[2] >> 1) << 15) | (b[3] << 7) | (b[4] >> 1)
    return None


def _vtt_time(seconds: float) -> str:
    millis = int(round(seconds * 1000))
    return f"{millis // 3_600_000:02d}:{millis // 60_000 % 60:02d}:{millis // 1000 % 60:02d}.{millis % 1000:03d}"


def _vtt_escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

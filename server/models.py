from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class Message:
    platform: str
    id: str
    channel: str
    author: str
    color: str = ""
    badges: list[str] = field(default_factory=list)
    text: str = ""
    emotes: list[dict] = field(default_factory=list)
    timestamp: int = 0  # unix ms
    deleted: bool = False
    kind: str = "chat"  # "chat" | "system" (subs, gifts, raids, superchats, …)
    # Twitch Shared Chat: avatar + name of the partner streamer whose chat the
    # message came from. Empty for messages from the watched channel itself.
    avatar_url: str = ""
    source_name: str = ""
    # Internal only: lowercase login for CLEARCHAT (ban/timeout) matching on
    # Twitch, where display names can differ from logins.
    author_login: str = ""

    def to_payload(self) -> dict:
        payload = asdict(self)
        payload.pop("author_login", None)
        return payload


def prefix_text(prefix: str, text: str, emotes: list[dict]) -> tuple[str, list[dict]]:
    if not text.strip():
        return f"{prefix}!", []
    offset = len(prefix) + 2
    shifted = [dict(emote, begin=emote["begin"] + offset, end=emote["end"] + offset) for emote in emotes]
    return f"{prefix}: {text}", shifted

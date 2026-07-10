<p align="center">
  <img width="220" src="web/assets/favicon.ico" alt="Unified-Chat Logo">
</p>

<h1 align="center">Unified Chat LITE</h1>

<p align="center">
  <strong>Your multistream chat, finally in one place. 🎯</strong><br>
  One unified chat for Twitch, YouTube, Kick & Tiktok in a single clean feed.
</p><br>
<p align="center">
  👉<a href="https://unified-chat.com/">Try it here</a>
</p>
<br><p align="center" width="100%">
<a href="https://www.buymeacoffee.com/kimsec">
<img src="https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&amp;emoji=%E2%98%95&amp;slug=kimsec&amp;button_colour=FFDD00&amp;font_colour=000000&amp;font_family=Inter&amp;outline_colour=000000&amp;coffee_colour=ffffff" alt="Buy Me A Coffee"></a></p>

---

Zero-setup, read-only multi-platform chat viewer. A simplified spin-off of
[kimsec/unified-chat](https://github.com/kimsec/unified-chat) — no OAuth, no
self-hosting per user, no moderation/sending. Open
[unified-chat.com](https://unified-chat.com/), type up to four usernames
(Twitch / Kick / YouTube / TikTok) and watch the aggregated chat. Channels are
also shareable as links: `https://unified-chat.com/?twitch=channelname&kick=channelname`.

## Architecture

| Platform | Transport | Auth | Where it runs |
|----------|-----------|------|---------------|
| Twitch   | Anonymous IRC over WebSocket (`justinfan` nick) | none | Server-side |
| Kick     | Public Pusher WebSocket (`chatrooms.{id}.v2`) | none | Server WS + slug→chatroom_id lookup (Cloudflare, `curl_cffi`) |
| YouTube  | InnerTube `get_live_chat` polling | none | Server-side |
| TikTok   | Webcast via `TikTokLive` library | none (signing via Euler Stream) | Server-side |

The server keeps **one upstream connection per unique channel** (not per
viewer) and broadcasts to all connected viewers through an internal WebSocket
hub. All platforms are normalized into one message model:

```json
{ "platform": "twitch", "author": "...", "color": "#abc123", "badges": [], "text": "...", "timestamp": 0, "kind": "chat" }
```

Messages with `kind: "system"` are event notices rendered with a highlight
border: subs, resubs, gift subs, raids and cheers (Twitch `USERNOTICE` +
`bits` tag), subs/gifts/hosts (Kick Pusher events), and Super Chats, Super
Stickers, memberships and gifted memberships (YouTube InnerTube renderers).
All of these arrive on the same anonymous connections as regular chat.

## Privacy

This service stores **no data** — it is a pure pass-through proxy:

- Chat messages live only in memory: a rolling buffer of the last ~100
  messages per channel (so new viewers get instant history) plus what each
  browser holds on screen. Nothing is written to disk, no database, and a
  restart wipes everything.
- With the recommended flags (`--no-access-log --log-level warning`) the
  server logs no requests, no IP addresses and no watched channels.
- The browser's localStorage keeps only the visitor's own settings (channel
  names, toggles) — locally, on their machine, never sent anywhere.

## Repo layout

- `web/` — static frontend (no build step).
- `server/` — FastAPI proxy + shared-connection hub + platform connectors.

## Self-hosting

### Docker (recommended)

```
docker compose up -d --build
```

The app listens on port 8000 inside the container; `docker-compose.yml` maps
it to host port 8100 by default — change that to any free port, or delete the
`ports` block entirely if a cloudflared tunnel on the same Docker network
points at `http://unified-chat-lite:8000` (no host port needed at all).

### Local development (Windows)

```
python -m venv .venv
.venv\Scripts\pip install -r server\requirements.txt
.venv\Scripts\python -m uvicorn server.main:app --port 8080 --no-access-log --log-level warning
```

Then open http://localhost:8080 — the port is arbitrary; pick any free one.

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

Zero-setup, read-only multistream chat viewer — a simplified spin-off of
[kimsec/unified-chat](https://github.com/kimsec/unified-chat) with no OAuth,
no per-user hosting and no moderation/sending.

Open [unified-chat.com](https://unified-chat.com/), type up to four usernames
(Twitch / Kick / YouTube / TikTok) and watch the aggregated chat. Channels are
shareable as links: `https://unified-chat.com/?twitch=channelname&kick=channelname`.

## Features

- **Unified feed** — up to four chats in one view, with per-platform filters,
  timestamps and clickable links/emotes.
- **7TV / BTTV / FFZ emotes** — third-party Twitch emotes render automatically,
  no browser extension needed.
- **Twitch badges** — broadcaster, mod, VIP, sub and more, using Twitch's own
  badge art.
- **Popout** — chat-only window with your channels in the URL: bookmark it,
  make a desktop shortcut, or share the link — it works without the main page.
- **Stream player** — press ▶ in the popout to watch Twitch, Kick or YouTube
  (once live) above the chat. Starts muted; platform icons switch source.
- **OBS overlay** — swap `/popout` for `/overlay` in the link for a transparent
  browser source with auto-fading messages (see parameters below).
- **Event notices** — subs, resubs, gift subs, raids and cheers (Twitch),
  subs/gifts/hosts (Kick), Super Chats/Stickers and memberships (YouTube)
  render with a highlight border.
- **Installable (PWA)** — both the main page and the popout install as apps
  from the browser's address bar; the popout opens with your last used channels.
- **Efficient** — the server keeps one upstream connection per unique channel
  (not per viewer) and fans out through an internal WebSocket hub.

## Settings

All toggles live in the sidebar, are stored locally in the browser and sync
live to open popouts/overlays:

| Setting | Default | Does |
|---|---|---|
| Platform | on | platform icon in front of each message |
| User badges | on | Twitch badges (mod, sub, VIP...) |
| 7TV/BTTV/FFZ emotes | on | third-party emotes in Twitch chats |
| 24-hour clock | on | 24h vs 12h timestamps |

## OBS overlay parameters

Append to the overlay link, e.g.
`/overlay?twitch=channelname&fade=90&size=18&max=8`:

| Parameter | Default | Does |
|---|---|---|
| `fade=<s>` | 60 | seconds before a message fades out |
| `size=<px>` | – | text size |
| `align=right` | left | right-align messages |
| `max=<n>` | 200 | max messages on screen |
| `icons=0` | on | hide platform icons |

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
.venv\Scripts\python -m uvicorn server.main:app --port 8000 --no-access-log --log-level warning
```

Then open http://localhost:8000 — the port is arbitrary; pick any free one.

## License

[MIT](LICENSE)

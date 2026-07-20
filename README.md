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
  timestamps and clickable links/emotes. Messages that @-mention a connected
  channel are highlighted.
- **7TV / BTTV / FFZ emotes** — third-party Twitch emotes render automatically,
  no browser extension needed.
- **Twitch badges** — broadcaster, mod, VIP, sub and more, using Twitch's own
  badge art.
- **Expand** — one click fills the window with the chat; ✕ or Esc brings the
  page back. The state lives in the URL (`?expand=1`), so a bookmark or shared
  link opens straight into it.
- **Stream player** — press ▶ in the expanded chat to watch Twitch, Kick or
  YouTube (once live) above the chat. Starts muted; platform icons switch source.
- **Alert sounds** — paste your StreamElements/Streamlabs alert overlay URLs
  under Settings → Alert sounds and they play in the expanded chat. Stored
  only in your browser, never on the server.
- **OBS overlay** — use `/overlay?twitch=channelname` as a transparent
  browser source with auto-fading messages (see parameters below).
- **Event notices** — subs, resubs, gift subs, raids and cheers with animated
  cheermotes (Twitch), subs/gift subs/hosts/Kicks gifts (Kick), Super
  Chats/Stickers and memberships (YouTube) render with a highlight border.
- **Hype Train** — a live progress bar (level + %) appears when a Twitch hype
  train is rolling, and fades out when it ends.
- **Shared chat** — in Twitch dual streams, messages from the partner's chat
  show that streamer's avatar.
- **Installable (PWA)** — install as an app from the browser's address bar;
  it opens with your last used channels.
- **Efficient** — the server keeps one upstream connection per unique channel
  (not per viewer) and fans out through an internal WebSocket hub.

## Settings

All toggles live in the sidebar and are stored locally in the browser:

| Setting | Default | Does |
|---|---|---|
| Platform | on | platform icon in front of each message |
| User badges | on | Twitch badges (mod, sub, VIP...) |
| 7TV/BTTV/FFZ emotes | on | third-party emotes in Twitch chats |
| Highlight mentions | on | highlight messages @-mentioning a connected channel |
| 24-hour clock | on | 24h vs 12h timestamps |
| Text size | 16 px | chat text size |
| Alert sounds | – | alert overlay URLs whose sounds play in the expanded chat |

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

Save this as `docker-compose.yml`:

```yaml
services:
  unified-chat-lite:
    image: kim3k/unified-chat-lite:latest
    container_name: unified-chat-lite
    restart: unless-stopped
    ports:
      - "8100:8000"
```
Run `docker compose up -d`



## License

[MIT](LICENSE)

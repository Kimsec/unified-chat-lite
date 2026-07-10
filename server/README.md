# server/

FastAPI proxy + shared-connection hub.

```
server/
  main.py            # FastAPI app: static hosting + /ws viewer endpoint
  hub.py             # one upstream connection per unique channel, fan-out to viewers
  models.py          # normalized message model
  connectors/
    twitch.py        # anonymous justinfan IRC — one socket, JOIN/PART per channel
    kick.py          # public Pusher WS — one socket, subscribe per chatroom;
                     # slug→chatroom_id lookup via curl_cffi (Cloudflare)
    youtube.py       # InnerTube get_live_chat polling — one task per channel,
                     # auto-attaches when the channel goes live
    tiktok.py        # webcast via TikTokLive library — one client per channel;
                     # room-entry signing via Euler Stream (free tier)
```

Viewer protocol over `/ws` (JSON):

- client → server: `{"type": "subscribe", "channels": {"twitch": "...", "kick": "...", "youtube": "@..."}}`
  — the full desired set; the server diffs against current subscriptions.
- server → client: `bootstrap` (recent messages + statuses), then incremental
  `message`, `deleted` and `status` events.

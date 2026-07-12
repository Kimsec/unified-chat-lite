const isPopout = document.body.dataset.mode === "popout";

// Overlay mode (popout.html?overlay=1): a transparent, chrome-less variant of
// the popout for capturing chat directly in the stream image via an OBS
// browser source. Messages fade out after fade=<seconds> (default 60).
const pageParams = new URLSearchParams(window.location.search);
const isOverlay = isPopout && pageParams.has("overlay");
const OVERLAY_FADE_MS = Math.max(Number(pageParams.get("fade")) || 60, 5) * 1000;
if (isOverlay) {
  document.documentElement.classList.add("overlay-mode");
  document.documentElement.style.setProperty("--overlay-fade", `${OVERLAY_FADE_MS}ms`);
}

const state = {
  messages: [],
  statuses: new Map(),
  filters: {
    twitch: true,
    youtube: true,
    kick: true,
    tiktok: true,
  },
};
const MAX_VISIBLE_MESSAGES = 200;

const feedEl = document.getElementById("feed");
const statusGridEl = document.getElementById("status-grid");
const channelsFormEl = document.getElementById("channels-form");
const PLATFORMS = ["twitch", "kick", "youtube", "tiktok"];
const channelInputs = Object.fromEntries(PLATFORMS.map((p) => [p, document.getElementById(`channel-${p}`)]));
const channelClears = Object.fromEntries(PLATFORMS.map((p) => [p, document.getElementById(`clear-${p}`)]));

const PLATFORM_NAMES = { twitch: "Twitch", youtube: "YouTube", kick: "Kick", tiktok: "TikTok" };
const PLATFORM_SVGS = {
  twitch: `<svg viewBox="0 0 256 268" aria-hidden="true"><path fill="#9146ff" d="M17.46 0L0 46.56v185.21h63.14V268h46.87l36.49-36.23h54.91L256 177.68V0H17.46zm23.07 23.07H232.9v143.14l-41.47 41.47h-69.15L85.79 244.2v-36.52H40.53V23.07zm69.15 104.55h23.07V69.26h-23.07v58.36zm63.14 0h23.07V69.26h-23.07v58.36z"/></svg>`,
  youtube: `<svg viewBox="0 0 576 512" aria-hidden="true"><path fill="#ff0000" d="M549.66 124.63a68.28 68.28 0 0 0-48.05-48.28C458.78 64 288 64 288 64S117.22 64 74.39 76.35a68.28 68.28 0 0 0-48.05 48.28C14.48 167.83 14.48 256 14.48 256s0 88.17 11.86 131.37a68.28 68.28 0 0 0 48.05 48.28C117.22 448 288 448 288 448s170.78 0 213.61-12.35a68.28 68.28 0 0 0 48.05-48.28C561.52 344.17 561.52 256 561.52 256s0-88.17-11.86-131.37zM232.15 337.28V174.72L374.86 256l-142.71 81.28z"/></svg>`,
  kick: `<img src="assets/kick-logo.ico" aria-hidden="true">`,
  tiktok: `<svg viewBox="0 0 448 512" aria-hidden="true"><path fill="#eef4ff" d="M448,209.91a210.06,210.06,0,0,1-122.77-39.25V349.38A162.55,162.55,0,1,1,185,188.31V278.2a74.62,74.62,0,1,0,52.23,71.18V0l88,0a121.18,121.18,0,0,0,1.86,22.17h0A122.18,122.18,0,0,0,381,102.39a121.43,121.43,0,0,0,67,20.14Z"/></svg>`,
};

// Platform pill names are opt-in (off by default).
const PLATFORM_NAMES_STORAGE_KEY = "showPlatformNames";
let showPlatformNames = readPlatformNamesPreference();

function readPlatformNamesPreference() {
  try {
    return window.localStorage.getItem(PLATFORM_NAMES_STORAGE_KEY) === "true";
  } catch (_) {
    return false;
  }
}

function platformMarkup(platform) {
  const name = showPlatformNames ? `<span class="platform-name">${PLATFORM_NAMES[platform]}</span>` : "";
  return `<span class="platform-pill ${platform}">${PLATFORM_SVGS[platform]}${name}</span>`;
}

// ---------------------------------------------------------------------------
// Author colors: platform colors are chosen against arbitrary backgrounds, so
// lighten them until they meet a minimum contrast ratio against our dark bg.

const AUTHOR_COLOR_BG = "#09111f";
const MIN_AUTHOR_CONTRAST = 4.0;

function parseHexColor(value) {
  if (!value) return null;
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value).trim());
  if (!match) return null;
  const hex = `#${match[1].toLowerCase()}`;
  const n = parseInt(match[1], 16);
  return {
    r: (n >> 16) & 0xff,
    g: (n >> 8) & 0xff,
    b: n & 0xff,
    hex,
  };
}

const AUTHOR_COLOR_BG_RGB = parseHexColor(AUTHOR_COLOR_BG);

function srgbChannelToLinear(channel) {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb) {
  return (
    0.2126 * srgbChannelToLinear(rgb.r) +
    0.7152 * srgbChannelToLinear(rgb.g) +
    0.0722 * srgbChannelToLinear(rgb.b)
  );
}

function contrastRatio(fg, bg) {
  const fgLum = relativeLuminance(fg);
  const bgLum = relativeLuminance(bg);
  const lighter = Math.max(fgLum, bgLum);
  const darker = Math.min(fgLum, bgLum);
  return (lighter + 0.05) / (darker + 0.05);
}

function mixTowardWhite(rgb, amount) {
  return {
    r: Math.round(rgb.r + (255 - rgb.r) * amount),
    g: Math.round(rgb.g + (255 - rgb.g) * amount),
    b: Math.round(rgb.b + (255 - rgb.b) * amount),
  };
}

function rgbToHex(rgb) {
  return `#${((rgb.r << 16) | (rgb.g << 8) | rgb.b).toString(16).padStart(6, "0")}`;
}

function ensureReadableColor(value) {
  const color = parseHexColor(value);
  if (!color || !AUTHOR_COLOR_BG_RGB) return "";
  if (contrastRatio(color, AUTHOR_COLOR_BG_RGB) >= MIN_AUTHOR_CONTRAST) return color.hex;

  let low = 0;
  let high = 1;
  for (let i = 0; i < 8; i += 1) {
    const mid = (low + high) / 2;
    const candidate = mixTowardWhite(color, mid);
    if (contrastRatio(candidate, AUTHOR_COLOR_BG_RGB) >= MIN_AUTHOR_CONTRAST) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return rgbToHex(mixTowardWhite(color, high));
}

// ---------------------------------------------------------------------------
// Text rendering

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const URL_REGEX = /\bhttps?:\/\/[^\s<>"']+/g;
const TRAILING_PUNCT = /[.,;:!?)\]}]+$/;

function linkifyText(text) {
  if (!text) return "";
  let result = "";
  let last = 0;
  URL_REGEX.lastIndex = 0;
  let match;
  while ((match = URL_REGEX.exec(text)) !== null) {
    let url = match[0];
    let trailing = "";
    const trail = url.match(TRAILING_PUNCT);
    if (trail) {
      trailing = trail[0];
      url = url.slice(0, -trailing.length);
    }
    result += escapeHtml(text.slice(last, match.index));
    const escaped = escapeHtml(url);
    result += `<a href="${escaped}" target="_blank" rel="noopener noreferrer" class="message-link">${escaped}</a>`;
    result += escapeHtml(trailing);
    last = match.index + match[0].length;
  }
  result += escapeHtml(text.slice(last));
  return result;
}

const EMOTE_IMAGE_URLS = {
  twitch: (id) => `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/1.0`,
  kick: (id) => `https://files.kick.com/emotes/${encodeURIComponent(id)}/fullsize`,
  youtube: (id) => id, // YouTube emote ids are complete image URLs
};

// Emote begin/end offsets count Unicode code points (Twitch IRC convention),
// so slice on a code-point array rather than UTF-16 indices.
function renderMessageText(text, emotes, platform) {
  if (!emotes || !emotes.length) return linkifyText(text);
  const emoteUrl = EMOTE_IMAGE_URLS[platform] || EMOTE_IMAGE_URLS.twitch;
  const chars = Array.from(text);
  const sorted = [...emotes].sort((a, b) => a.begin - b.begin);
  let result = "";
  let cursor = 0;
  for (const emote of sorted) {
    if (emote.begin > cursor) {
      result += linkifyText(chars.slice(cursor, emote.begin).join(""));
    }
    result += `<img class="emote" src="${escapeHtml(emoteUrl(emote.id))}" alt="${escapeHtml(emote.text)}" title="${escapeHtml(emote.text)}">`;
    cursor = emote.end;
  }
  if (cursor < chars.length) {
    result += linkifyText(chars.slice(cursor).join(""));
  }
  return result;
}

// 24-hour clock by default; switchable in Settings.
const CLOCK_STORAGE_KEY = "use24hClock";
let use24hClock = readClockPreference();

function readClockPreference() {
  try {
    return window.localStorage.getItem(CLOCK_STORAGE_KEY) !== "false";
  } catch (_) {
    return true;
  }
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: !use24hClock,
  });
}

// ---------------------------------------------------------------------------
// Cross-window sync (main window -> popouts) over a BroadcastChannel.
// Popouts feed themselves from their own hub connection; the main window only
// pushes channel changes and settings so open popouts follow along.

const syncChannel = typeof BroadcastChannel !== "undefined"
  ? new BroadcastChannel("unified-chat-lite-sync")
  : null;

function broadcast(payload) {
  syncChannel?.postMessage(payload);
}

function applyPlatformNames(value) {
  showPlatformNames = Boolean(value);
  if (toggleNames) {
    toggleNames.classList.toggle("active", showPlatformNames);
  }
  renderStatuses();
  renderMessages();
}

if (syncChannel) {
  syncChannel.addEventListener("message", (event) => {
    const payload = event.data;
    if (!payload || typeof payload !== "object") return;
    if (!isPopout) return;

    switch (payload.type) {
      case "channels":
        applyPopoutChannels(payload.channels);
        break;
      case "clear":
        state.messages = [];
        renderMessages();
        break;
      case "showPlatformNames":
        applyPlatformNames(payload.value);
        break;
      case "use24hClock":
        use24hClock = Boolean(payload.value);
        renderMessages();
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// Feed rendering

function addMessage(message) {
  state.messages.push(message);
  if (state.messages.length > MAX_VISIBLE_MESSAGES) {
    state.messages = state.messages.slice(-MAX_VISIBLE_MESSAGES);
  }
  renderMessages();
}

function markDeleted(predicate) {
  const deletedIds = [];
  for (const message of state.messages) {
    if (predicate(message) && !message.deleted) {
      message.deleted = true;
      deletedIds.push(message.id);
    }
  }
  if (!deletedIds.length) return;
  renderMessages();
}

// In overlay mode every card runs the fade-out animation; a negative delay
// makes rebuilt DOM nodes resume at the right point of their lifetime instead
// of restarting the countdown on every render.
function overlayFadeStyle(message) {
  if (!isOverlay) return "";
  const age = Math.max(Date.now() - new Date(message.timestamp).getTime(), 0);
  return ` style="animation-delay: -${age}ms"`;
}

function renderMessages() {
  const visibleMessages = state.messages.filter((message) => state.filters[message.platform] !== false);

  if (!visibleMessages.length) {
    feedEl.innerHTML = `<div class="empty-state">No messages yet. Connect to a channel to get started.</div>`;
    return;
  }

  const wasNearBottom = isNearBottom();

  feedEl.innerHTML = visibleMessages.map((message) => {
    const messageClass = message.deleted ? "message-card deleted" : "message-card";
    if (message.kind === "system") {
      return `
        <article class="${messageClass} system-notice" data-platform="${message.platform}"${overlayFadeStyle(message)}>
          <span class="message-topline"><span class="message-time">${formatTime(message.timestamp)}</span> ${platformMarkup(message.platform)}<span class="message-text system-notice-text">${renderMessageText(message.text, message.emotes, message.platform)}</span></span>
        </article>
      `;
    }
    const readableColor = ensureReadableColor(message.color);
    const authorStyle = readableColor ? `style="color:${readableColor}"` : "";
    return `
      <article class="${messageClass}" data-platform="${message.platform}"${overlayFadeStyle(message)}>
        <span class="message-topline"><span class="message-time">${formatTime(message.timestamp)}</span> ${platformMarkup(message.platform)}<span class="author-name" ${authorStyle}>${escapeHtml(message.author)}:</span> <span class="message-text">${renderMessageText(message.text, message.emotes, message.platform)}</span></span>
      </article>
    `;
  }).join("");

  requestAnimationFrame(() => {
    if (wasNearBottom) {
      feedEl.scrollTop = feedEl.scrollHeight;
    }
  });
}

function isNearBottom() {
  return feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 100;
}

const scrollBottomBtn = document.getElementById("scroll-bottom");

feedEl.addEventListener("scroll", () => {
  scrollBottomBtn.classList.toggle("hidden", isNearBottom());
});

scrollBottomBtn.addEventListener("click", () => {
  feedEl.scrollTop = feedEl.scrollHeight;
});

// ---------------------------------------------------------------------------
// Status panel (main window only)

function setStatus(platform, dot, stateText, detail, videoId) {
  state.statuses.set(platform, { platform, dot, state: stateText, detail, video_id: videoId });
  renderStatuses();
  // The YouTube embed depends on the live video id carried by statuses, so
  // the player may gain/lose that source when one arrives.
  if (platform === "youtube") renderPlayer();
}

function renderStatuses() {
  if (!statusGridEl) return;
  const statuses = ["twitch", "youtube", "kick", "tiktok"].map((platform) =>
    state.statuses.get(platform) || { platform, dot: "idle", state: "idle", detail: "Not connected" }
  );
  statusGridEl.innerHTML = statuses.map((status) => `
    <article class="status-card">
      ${platformMarkup(status.platform)}
      <span class="status-detail" title="${escapeHtml(status.detail || "")}">${escapeHtml(status.detail || status.state || "")}</span>
      <span class="status-dot ${status.dot}" aria-hidden="true"></span>
    </article>
  `).join("");
}

// ---------------------------------------------------------------------------
// Hub connection: the server keeps one upstream connection per unique channel
// and fans out normalized events; this client just subscribes and renders.

class HubConnection {
  constructor() {
    this.socket = null;
    this.desired = null;
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
  }

  setChannels(channels) {
    this.desired = channels;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendSubscribe();
    } else if (!this.socket) {
      this.open();
    }
    // CONNECTING: the open handler sends the latest desired set.
  }

  sendSubscribe() {
    this.socket.send(JSON.stringify({ type: "subscribe", channels: this.desired }));
  }

  open() {
    clearTimeout(this.reconnectTimer);
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectDelay = 1000;
      if (this.desired) this.sendSubscribe();
    });

    socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      this.handlePayload(payload);
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const [platform, channel] of Object.entries(this.desired || {})) {
        if (channel) {
          setStatus(platform, "error", "disconnected", `Hub connection lost, retrying in ${Math.round(this.reconnectDelay / 1000)}s…`);
        }
      }
      this.reconnectTimer = setTimeout(() => this.open(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    });
  }

  handlePayload(payload) {
    if (!payload || typeof payload !== "object") return;
    switch (payload.type) {
      case "bootstrap":
        state.messages = payload.messages.slice(-MAX_VISIBLE_MESSAGES);
        state.statuses.clear();
        for (const status of payload.statuses) {
          setStatus(status.platform, status.dot, status.state, status.detail, status.video_id);
        }
        renderStatuses(); // even when statuses is empty (everything disconnected)
        renderMessages();
        break;
      case "message":
        addMessage(payload.message);
        break;
      case "deleted":
        markDeleted((m) => payload.ids.includes(m.id));
        break;
      case "status":
        setStatus(payload.status.platform, payload.status.dot, payload.status.state, payload.status.detail, payload.status.video_id);
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Wiring. Elements that only exist on index.html are guarded so this file can
// be shared with popout.html.

const toggleNames = document.getElementById("toggle-platform-names");
const hubConnection = new HubConnection();

function connectFromInputs({ updateUrl = true } = {}) {
  // An empty field is sent as "" — the server diffs the desired set and
  // disconnects that platform (the shared upstream is released after a short
  // linger, in case someone reconnects).
  const channels = {};
  for (const platform of PLATFORMS) {
    channels[platform] = channelInputs[platform].value.trim();
  }
  const hasAny = Object.values(channels).some(Boolean);
  if (!hasAny && !hubConnection.socket) return;
  hubConnection.setChannels(channels);
  updateClearButtons(channels);
  broadcast({ type: "channels", channels });
  try {
    window.localStorage.setItem("channels", JSON.stringify(channels));
  } catch (_) {}
  if (updateUrl) {
    const params = new URLSearchParams(window.location.search);
    for (const [platform, channel] of Object.entries(channels)) {
      if (channel) {
        params.set(platform, channel);
      } else {
        params.delete(platform);
      }
    }
    const query = params.toString();
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
  }
}

// The red ✕ shows only on rows with an active connection; clicking it stops
// that connector and clears the field, ready for a new name.
function updateClearButtons(channels) {
  for (const platform of PLATFORMS) {
    channelClears[platform]?.classList.toggle("hidden", !channels[platform]);
  }
}

if (channelsFormEl) {
  channelsFormEl.addEventListener("submit", (event) => {
    event.preventDefault();
    connectFromInputs();
  });
  for (const [platform, button] of Object.entries(channelClears)) {
    button?.addEventListener("click", () => {
      channelInputs[platform].value = "";
      connectFromInputs();
    });
  }
  // Enter in any channel field connects right away — handy for adding one
  // more chat while others are already running.
  for (const input of Object.values(channelInputs)) {
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        connectFromInputs();
      }
    });
  }
}

document.querySelectorAll(".filter-button[data-platform]").forEach((button) => {
  button.addEventListener("click", () => {
    const platform = button.dataset.platform;
    state.filters[platform] = !state.filters[platform];
    button.classList.toggle("active", state.filters[platform]);
    renderMessages();
  });
});

const clearBtn = document.getElementById("clear-messages");
if (clearBtn) {
  clearBtn.addEventListener("click", () => {
    state.messages = [];
    renderMessages();
    broadcast({ type: "clear" });
  });
}

const popoutBtn = document.getElementById("popout-chat");
if (popoutBtn) {
  popoutBtn.addEventListener("click", () => {
    // Channels ride along in the URL so the popout can be bookmarked or used
    // as a desktop shortcut / OBS browser source without the main window.
    const params = new URLSearchParams();
    for (const platform of PLATFORMS) {
      const channel = channelInputs[platform].value.trim();
      if (channel) params.set(platform, channel);
    }
    const query = params.toString();
    window.open(`popout.html${query ? `?${query}` : ""}`, "unified-chat-lite-popout", "width=500,height=800,resizable=yes,scrollbars=no");
  });
}

// "More info" overlay (main window only): quick usage tips, closed via the ✕,
// a click on the backdrop, or Escape.
const infoOverlayEl = document.getElementById("info-overlay");
const openInfoBtn = document.getElementById("open-info");
if (infoOverlayEl && openInfoBtn) {
  const closeInfo = () => infoOverlayEl.classList.add("hidden");
  openInfoBtn.addEventListener("click", () => infoOverlayEl.classList.remove("hidden"));
  document.getElementById("close-info").addEventListener("click", closeInfo);
  infoOverlayEl.addEventListener("click", (event) => {
    if (event.target === infoOverlayEl) closeInfo();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !infoOverlayEl.classList.contains("hidden")) closeInfo();
  });
}

const toggleClock = document.getElementById("toggle-clock");
if (toggleClock) {
  toggleClock.classList.toggle("active", use24hClock);
  toggleClock.addEventListener("click", () => {
    use24hClock = !use24hClock;
    toggleClock.classList.toggle("active", use24hClock);
    try {
      window.localStorage.setItem(CLOCK_STORAGE_KEY, String(use24hClock));
    } catch (_) {}
    renderMessages();
    broadcast({ type: "use24hClock", value: use24hClock });
  });
}

if (toggleNames) {
  toggleNames.classList.toggle("active", showPlatformNames);
  toggleNames.addEventListener("click", () => {
    showPlatformNames = !showPlatformNames;
    toggleNames.classList.toggle("active", showPlatformNames);
    try {
      window.localStorage.setItem(PLATFORM_NAMES_STORAGE_KEY, String(showPlatformNames));
    } catch (_) {}
    renderStatuses();
    renderMessages();
    broadcast({ type: "showPlatformNames", value: showPlatformNames });
  });
}

// ---------------------------------------------------------------------------
// Stream player (popout only): an embedded player docked above the feed,
// starting muted. Twitch, Kick and YouTube have embed players; TikTok has
// none. YouTube embeds by live video id, which the server discovers when the
// chat connects and ships on the status payload — so YouTube only becomes
// pickable once the channel is actually live. Note: the Twitch embed requires
// the page to be served over HTTPS (localhost excepted) — plain
// http://<lan-ip> will show a blank player for Twitch, while the others work.

const PLAYER_STORAGE_KEY = "popoutPlayer";
const PLAYER_PLATFORMS = ["twitch", "kick", "youtube"];

// Returns the embed URL for a platform, or null when it can't be played
// right now (no channel connected, or YouTube without a live video id yet).
function playerEmbedSrc(platform) {
  const channel = playerState.channels[platform];
  if (!channel) return null;
  switch (platform) {
    case "twitch":
      return `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${encodeURIComponent(window.location.hostname)}&muted=true&autoplay=true`;
    case "kick":
      return `https://player.kick.com/${encodeURIComponent(channel)}?muted=true&autoplay=true`;
    case "youtube": {
      const videoId = state.statuses.get("youtube")?.video_id;
      return videoId
        ? `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&mute=1`
        : null;
    }
  }
  return null;
}

const playerPaneEl = document.getElementById("player-pane");
const playerFrameEl = document.getElementById("player-frame");
const playerToggleEl = document.getElementById("player-toggle");
const playerSourcesEl = document.getElementById("player-sources");

const playerState = { open: false, source: null, channels: {} };
try {
  const stored = JSON.parse(window.localStorage.getItem(PLAYER_STORAGE_KEY) || "{}");
  playerState.open = Boolean(stored.open);
  playerState.source = stored.source || null;
} catch (_) {}

function savePlayerState() {
  try {
    window.localStorage.setItem(
      PLAYER_STORAGE_KEY,
      JSON.stringify({ open: playerState.open, source: playerState.source })
    );
  } catch (_) {}
}

function renderPlayer() {
  if (!playerPaneEl || isOverlay) return; // no player inside an OBS overlay
  const available = PLAYER_PLATFORMS.filter((platform) => playerEmbedSrc(platform) !== null);
  if (!available.includes(playerState.source)) {
    playerState.source = available[0] || null;
  }

  playerSourcesEl.classList.toggle("hidden", !playerState.open || !available.length);
  playerSourcesEl.innerHTML = available.map((platform) => `
    <button class="player-source${platform === playerState.source ? " active" : ""}" data-platform="${platform}"
      type="button" title="Watch on ${PLATFORM_NAMES[platform]}">${PLATFORM_SVGS[platform]}</button>
  `).join("");

  playerToggleEl.textContent = playerState.open ? "✕" : "▶";
  playerToggleEl.title = playerState.open ? "Close stream player" : "Show stream player";
  playerPaneEl.classList.toggle("hidden", !playerState.open);

  if (!playerState.open) {
    playerFrameEl.innerHTML = ""; // drop the iframe so playback (and audio) stops
    return;
  }
  if (!playerState.source) {
    playerFrameEl.innerHTML = `<div class="player-empty">Connect a live Twitch, Kick or YouTube channel to watch the stream here.</div>`;
    return;
  }
  const src = playerEmbedSrc(playerState.source);
  // Only swap the iframe when the target actually changed — a reload means a
  // fresh player (and on Twitch potentially a new pre-roll ad).
  if (playerFrameEl.querySelector("iframe")?.src === src) return;
  playerFrameEl.innerHTML = `<iframe src="${escapeHtml(src)}" allow="autoplay; fullscreen" allowfullscreen></iframe>`;
}

if (playerToggleEl) {
  playerToggleEl.addEventListener("click", () => {
    playerState.open = !playerState.open;
    savePlayerState();
    renderPlayer();
  });
  playerSourcesEl.addEventListener("click", (event) => {
    const button = event.target.closest(".player-source");
    if (!button) return;
    playerState.source = button.dataset.platform;
    savePlayerState();
    renderPlayer();
  });
}

function channelsFromLocation() {
  const params = new URLSearchParams(window.location.search);
  let stored = {};
  try {
    stored = JSON.parse(window.localStorage.getItem("channels") || "{}");
  } catch (_) {}
  // A shared link (URL params) wins over what this browser last watched.
  const fromUrl = PLATFORMS.some((platform) => params.has(platform));
  return Object.fromEntries(
    PLATFORMS.map((platform) => [platform, ((fromUrl ? params.get(platform) : stored[platform]) || "").trim()])
  );
}

function restoreChannels() {
  const channels = channelsFromLocation();
  for (const platform of PLATFORMS) {
    channelInputs[platform].value = channels[platform];
  }
  if (PLATFORMS.some((platform) => channelInputs[platform].value)) {
    connectFromInputs({ updateUrl: false });
  }
}

// Subscribes the popout's own hub connection and mirrors the channels into the
// URL, so the address bar always holds a working standalone link.
function applyPopoutChannels(channels) {
  hubConnection.setChannels(channels);
  playerState.channels = channels;
  renderPlayer();
  // Start from the current query so non-channel params (overlay, fade) survive.
  const params = new URLSearchParams(window.location.search);
  for (const platform of PLATFORMS) {
    if (channels[platform]) {
      params.set(platform, channels[platform]);
    } else {
      params.delete(platform);
    }
  }
  const query = params.toString();
  window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
}

renderMessages();

if (isPopout) {
  const channels = channelsFromLocation();
  if (Object.values(channels).some(Boolean)) {
    applyPopoutChannels(channels);
  } else {
    renderPlayer(); // restore the toggle/open state even with nothing to watch
  }
  if (isOverlay) {
    // Prune messages the fade animation has already hidden so the DOM stays
    // small during long streams.
    setInterval(() => {
      const cutoff = Date.now() - OVERLAY_FADE_MS;
      const kept = state.messages.filter((message) => new Date(message.timestamp).getTime() >= cutoff);
      if (kept.length !== state.messages.length) {
        state.messages = kept;
        renderMessages();
      }
    }, 1000);
  }
} else {
  renderStatuses();
  restoreChannels();
}

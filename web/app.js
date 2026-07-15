const isPopout = document.body.dataset.mode === "popout";

// Overlay mode (/overlay): transparent OBS variant with auto-fading messages.
const pageParams = new URLSearchParams(window.location.search);
const isOverlay = isPopout && (window.location.pathname === "/overlay" || pageParams.has("overlay"));
const OVERLAY_FADE_MS = Math.max(Number(pageParams.get("fade")) || 60, 5) * 1000;
const OVERLAY_FADE_OUT_MS = 2500;
const overlayOptions = {
  size: Math.min(Math.max(Number(pageParams.get("size")) || 0, 0), 64),
  alignRight: pageParams.get("align") === "right",
  max: Math.min(Math.max(Number(pageParams.get("max")) || 0, 0), 200),
  icons: pageParams.get("icons") !== "0",
};
if (isOverlay) {
  const root = document.documentElement;
  root.classList.add("overlay-mode");
  if (overlayOptions.size) root.style.setProperty("--overlay-font", `${overlayOptions.size}px`);
  if (overlayOptions.alignRight) root.classList.add("overlay-align-right");
  if (!overlayOptions.icons) root.classList.add("overlay-no-icons");
}

// Expand (?expand=1): the main page expands into the popout layout in place.
let isExpanded = !isPopout && (pageParams.get("expand") ?? "0") !== "0";
document.documentElement.classList.toggle("expand-mode", isExpanded);

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
const MAX_VISIBLE_MESSAGES = isOverlay && overlayOptions.max ? overlayOptions.max : 200;

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
  kick: `<img src="assets/kick-logo.ico" alt="" aria-hidden="true">`,
  tiktok: `<svg viewBox="0 0 448 512" aria-hidden="true"><path fill="#eef4ff" d="M448,209.91a210.06,210.06,0,0,1-122.77-39.25V349.38A162.55,162.55,0,1,1,185,188.31V278.2a74.62,74.62,0,1,0,52.23,71.18V0l88,0a121.18,121.18,0,0,0,1.86,22.17h0A122.18,122.18,0,0,0,381,102.39a121.43,121.43,0,0,0,67,20.14Z"/></svg>`,
};

// Platform icon in messages is opt-out.
const PLATFORM_STORAGE_KEY = "showPlatform";
let showPlatform = readPlatformPreference();

function readPlatformPreference() {
  try {
    return window.localStorage.getItem(PLATFORM_STORAGE_KEY) !== "false";
  } catch (_) {
    return true;
  }
}

function platformMarkup(platform) {
  return `<span class="platform-pill ${platform}">${PLATFORM_SVGS[platform]}</span>`;
}

const TWITCH_BADGE_IDS = {
  broadcaster: "5527c58c-fb7d-422d-b71b-f309dcb85cc1",
  moderator: "3267646d-33f0-4b17-b3df-f923a41db1d0",
  vip: "b817aba4-fad8-49e2-b88a-7cc744dfa6ec",
  partner: "d12a2e27-16f6-41d0-ab77-b780518f00a3",
  subscriber: "5d9f2208-5dd8-11e7-8513-2ff4adfae661",
  founder: "511b78a9-ab37-472f-9569-457753bbe7d3",
  premium: "bbbe0db0-a598-423e-86d0-f9fb98ca1933",
  turbo: "bd444ec6-8f34-4bf9-91f4-af1e3428d80f",
  staff: "d97c37bd-a6f5-4c38-8f57-4e4bef88af34",
  "sub-gifter": "f1d8486f-eb2e-4553-b44f-4d614617afc1",
};

const BADGES_STORAGE_KEY = "showBadges";
let showBadges = readBadgesPreference();

function readBadgesPreference() {
  try {
    return window.localStorage.getItem(BADGES_STORAGE_KEY) !== "false";
  } catch (_) {
    return true;
  }
}

function sourceAvatarMarkup(message) {
  if (!message.avatar_url) return "";
  const title = message.source_name ? `${message.source_name}'s chat` : "Shared chat source";
  return `<img class="source-streamer-avatar" src="${escapeHtml(message.avatar_url)}" alt="" title="${escapeHtml(title)}">`;
}

function badgesMarkup(message) {
  if (!showBadges || message.platform !== "twitch" || !message.badges?.length) return "";
  return message.badges.map((badge) => {
    const name = String(badge).split("/")[0].toLowerCase();
    const id = TWITCH_BADGE_IDS[name];
    if (!id) return "";
    return `<img class="badge" src="https://static-cdn.jtvnw.net/badges/v1/${id}/1" alt="${escapeHtml(name)}" title="${escapeHtml(name)}">`;
  }).join("");
}


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

// Third-party Twitch emotes (7TV/BTTV/FFZ), name → url, sent by the hub.
let thirdPartyEmotes = new Map();

const THIRD_PARTY_EMOTES_STORAGE_KEY = "showThirdPartyEmotes";
let showThirdPartyEmotes = readThirdPartyEmotesPreference();

function readThirdPartyEmotesPreference() {
  try {
    return window.localStorage.getItem(THIRD_PARTY_EMOTES_STORAGE_KEY) !== "false";
  } catch (_) {
    return true;
  }
}

function emoteImg(url, name) {
  return `<img class="emote" src="${escapeHtml(url)}" alt="${escapeHtml(name)}" title="${escapeHtml(name)}">`;
}

// Global cheermotes from Twitch's open CDN, only applied to messages that
// actually carried bits.
const CHEERMOTE_PREFIXES = new Set([
  "cheer", "cheerwhal", "corgo", "uni", "showlove", "party", "seemsgood", "pride",
  "kappa", "frankerz", "heyguys", "dansgame", "trihard", "kreygasm", "4head",
  "swiftrage", "notlikethis", "failfish", "vohiyo", "pjsalt", "mrdestructoid",
  "bday", "ripcheer", "shamrock",
]);
const CHEER_TIERS = [
  [10000, "#f43021"],
  [5000, "#0099fe"],
  [1000, "#1db2a5"],
  [100, "#9c3ee8"],
  [1, "#979797"],
];

function cheermoteMarkup(word) {
  const match = /^(.+?)(\d+)$/.exec(word);
  if (!match) return null;
  const prefix = match[1].toLowerCase();
  if (!CHEERMOTE_PREFIXES.has(prefix)) return null;
  const amount = Number(match[2]);
  const [tier, color] = CHEER_TIERS.find(([min]) => amount >= min) || CHEER_TIERS[CHEER_TIERS.length - 1];
  const src = `https://d3aqoihi2n8ty8.cloudfront.net/actions/${prefix}/dark/animated/${tier}/1.gif`;
  return `<img class="emote" src="${src}" alt="${escapeHtml(word)}" title="${escapeHtml(word)}"><span class="cheer-amount" style="color:${color}">${amount}</span>`;
}

function renderPlainText(text, platform, bits) {
  if (platform !== "twitch") return linkifyText(text);
  const useEmotes = showThirdPartyEmotes && thirdPartyEmotes.size;
  if (!useEmotes && !bits) return linkifyText(text);
  return text.split(" ").map((word) => {
    if (bits) {
      const cheer = cheermoteMarkup(word);
      if (cheer) return cheer;
    }
    const url = useEmotes ? thirdPartyEmotes.get(word) : undefined;
    return url ? emoteImg(url, word) : linkifyText(word);
  }).join(" ");
}


function renderMessageText(text, emotes, platform, bits = 0) {
  if (!emotes || !emotes.length) return renderPlainText(text, platform, bits);
  const emoteUrl = EMOTE_IMAGE_URLS[platform] || EMOTE_IMAGE_URLS.twitch;
  const chars = Array.from(text);
  const sorted = [...emotes].sort((a, b) => a.begin - b.begin);
  let result = "";
  let cursor = 0;
  for (const emote of sorted) {
    if (emote.begin > cursor) {
      result += renderPlainText(chars.slice(cursor, emote.begin).join(""), platform, bits);
    }
    result += emoteImg(emoteUrl(emote.id), emote.text);
    cursor = emote.end;
  }
  if (cursor < chars.length) {
    result += renderPlainText(chars.slice(cursor).join(""), platform, bits);
  }
  return result;
}

const CHAT_FONT_STORAGE_KEY = "chatFontPx";
let chatFontPx = readChatFontPreference();

function readChatFontPreference() {
  try {
    return Number(window.localStorage.getItem(CHAT_FONT_STORAGE_KEY)) || 0;
  } catch (_) {
    return 0;
  }
}

function applyChatFont(px) {
  chatFontPx = px;
  if (px) {
    document.documentElement.style.setProperty("--chat-font", `${px}px`);
  } else {
    document.documentElement.style.removeProperty("--chat-font");
  }
}

applyChatFont(chatFontPx);

// Messages @-mentioning a connected channel get highlighted.
const MENTIONS_STORAGE_KEY = "highlightMentions";
let highlightMentions = readMentionsPreference();
let mentionRegex = null;

function readMentionsPreference() {
  try {
    return window.localStorage.getItem(MENTIONS_STORAGE_KEY) !== "false";
  } catch (_) {
    return true;
  }
}

function updateMentionRegex(channels) {
  const names = Object.values(channels)
    .filter(Boolean)
    .map((name) => name.replace(/^@/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  mentionRegex = names.length ? new RegExp(`@(?:${names.join("|")})\\b`, "i") : null;
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

// Cross-window sync (main window -> popouts) over a BroadcastChannel.
const syncChannel = typeof BroadcastChannel !== "undefined"
  ? new BroadcastChannel("unified-chat-lite-sync")
  : null;

function broadcast(payload) {
  syncChannel?.postMessage(payload);
}

function applyShowPlatform(value) {
  showPlatform = Boolean(value);
  if (togglePlatform) {
    togglePlatform.classList.toggle("active", showPlatform);
  }
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
      case "showPlatform":
        applyShowPlatform(payload.value);
        break;
      case "showBadges":
        showBadges = Boolean(payload.value);
        renderMessages();
        break;
      case "showThirdPartyEmotes":
        showThirdPartyEmotes = Boolean(payload.value);
        renderMessages();
        break;
      case "chatFont":
        applyChatFont(Number(payload.value) || 0);
        break;
      case "highlightMentions":
        highlightMentions = Boolean(payload.value);
        renderMessages();
        break;
      case "alertUrls":
        applyPopoutAlerts(payload.urls);
        break;
      case "use24hClock":
        use24hClock = Boolean(payload.value);
        renderMessages();
        break;
    }
  });
}

function addMessage(message) {
  const wasNearBottom = isNearBottom();
  state.messages.push(message);
  if (state.messages.length > MAX_VISIBLE_MESSAGES) {
    state.messages = state.messages.slice(-MAX_VISIBLE_MESSAGES);
  }
  renderMessages();
  if (!wasNearBottom) {
    unseenCount += 1;
    updateScrollButton();
  }
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

// Negative delay resumes the fade mid-life after a DOM rebuild.
function overlayFadeStyle(message) {
  if (!isOverlay) return "";
  const age = Math.max(Date.now() - new Date(message.timestamp).getTime(), 0);
  return ` style="animation-delay: ${OVERLAY_FADE_MS - OVERLAY_FADE_OUT_MS - age}ms"`;
}

function renderMessages() {
  const visibleMessages = state.messages.filter((message) => state.filters[message.platform] !== false);

  if (!visibleMessages.length) {
    feedEl.innerHTML = `<div class="empty-state">No messages yet. Connect to a channel to get started.</div>`;
    return;
  }

  const wasNearBottom = isNearBottom();

  feedEl.innerHTML = visibleMessages.map((message) => {
    let messageClass = message.deleted ? "message-card deleted" : "message-card";
    if (highlightMentions && message.kind !== "system" && mentionRegex?.test(message.text)) {
      messageClass += " mention";
    }
    if (message.kind === "system") {
      return `
        <article class="${messageClass} system-notice" data-platform="${message.platform}"${overlayFadeStyle(message)}>
          <span class="message-topline"><span class="message-time">${formatTime(message.timestamp)}</span> ${showPlatform ? platformMarkup(message.platform) : ""}${sourceAvatarMarkup(message)}<span class="message-text system-notice-text">${renderMessageText(message.text, message.emotes, message.platform, message.bits)}</span></span>
        </article>
      `;
    }
    const readableColor = ensureReadableColor(message.color);
    const authorStyle = readableColor ? `style="color:${readableColor}"` : "";
    return `
      <article class="${messageClass}" data-platform="${message.platform}"${overlayFadeStyle(message)}>
        <span class="message-topline"><span class="message-time">${formatTime(message.timestamp)}</span> ${showPlatform ? platformMarkup(message.platform) : ""}${sourceAvatarMarkup(message)}${badgesMarkup(message)}<span class="author-name" ${authorStyle}>${escapeHtml(message.author)}:</span> <span class="message-text">${renderMessageText(message.text, message.emotes, message.platform, message.bits)}</span></span>
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
let unseenCount = 0;

function updateScrollButton() {
  scrollBottomBtn.textContent = unseenCount ? `↓ ${unseenCount}` : "↓";
}

feedEl.addEventListener("scroll", () => {
  if (isNearBottom()) {
    unseenCount = 0;
    updateScrollButton();
  }
  scrollBottomBtn.classList.toggle("hidden", isNearBottom());
});

scrollBottomBtn.addEventListener("click", () => {
  feedEl.scrollTop = feedEl.scrollHeight;
});

let hypeTrainEndTimer = null;

function resetHypeTrainBar() {
  if (hypeTrainEndTimer) {
    clearTimeout(hypeTrainEndTimer);
    hypeTrainEndTimer = null;
  }
  const bar = document.getElementById("hype-train-bar");
  if (!bar) return;
  bar.classList.add("hidden");
  bar.setAttribute("aria-hidden", "true");
}

function handleHypeTrain(data) {
  if (isOverlay) return;
  if (!data) {
    resetHypeTrainBar();
    return;
  }
  if (hypeTrainEndTimer) {
    clearTimeout(hypeTrainEndTimer);
    hypeTrainEndTimer = null;
  }
  renderHypeTrain(data);
  if (data.phase === "end") {
    hypeTrainEndTimer = window.setTimeout(resetHypeTrainBar, data.hide_after_ms ?? 5000);
  }
}

function renderHypeTrain(data) {
  const bar = document.getElementById("hype-train-bar");
  if (!bar) return;
  bar.classList.remove("hidden");
  bar.setAttribute("aria-hidden", "false");
  bar.dataset.phase = data.phase || "progress";
  document.getElementById("ht-level").textContent = data.level || 1;
  const goal = data.goal > 0 ? data.goal : 1;
  const pct = Math.min(Math.round(((data.progress || 0) / goal) * 100), 100);
  document.getElementById("ht-progress-text").textContent = data.phase === "end" ? `Ended (${pct}%)` : `${pct}%`;
  document.getElementById("ht-fill").style.width = `${pct}%`;
}

function setStatus(platform, dot, stateText, detail, videoId) {
  state.statuses.set(platform, { platform, dot, state: stateText, detail, video_id: videoId });
  renderStatuses();
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

// Hub connection: subscribe and render; the server fans out per-channel events.
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
      case "emotes":
        thirdPartyEmotes = new Map(Object.entries(payload.emotes || {}));
        renderMessages();
        break;
      case "hype_train":
        handleHypeTrain(payload);
        break;
    }
  }
}

// Wiring — elements that only exist on index.html are guarded.
const togglePlatform = document.getElementById("toggle-platform");
const hubConnection = new HubConnection();

function connectFromInputs({ updateUrl = true } = {}) {
  const channels = {};
  for (const platform of PLATFORMS) {
    channels[platform] = channelInputs[platform].value.trim();
  }
  const hasAny = Object.values(channels).some(Boolean);
  if (!hasAny && !hubConnection.socket) return;
  hubConnection.setChannels(channels);
  updateClearButtons(channels);
  updateMentionRegex(channels);
  resetHypeTrainBar();
  playerState.channels = channels;
  renderPlayer();
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

const expandToggleBtn = document.getElementById("expand-toggle");
const feedPanelEl = document.querySelector(".feed-panel");
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let expandAnimCleanup = null;

// URL params win over saved URLs, same precedence as the popout.
function mainAlertUrls() {
  const fromUrl = new URLSearchParams(window.location.search).getAll("alerts").filter(isValidAlertUrl);
  return fromUrl.length ? fromUrl : storedAlertUrls();
}

function setExpanded(on, { animate = true } = {}) {
  if (isPopout || on === isExpanded) return;
  const firstRect = feedPanelEl.getBoundingClientRect();
  const wasNearBottom = isNearBottom();
  isExpanded = on;
  document.documentElement.classList.toggle("expand-mode", on);

  const params = new URLSearchParams(window.location.search);
  if (on) {
    params.set("expand", "1");
  } else {
    params.delete("expand");
  }
  const query = params.toString();
  window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);

  alertUrls = on ? mainAlertUrls() : [];
  renderAlertFrames();
  renderPlayer();

  if (animate && !prefersReducedMotion) playExpandTransition(firstRect);
  if (wasNearBottom) {
    requestAnimationFrame(() => {
      feedEl.scrollTop = feedEl.scrollHeight;
    });
  }
}

// FLIP: slide the feed panel from its old rect to where the class flip put it.
function playExpandTransition(firstRect) {
  expandAnimCleanup?.();
  const lastRect = feedPanelEl.getBoundingClientRect();
  if (!lastRect.width || !lastRect.height) return;
  feedPanelEl.classList.add("expand-anim");
  feedPanelEl.style.transition = "none";
  feedPanelEl.style.transformOrigin = "top left";
  feedPanelEl.style.transform = `translate(${firstRect.left - lastRect.left}px, ${firstRect.top - lastRect.top}px) `
    + `scale(${firstRect.width / lastRect.width}, ${firstRect.height / lastRect.height})`;
  feedPanelEl.getBoundingClientRect(); // flush, so the transition has a start frame
  feedPanelEl.style.transition = "transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1)";
  feedPanelEl.style.transform = "";
  const finish = () => {
    feedPanelEl.classList.remove("expand-anim");
    feedPanelEl.style.transition = "";
    feedPanelEl.style.transformOrigin = "";
    feedPanelEl.style.transform = "";
    feedPanelEl.removeEventListener("transitionend", finish);
    clearTimeout(timer);
    expandAnimCleanup = null;
  };
  const timer = setTimeout(finish, 400);
  feedPanelEl.addEventListener("transitionend", finish);
  expandAnimCleanup = finish;
}

if (expandToggleBtn) {
  expandToggleBtn.addEventListener("click", () => setExpanded(true));
  document.getElementById("expand-exit").addEventListener("click", () => setExpanded(false));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isExpanded) return;
    if (infoOverlayEl && !infoOverlayEl.classList.contains("hidden")) return;
    setExpanded(false);
  });
}

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

const toggleMentions = document.getElementById("toggle-mentions");
if (toggleMentions) {
  toggleMentions.classList.toggle("active", highlightMentions);
  toggleMentions.addEventListener("click", () => {
    highlightMentions = !highlightMentions;
    toggleMentions.classList.toggle("active", highlightMentions);
    try {
      window.localStorage.setItem(MENTIONS_STORAGE_KEY, String(highlightMentions));
    } catch (_) {}
    renderMessages();
    broadcast({ type: "highlightMentions", value: highlightMentions });
  });
}

const fontSlider = document.getElementById("font-size");
if (fontSlider) {
  const valueEl = document.getElementById("font-size-value");
  const syncValue = () => {
    valueEl.textContent = `${fontSlider.value}px`;
  };
  fontSlider.value = chatFontPx || 16;
  syncValue();
  fontSlider.addEventListener("input", () => {
    applyChatFont(Number(fontSlider.value));
    syncValue();
    try {
      window.localStorage.setItem(CHAT_FONT_STORAGE_KEY, String(chatFontPx));
    } catch (_) {}
    broadcast({ type: "chatFont", value: chatFontPx });
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

const toggleBadges = document.getElementById("toggle-badges");
if (toggleBadges) {
  toggleBadges.classList.toggle("active", showBadges);
  toggleBadges.addEventListener("click", () => {
    showBadges = !showBadges;
    toggleBadges.classList.toggle("active", showBadges);
    try {
      window.localStorage.setItem(BADGES_STORAGE_KEY, String(showBadges));
    } catch (_) {}
    renderMessages();
    broadcast({ type: "showBadges", value: showBadges });
  });
}

const toggleEmotes = document.getElementById("toggle-emotes");
if (toggleEmotes) {
  toggleEmotes.classList.toggle("active", showThirdPartyEmotes);
  toggleEmotes.addEventListener("click", () => {
    showThirdPartyEmotes = !showThirdPartyEmotes;
    toggleEmotes.classList.toggle("active", showThirdPartyEmotes);
    try {
      window.localStorage.setItem(THIRD_PARTY_EMOTES_STORAGE_KEY, String(showThirdPartyEmotes));
    } catch (_) {}
    renderMessages();
    broadcast({ type: "showThirdPartyEmotes", value: showThirdPartyEmotes });
  });
}

if (togglePlatform) {
  togglePlatform.classList.toggle("active", showPlatform);
  togglePlatform.addEventListener("click", () => {
    showPlatform = !showPlatform;
    togglePlatform.classList.toggle("active", showPlatform);
    try {
      window.localStorage.setItem(PLATFORM_STORAGE_KEY, String(showPlatform));
    } catch (_) {}
    renderMessages();
    broadcast({ type: "showPlatform", value: showPlatform });
  });
}

// Stream player (popout + expanded chat). Twitch embeds require HTTPS (localhost excepted).
const PLAYER_STORAGE_KEY = "popoutPlayer";
const PLAYER_PLATFORMS = ["twitch", "kick", "youtube"];

// Embed URL for a platform, or null when it can't be played right now.
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
  if (!isPopout && !isExpanded) {
    // Player only lives in the expanded chat on the main page; drop any playing iframe.
    playerPaneEl.classList.add("hidden");
    playerSourcesEl.classList.add("hidden");
    playerFrameEl.innerHTML = "";
    return;
  }
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
  // Reloading the iframe restarts playback (and Twitch pre-rolls) — skip if unchanged.
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

// Alert sounds: hidden alert-overlay iframes in the popout and expanded chat; URLs stay in the browser.
const ALERTS_STORAGE_KEY = "alertUrls";

function isValidAlertUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch (_) {
    return false;
  }
}

function storedAlertUrls() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ALERTS_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter(isValidAlertUrl) : [];
  } catch (_) {
    return [];
  }
}

const alertsEditBtn = document.getElementById("alerts-edit");
if (alertsEditBtn) {
  const editorEl = document.getElementById("alerts-editor");
  const rowsEl = document.getElementById("alerts-rows");
  const applyBtn = document.getElementById("alerts-apply");

  const syncEditButton = () => {
    const count = storedAlertUrls().length;
    alertsEditBtn.textContent = count ? `✎ ${count}` : "+ Add";
    alertsEditBtn.title = count ? "Edit alert sound overlays" : "Add alert sound overlays (StreamElements etc.)";
  };

  const addRow = (value = "") => {
    const row = document.createElement("div");
    row.className = "alerts-row";
    row.innerHTML = `
      <input class="input-field alerts-input" type="url" placeholder="https://streamelements.com/overlay/…" spellcheck="false">
      <button class="channel-clear alerts-remove" type="button" title="Remove">&#x2715;</button>`;
    row.querySelector("input").value = value;
    rowsEl.appendChild(row);
  };

  alertsEditBtn.addEventListener("click", () => {
    if (editorEl.classList.contains("hidden")) {
      rowsEl.innerHTML = "";
      const urls = storedAlertUrls();
      (urls.length ? urls : [""]).forEach(addRow);
      editorEl.classList.remove("hidden");
      rowsEl.querySelector("input")?.focus();
    } else {
      editorEl.classList.add("hidden"); // discard edits; reopening re-reads saved state
    }
  });

  rowsEl.addEventListener("click", (event) => {
    const remove = event.target.closest(".alerts-remove");
    if (!remove) return;
    remove.closest(".alerts-row").remove();
    // Removing the last row deletes the saved list and closes the editor.
    if (!rowsEl.children.length) {
      try {
        window.localStorage.setItem(ALERTS_STORAGE_KEY, "[]");
      } catch (_) {}
      broadcast({ type: "alertUrls", urls: [] });
      applyMainAlerts([]);
      editorEl.classList.add("hidden");
      syncEditButton();
    }
  });

  rowsEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyBtn.click();
    }
  });

  document.getElementById("alerts-add-row").addEventListener("click", () => {
    addRow();
    rowsEl.lastElementChild.querySelector("input").focus();
  });

  applyBtn.addEventListener("click", () => {
    let valid = true;
    const urls = [];
    for (const input of rowsEl.querySelectorAll(".alerts-input")) {
      const value = input.value.trim();
      input.classList.remove("invalid");
      if (!value) continue;
      if (isValidAlertUrl(value)) {
        urls.push(value);
      } else {
        input.classList.add("invalid");
        valid = false;
      }
    }
    if (!valid) return;
    try {
      window.localStorage.setItem(ALERTS_STORAGE_KEY, JSON.stringify(urls));
    } catch (_) {}
    broadcast({ type: "alertUrls", urls });
    applyMainAlerts(urls);
    editorEl.classList.add("hidden");
    syncEditButton();
  });

  syncEditButton();
}

// One-click sound unlock; any click on the page counts.
const alertFramesEl = document.getElementById("alert-frames");
const alertsUnlockEl = document.getElementById("alerts-unlock");
let alertUrls = [];
let alertAudioUnlocked = false;

function renderAlertFrames() {
  if (!alertFramesEl || isOverlay) return;
  for (const frame of [...alertFramesEl.children]) {
    if (!alertUrls.includes(frame.src)) frame.remove();
  }
  const existing = new Set([...alertFramesEl.children].map((frame) => frame.src));
  for (const url of alertUrls) {
    if (existing.has(url)) continue;
    const frame = document.createElement("iframe");
    frame.src = url;
    frame.allow = "autoplay";
    frame.tabIndex = -1;
    alertFramesEl.appendChild(frame);
  }
  updateAlertUnlock();
}

function unlockAlertAudio() {
  alertAudioUnlocked = true;
  updateAlertUnlock();
  for (const frame of alertFramesEl?.children || []) {
    frame.contentWindow?.postMessage({ type: "unlock-audio" }, "*");
  }
}

function updateAlertUnlock() {
  alertsUnlockEl?.classList.toggle("hidden", alertAudioUnlocked || !alertUrls.length);
}

if (alertsUnlockEl) {
  alertsUnlockEl.addEventListener("click", unlockAlertAudio);
  const onFirstGesture = () => {
    if (!alertUrls.length) return;
    unlockAlertAudio();
    document.removeEventListener("pointerdown", onFirstGesture);
  };
  document.addEventListener("pointerdown", onFirstGesture);
}

// Saved edits replace any legacy &alerts= in the address bar and refresh the expanded chat.
function applyMainAlerts(urls) {
  if (isPopout) return;
  const params = new URLSearchParams(window.location.search);
  if (params.has("alerts")) {
    params.delete("alerts");
    const query = params.toString();
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
  }
  if (!isExpanded) return;
  alertUrls = urls;
  renderAlertFrames();
}

// Mirrors alert URLs into the address bar so the link stays standalone.
function applyPopoutAlerts(urls) {
  alertUrls = (urls || []).filter(isValidAlertUrl);
  renderAlertFrames();
  const params = new URLSearchParams(window.location.search);
  params.delete("alerts");
  for (const url of alertUrls) params.append("alerts", url);
  const query = params.toString();
  window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
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

// Subscribes the popout's own hub connection and mirrors channels into the URL.
function applyPopoutChannels(channels) {
  hubConnection.setChannels(channels);
  playerState.channels = channels;
  updateMentionRegex(channels);
  resetHypeTrainBar();
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
  if (!isOverlay) {
    const fromUrl = pageParams.getAll("alerts").filter(isValidAlertUrl);
    alertUrls = fromUrl.length ? fromUrl : storedAlertUrls();
    renderAlertFrames();
  }
  if (isOverlay) {
    // Prune messages the fade animation has already hidden.
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
  if (isExpanded) {
    alertUrls = mainAlertUrls();
    renderAlertFrames();
  }
  renderPlayer(); // restore the toggle/open state even with nothing to watch
}

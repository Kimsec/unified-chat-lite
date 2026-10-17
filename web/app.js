const isPopout = document.body.dataset.mode === "popout";

// Overlay mode (/overlay): transparent OBS variant with auto-fading messages.
const pageParams = new URLSearchParams(window.location.search);
const isOverlay = isPopout && (window.location.pathname === "/overlay" || pageParams.has("overlay"));
const OVERLAY_FADE_MS = Math.max(Number(pageParams.get("fade")) || 60, 5) * 1000;
const OVERLAY_FADE_OUT_MS = 2500;
const OVERLAY_NEVER_FADE = pageParams.get("fade") === "0";
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
  if (OVERLAY_NEVER_FADE) root.classList.add("overlay-no-fade");
}

// Expand (?expand=1): the main page expands into the popout layout in place; ?tv=1 implies it.
let isExpanded = !isPopout && ((pageParams.get("expand") ?? "0") !== "0" || (pageParams.get("tv") ?? "0") !== "0");
document.documentElement.classList.toggle("expand-mode", isExpanded);

const state = {
  messages: [],
  statuses: new Map(),
  viewers: new Map(), // platform -> live viewer count
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

// YouTube and TikTok send no name colours: give each name a stable one from
// Twitch's default palette so every author stands out the same way.
const DEFAULT_NAME_COLORS = [
  "#FF0000", "#0000FF", "#008000", "#B22222", "#FF7F50", "#9ACD32", "#FF4500", "#2E8B57",
  "#DAA520", "#D2691E", "#5F9EA0", "#1E90FF", "#FF69B4", "#8A2BE2", "#00FF7F",
];

function nameColor(message) {
  if (message.color) return message.color;
  let hash = 0;
  for (const char of String(message.author || "")) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return DEFAULT_NAME_COLORS[hash % DEFAULT_NAME_COLORS.length];
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

// Third-party emotes (7TV/BTTV/FFZ), platform → (name → url), sent by the hub.
const thirdPartyEmotes = new Map();

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

const CHEER_WORD_RE = /^([a-z][a-z0-9_]*?)(\d+)$/i;
const bitsGemSvg = (color) => `<svg class="bits-gem" viewBox="0 0 24 24" aria-hidden="true" style="color:${color}"><path fill="currentColor" d="M12 2 3.5 9.5 12 22l8.5-12.5z"/><path fill="#fff" opacity=".35" d="M12 2 7.5 9.5h9z"/></svg>`;
const POWER_UP_SVG = `<svg class="bits-gem" viewBox="0 0 24 24" aria-hidden="true" style="color:#ffd166"><path fill="currentColor" d="M13.5 2 4 13.5h6.5L9.5 22 20 9.5h-6.5z"/></svg>`;

function cheerTier(amount) {
  return CHEER_TIERS.find(([min]) => amount >= min) || CHEER_TIERS[CHEER_TIERS.length - 1];
}

// Words to render as cheermotes. Global prefixes always count; anything else
// shaped like one (a channel's own cheermote, e.g. "xqcCheer100") counts only
// when all such words add up to exactly the bits sent, so "Team10" stays text.
function findCheerWords(text, bits) {
  const known = new Set();
  const all = new Set();
  let total = 0;
  for (const word of text.split(/\s+/)) {
    const match = CHEER_WORD_RE.exec(word);
    if (!match) continue;
    all.add(word);
    total += Number(match[2]);
    if (CHEERMOTE_PREFIXES.has(match[1].toLowerCase())) known.add(word);
  }
  return total === bits ? all : known;
}

function cheermoteMarkup(word) {
  const match = CHEER_WORD_RE.exec(word);
  const prefix = match[1].toLowerCase();
  const amount = Number(match[2]);
  const [tier, color] = cheerTier(amount);
  const image = CHEERMOTE_PREFIXES.has(prefix)
    ? `<img class="emote" src="https://d3aqoihi2n8ty8.cloudfront.net/actions/${prefix}/dark/animated/${tier}/1.gif" alt="${escapeHtml(word)}" title="${escapeHtml(word)}">`
    : `<span title="${escapeHtml(word)}">${bitsGemSvg(color)}</span>`; // channel cheermote: no public image URL
  return `${image}<span class="cheer-amount" style="color:${color}">${amount}</span>`;
}

// "<gem> Name cheered 1,000 bits:" / "<bolt> Name gigantified an emote:" ahead of the user's message.
function paidNoticeMarkup(message) {
  const color = ensureReadableColor(nameColor(message));
  const author = `<span class="author-name"${color ? ` style="color:${color}"` : ""}>${escapeHtml(message.author)}</span>`;
  const colon = message.text ? ":" : "";
  if (message.bits > 0) {
    const [, tierColor] = cheerTier(message.bits);
    return `<span class="paid-head">${bitsGemSvg(tierColor)}${badgesMarkup(message)}${author} cheered <strong class="cheer-total" style="color:${tierColor}">${message.bits.toLocaleString()} ${message.bits === 1 ? "bit" : "bits"}</strong>${colon}</span>`;
  }
  return `<span class="paid-head">${POWER_UP_SVG}${badgesMarkup(message)}${author} ${escapeHtml(message.notice)}${colon}</span>`;
}

function renderPlainText(text, platform, cheers) {
  if (platform !== "twitch" && platform !== "kick") return linkifyText(text);
  const emoteMap = showThirdPartyEmotes ? thirdPartyEmotes.get(platform) : undefined;
  if (!emoteMap?.size && !cheers?.size) return linkifyText(text);
  return text.split(" ").map((word) => {
    if (cheers?.has(word)) return cheermoteMarkup(word);
    const url = emoteMap?.get(word);
    return url ? emoteImg(url, word) : linkifyText(word);
  }).join(" ");
}


function renderMessageText(text, emotes, platform, bits = 0) {
  const cheers = bits > 0 ? findCheerWords(text, bits) : null;
  if (!emotes || !emotes.length) return renderPlainText(text, platform, cheers);
  const emoteUrl = EMOTE_IMAGE_URLS[platform] || EMOTE_IMAGE_URLS.twitch;
  const chars = Array.from(text);
  const sorted = [...emotes].sort((a, b) => a.begin - b.begin);
  let result = "";
  let cursor = 0;
  for (const emote of sorted) {
    if (emote.begin > cursor) {
      result += renderPlainText(chars.slice(cursor, emote.begin).join(""), platform, cheers);
    }
    result += emoteImg(emoteUrl(emote.id), emote.text);
    cursor = emote.end;
  }
  if (cursor < chars.length) {
    result += renderPlainText(chars.slice(cursor).join(""), platform, cheers);
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

// Busy chats deliver dozens of messages a second; rebuilding the whole feed for each
// one froze the page. New messages are batched per frame and appended instead.
let pendingMessages = [];
let flushQueued = false;

function addMessage(message) {
  state.messages.push(message);
  if (state.messages.length > MAX_VISIBLE_MESSAGES) {
    state.messages = state.messages.slice(-MAX_VISIBLE_MESSAGES);
  }
  pendingMessages.push(message);
  if (!flushQueued) {
    flushQueued = true;
    requestAnimationFrame(flushPendingMessages);
  }
}

function flushPendingMessages() {
  flushQueued = false;
  const batch = pendingMessages.slice(-MAX_VISIBLE_MESSAGES)
    .filter((message) => state.filters[message.platform] !== false);
  pendingMessages = [];
  if (!batch.length) return;
  const wasNearBottom = isNearBottom();
  // Reading further up: pin the first visible card so dropping old ones doesn't move it.
  let anchor = null;
  let anchorTop = 0;
  if (!wasNearBottom) {
    const feedTop = feedEl.getBoundingClientRect().top;
    anchor = Array.from(feedEl.children).find((card) => card.getBoundingClientRect().bottom > feedTop) || null;
    anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
  }
  feedEl.querySelector(".empty-state")?.remove();
  feedEl.insertAdjacentHTML("beforeend", batch.map(messageMarkup).join(""));
  while (feedEl.children.length > MAX_VISIBLE_MESSAGES) feedEl.firstElementChild.remove();
  if (wasNearBottom) {
    feedEl.scrollTop = feedEl.scrollHeight;
  } else {
    if (anchor?.isConnected) feedEl.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    unseenCount += batch.length;
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
  if (!isOverlay || OVERLAY_NEVER_FADE) return "";
  const age = Math.max(Date.now() - new Date(message.timestamp).getTime(), 0);
  return ` style="animation-delay: ${OVERLAY_FADE_MS - OVERLAY_FADE_OUT_MS - age}ms"`;
}

function renderMessages() {
  pendingMessages = []; // a full render already includes them
  const visibleMessages = state.messages.filter((message) => state.filters[message.platform] !== false);

  if (!visibleMessages.length) {
    feedEl.innerHTML = `<div class="empty-state">No messages yet. Connect to a channel to get started.</div>`;
    return;
  }

  const wasNearBottom = isNearBottom();

  feedEl.innerHTML = visibleMessages.map(messageMarkup).join("");

  requestAnimationFrame(() => {
    if (wasNearBottom) {
      feedEl.scrollTop = feedEl.scrollHeight;
    }
  });
}

function messageMarkup(message) {
  let messageClass = message.deleted ? "message-card deleted" : "message-card";
  if (highlightMentions && message.kind !== "system" && mentionRegex?.test(message.text)) {
    messageClass += " mention";
  }
  if (message.kind === "system") {
    const paid = message.bits > 0 || Boolean(message.notice);
    const body = message.text
      ? `<span class="message-text${paid ? "" : " system-notice-text"}">${renderMessageText(message.text, message.emotes, message.platform, message.bits)}</span>`
      : "";
    return `
      <article class="${messageClass} system-notice${paid ? " paid-notice" : ""}" data-platform="${message.platform}"${overlayFadeStyle(message)}>
        <span class="message-topline"><span class="message-time">${formatTime(message.timestamp)}</span> ${showPlatform ? platformMarkup(message.platform) : ""}${sourceAvatarMarkup(message)}${paid ? `${paidNoticeMarkup(message)} ` : ""}${body}</span>
      </article>
    `;
  }
  const readableColor = ensureReadableColor(nameColor(message));
  const authorStyle = readableColor ? `style="color:${readableColor}"` : "";
  return `
    <article class="${messageClass}" data-platform="${message.platform}"${overlayFadeStyle(message)}>
      <span class="message-topline"><span class="message-time">${formatTime(message.timestamp)}</span> ${showPlatform ? platformMarkup(message.platform) : ""}${sourceAvatarMarkup(message)}${badgesMarkup(message)}<span class="author-name" ${authorStyle}>${escapeHtml(message.author)}:</span> <span class="message-text">${renderMessageText(message.text, message.emotes, message.platform, message.bits)}</span></span>
    </article>
  `;
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

// Combined viewer badge: live viewers summed across platforms; tap for the per-platform split.
const VIEWER_PLATFORMS = ["twitch", "youtube", "kick", "tiktok"];
const compactNumber = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const VIEWERS_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-3.3 0-7 1.6-7 4.5V20h14v-2.5C16 14.6 12.3 13 9 13zm7.5-2a3.5 3.5 0 1 0-1.2-6.8 6 6 0 0 1 0 6.6c.4.1.8.2 1.2.2zm1.4 2.1A5.6 5.6 0 0 1 18 17.5V20h4v-2.2c0-2.3-2.1-4-4.1-4.7z"/></svg>`;
let viewerBreakdownOpen = false;

function setViewers(platform, count) {
  if (typeof count === "number") {
    state.viewers.set(platform, count);
  } else {
    state.viewers.delete(platform);
  }
  renderViewerBadges();
}

function renderViewerBadges() {
  const entries = VIEWER_PLATFORMS.filter((p) => state.viewers.has(p)).map((p) => [p, state.viewers.get(p)]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const html = entries.length ? `
    ${VIEWERS_SVG}<span>${total < 10000 ? total.toLocaleString() : compactNumber.format(total)}</span>
    <span class="viewer-breakdown">${entries.map(([p, count]) =>
      `<span>${PLATFORM_SVGS[p]}${compactNumber.format(count)}</span>`).join("")}</span>` : "";
  const title = entries.map(([p, count]) => `${PLATFORM_NAMES[p]}: ${count.toLocaleString()}`).join(" · ");
  for (const badge of document.querySelectorAll(".viewer-badge")) {
    badge.classList.toggle("hidden", !entries.length);
    badge.classList.toggle("open", viewerBreakdownOpen);
    badge.innerHTML = html;
    badge.title = `${total.toLocaleString()} viewers — ${title}`;
    badge.setAttribute("aria-label", badge.title);
  }
}

document.addEventListener("click", (event) => {
  if (!event.target.closest(".viewer-badge")) return;
  viewerBreakdownOpen = !viewerBreakdownOpen;
  renderViewerBadges();
});

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
      case "bootstrap": {
        const subscribed = new Set();
        for (const [platform, channel] of Object.entries(this.desired || {})) {
          if (channel) subscribed.add(`${platform}:${channel.trim().replace(/^#+/, "").toLowerCase()}`);
        }
        const incoming = new Set(payload.messages.map((m) => m.id));
        const kept = state.messages.filter(
          (m) => subscribed.has(`${m.platform}:${m.channel}`) && !incoming.has(m.id)
        );
        const merged = kept.concat(payload.messages);
        merged.sort((a, b) => a.timestamp - b.timestamp);
        state.messages = merged.slice(-MAX_VISIBLE_MESSAGES);
        state.statuses.clear();
        state.viewers.clear();
        for (const entry of payload.viewers || []) {
          state.viewers.set(entry.platform, entry.count);
        }
        renderViewerBadges();
        for (const status of payload.statuses) {
          setStatus(status.platform, status.dot, status.state, status.detail, status.video_id);
        }
        renderStatuses(); // even when statuses is empty (everything disconnected)
        renderMessages();
        break;
      }
      case "message":
        addMessage(payload.message);
        break;
      case "deleted":
        markDeleted((m) => payload.ids.includes(m.id));
        break;
      case "status":
        setStatus(payload.status.platform, payload.status.dot, payload.status.state, payload.status.detail, payload.status.video_id);
        break;
      case "viewers":
        setViewers(payload.platform, payload.count);
        break;
      case "emotes":
        thirdPartyEmotes.set(payload.platform || "twitch", new Map(Object.entries(payload.emotes || {})));
        renderMessages();
        break;
      case "hype_train":
        handleHypeTrain(payload);
        break;
      case "announce":
        showAnnouncement(String(payload.text || ""));
        break;
    }
  }
}

// Server-pushed banner; also fetched on load since pages without a
// connected channel hold no websocket. Never shown on the OBS overlay.
let dismissedAnnouncement = "";

if (!isOverlay) {
  fetch("/announcement")
    .then((response) => response.json())
    .then((data) => showAnnouncement(String(data.text || "")))
    .catch(() => {});
}

function showAnnouncement(text) {
  const existing = document.getElementById("announce-banner");
  if (isOverlay || !text || text === dismissedAnnouncement) {
    existing?.remove();
    document.body.classList.remove("has-announcement");
    return;
  }
  const banner = existing || document.createElement("div");
  if (!existing) {
    banner.id = "announce-banner";
    banner.innerHTML = `<span></span><button type="button" title="Dismiss">&#x2715;</button>`;
    banner.querySelector("button").addEventListener("click", () => {
      dismissedAnnouncement = banner.querySelector("span").textContent;
      banner.remove();
      document.body.classList.remove("has-announcement");
    });
    document.body.prepend(banner);
  }
  document.body.classList.add("has-announcement");
  banner.querySelector("span").textContent = text;
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
  connectedChannels = channels;
  updateConnectButton();
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

// "Connected" while the inputs match what's live; any edit turns it back into "Connect".
const connectButtonEl = channelsFormEl?.querySelector(".connect-button");
let connectedChannels = null;

function updateConnectButton() {
  if (!connectButtonEl) return;
  const live = Boolean(connectedChannels) && PLATFORMS.some((p) => connectedChannels[p])
    && PLATFORMS.every((p) => channelInputs[p].value.trim() === connectedChannels[p]);
  connectButtonEl.classList.toggle("connected", live);
  connectButtonEl.innerHTML = live
    ? `<span class="connect-live">✓ Connected</span><span class="connect-off">Disconnect</span>`
    : "Connect";
  connectButtonEl.title = live ? "Disconnect all channels" : "";
}

// Tapping "Connected" disconnects everything; the names stay in the inputs to reconnect.
function disconnectAll() {
  const channels = Object.fromEntries(PLATFORMS.map((p) => [p, ""]));
  hubConnection.setChannels(channels);
  connectedChannels = null;
  updateConnectButton();
  updateClearButtons(channels);
  updateMentionRegex(channels);
  resetHypeTrainBar();
  playerState.channels = channels;
  renderPlayer();
  broadcast({ type: "channels", channels });
  try {
    window.localStorage.setItem("channels", JSON.stringify(channels));
  } catch (_) {}
  const params = new URLSearchParams(window.location.search);
  for (const platform of PLATFORMS) params.delete(platform);
  const query = params.toString();
  window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
}

function updateClearButtons(channels) {
  for (const platform of PLATFORMS) {
    channelClears[platform]?.classList.toggle("hidden", !channels[platform]);
  }
}

if (channelsFormEl) {
  channelsFormEl.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.submitter === connectButtonEl && connectButtonEl.classList.contains("connected")) {
      disconnectAll();
    } else {
      connectFromInputs();
    }
  });
  for (const [platform, button] of Object.entries(channelClears)) {
    button?.addEventListener("click", () => {
      channelInputs[platform].value = "";
      connectFromInputs();
    });
  }

  for (const input of Object.values(channelInputs)) {
    input?.addEventListener("input", updateConnectButton);
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
    syncCaptionFilters();
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
const watchToggleBtn = document.getElementById("watch-toggle");
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
  if (on) playerState.mini = false;
  const firstRect = feedPanelEl.getBoundingClientRect();
  const wasNearBottom = isNearBottom();
  isExpanded = on;
  document.documentElement.classList.toggle("expand-mode", on);

  const params = new URLSearchParams(window.location.search);
  if (on) {
    params.set("expand", "1");
  } else {
    params.delete("expand");
    params.delete("tv");
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
  // Video button: the same expanded view, with the stream player already open.
  watchToggleBtn.addEventListener("click", () => {
    playerState.open = true;
    savePlayerState();
    if (isExpanded) {
      renderPlayer();
    } else {
      setExpanded(true);
    }
  });
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
// Platforms the server can resolve to a raw HLS stream for the native player (AirPlay, Chromecast).
const NATIVE_PLATFORMS = ["twitch", "kick", "youtube"];
// Twitch refuses to embed on plain-HTTP hosts (e.g. a Raspberry Pi on the LAN), so play it natively there.
const twitchEmbedBlocked = window.location.protocol !== "https:" && window.location.hostname !== "localhost";
// ?tv=1 opens straight into the side-by-side player (shared links).
const tvParam = !isOverlay && (pageParams.get("tv") ?? "0") !== "0";

// Embed URL for a platform, or null when it can't be played right now.
function playerEmbedSrc(platform) {
  const channel = playerState.channels[platform];
  if (!channel) return null;
  const muted = !playerState.sound;
  switch (platform) {
    case "twitch":
      return `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${encodeURIComponent(window.location.hostname)}&muted=${muted}&autoplay=true`;
    case "kick":
      return `https://player.kick.com/${encodeURIComponent(channel)}?muted=${muted}&autoplay=true`;
    case "youtube": {
      const videoId = state.statuses.get("youtube")?.video_id;
      return videoId
        ? `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&mute=${muted ? 1 : 0}`
        : null;
    }
  }
  return null;
}

const PLAYER_ICONS = {
  play: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>`,
  hide: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M16 16v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m4 0h4a2 2 0 0 1 2 2v3.34l1 1L22 7v10M2 2l20 20"/></svg>`,
  muted: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 9l5 6m0-6l-5 6"/></svg>`,
  sound: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>`,
  cast: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6M2 12a8 8 0 0 1 8 8M2 16a4 4 0 0 1 4 4"/><circle cx="2.5" cy="19.5" r="1.2" fill="currentColor"/></svg>`,
  airplay: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M6 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2"/><path fill="currentColor" d="M12 14l5 7H7z"/></svg>`,
  side: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path fill="currentColor" d="M15 5h6v14h-6z" opacity=".55"/></svg>`,
  stack: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path fill="currentColor" d="M3 13h18v6H3z" opacity=".55"/></svg>`,
  fullscreen: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`,
  exitFullscreen: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>`,
};

const playerPaneEl = document.getElementById("player-pane");
const playerFrameEl = document.getElementById("player-frame");
const playerToggleEl = document.getElementById("player-toggle");
const playerSourcesEl = document.getElementById("player-sources");
const playerSoundEl = document.getElementById("player-sound");
const playerCastEl = document.getElementById("player-cast");
const playerLayoutEl = document.getElementById("player-layout");
const playerFullscreenEl = document.getElementById("player-fullscreen");

// sound: set by the Unmute button (and the native player's own mute control); embeds start muted.
// native: the user picked AirPlay/Chromecast, so Twitch/Kick play in our own <video>.
// casting: Chromecast device name while a cast session is running.
// mini: the video kept playing in a floating corner player after a swipe out of the full window (phones).
// captions: AirPlay is (about to be) active, so the native player takes the captioned playlist.
const playerState = {
  open: false, source: null, layout: null, sound: false, native: false, casting: null, mini: false,
  captions: false, channels: {},
};
try {
  const stored = JSON.parse(window.localStorage.getItem(PLAYER_STORAGE_KEY) || "{}");
  playerState.open = Boolean(stored.open);
  playerState.source = stored.source || null;
  playerState.layout = stored.layout === "side" || stored.layout === "stack" ? stored.layout : null;
} catch (_) {}
// First visit: side-by-side on wide landscape screens, stacked elsewhere.
playerState.layout ??= window.matchMedia("(min-width: 1000px) and (min-aspect-ratio: 4/3)").matches ? "side" : "stack";
if (tvParam) {
  playerState.open = true;
  playerState.layout = "side";
  if (PLAYER_PLATFORMS.includes(pageParams.get("source"))) playerState.source = pageParams.get("source");
}

function savePlayerState() {
  try {
    window.localStorage.setItem(
      PLAYER_STORAGE_KEY,
      JSON.stringify({ open: playerState.open, source: playerState.source, layout: playerState.layout })
    );
  } catch (_) {}
}

const fullscreenSupported = Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const isFullscreen = () => Boolean(document.fullscreenElement || document.webkitFullscreenElement);

// --- Native player: HLS straight from the platform CDN (Safari natively, hls.js elsewhere) ---

const STREAM_URL_TTL_MS = 60_000;
const NATIVE_RETRY_MS = 30_000;
const streamUrlCache = new Map();
const nativeFailures = new Map();
let activeHls = null;
let hlsLoader = null;

const usesNativePlayer = (platform) => NATIVE_PLATFORMS.includes(platform)
  && (playerState.native || (platform === "twitch" && twitchEmbedBlocked));
const streamKey = (platform) => `${platform}:${playerState.channels[platform]}`;

function cachedStreamUrl(platform) {
  const hit = streamUrlCache.get(streamKey(platform));
  return hit && Date.now() - hit.at < STREAM_URL_TTL_MS ? hit.url : null;
}

async function fetchStreamUrl(platform) {
  const cached = cachedStreamUrl(platform);
  if (cached) return cached;
  const key = streamKey(platform);
  const response = await fetch(`/stream/${platform}/${encodeURIComponent(playerState.channels[platform])}`);
  if (!response.ok) throw new Error("offline");
  const { url } = await response.json();
  streamUrlCache.set(key, { url, at: Date.now() });
  return url;
}

function loadHlsJs() {
  hlsLoader ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "vendor/hls.light.min.js";
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return hlsLoader;
}

// Replaces whatever plays in the player frame, tearing down hls.js first.
function setPlayerFrame(html) {
  activeHls?.destroy();
  activeHls = null;
  playerFrameEl.innerHTML = html;
}

function showPlayerMessage(text) {
  setPlayerFrame(`<div class="player-empty">${text}</div>`);
}

function failNativePlayer(platform) {
  nativeFailures.set(streamKey(platform), Date.now());
  streamUrlCache.delete(streamKey(platform));
  showPlayerMessage(`Couldn't load the ${PLATFORM_NAMES[platform]} stream &mdash; is the channel live?`);
}

// Safari plays (and AirPlays) the server's copy of the playlist, which adds the chat as a
// "Chat" caption track so it shows on the TV; captions stay hidden on the phone itself.
function airplayMasterUrl(platform) {
  const chat = PLATFORMS.filter((p) => playerState.channels[p]).map((p) => `${p}:${playerState.channels[p]}`).join("+");
  return `${window.location.origin}/airplay/${platform}/${encodeURIComponent(playerState.channels[platform])}/${encodeURIComponent(chat)}/master.m3u8`;
}

function syncChatCaptions(video) {
  const onTv = Boolean(video.webkitCurrentPlaybackTargetIsWireless);
  for (const track of video.textTracks) {
    if (track.kind === "subtitles" || track.kind === "captions") track.mode = onTv ? "showing" : "hidden";
  }
}

function attachStream(video, url, platform) {
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    return;
  }
  loadHlsJs().then(() => {
    if (!video.isConnected) return;
    if (!window.Hls?.isSupported()) {
      showPlayerMessage("This browser can't play the stream directly.");
      return;
    }
    activeHls = new window.Hls({ lowLatencyMode: true });
    activeHls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (data.fatal && video.isConnected) failNativePlayer(platform);
    });
    activeHls.loadSource(url);
    activeHls.attachMedia(video);
  }, () => showPlayerMessage("Couldn't load the video player."));
}

function mountNativePlayer(platform) {
  const key = streamKey(platform);
  const existing = playerFrameEl.querySelector("video.native-player");
  if (existing?.dataset.key === key) {
    existing.muted = !playerState.sound;
    return;
  }
  if (Date.now() - (nativeFailures.get(key) || 0) < NATIVE_RETRY_MS) {
    if (!playerFrameEl.querySelector(".player-empty")) failNativePlayer(platform);
    return;
  }
  setPlayerFrame(`<video class="native-player" playsinline autoplay controls x-webkit-airplay="allow"${playerState.sound ? "" : " muted"}></video>`);
  const video = playerFrameEl.querySelector("video");
  video.dataset.key = key;
  video.muted = !playerState.sound;
  // Keep our Unmute button in step with the video's own volume controls.
  video.addEventListener("volumechange", () => {
    if (playerState.sound === !video.muted) return;
    playerState.sound = !video.muted;
    renderPlayerButtons();
  });
  video.addEventListener("error", () => {
    if (video.isConnected && !activeHls) failNativePlayer(platform);
  });
  if (airplaySupported) {
    video.textTracks.addEventListener("addtrack", () => syncChatCaptions(video));
    // iOS can report "not wireless" for a moment while the TV connection is set up, so
    // captions switch on at once but only switch off once AirPlay has stayed off.
    let captionsOffTimer = null;
    video.addEventListener("webkitcurrentplaybacktargetiswirelesschanged", () => {
      clearTimeout(captionsOffTimer);
      if (video.webkitCurrentPlaybackTargetIsWireless) {
        playerState.captions = true;
        setNativeSource(video, platform);
        syncChatCaptions(video);
        return;
      }
      captionsOffTimer = setTimeout(() => {
        if (!video.isConnected || video.webkitCurrentPlaybackTargetIsWireless) return;
        playerState.captions = false;
        setNativeSource(video, platform);
      }, CAPTIONS_OFF_DELAY_MS);
    });
  }
  setNativeSource(video, platform);
}

const CAPTIONS_OFF_DELAY_MS = 3000;

// The TV captions honour the filter chips: tell the server which platforms are hidden.
function syncCaptionFilters() {
  if (!airplaySupported || !playerState.captions || !NATIVE_PLATFORMS.includes(playerState.source)) return;
  const url = airplayMasterUrl(playerState.source).replace(/master\.m3u8$/, "filters");
  const hidden = PLATFORMS.filter((platform) => state.filters[platform] === false);
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hidden }) })
    .catch(() => {});
}

// The captioned playlist (the server's live chat track) is only used while AirPlaying;
// everywhere else the player takes the plain stream, so the server builds no captions.
function setNativeSource(video, platform) {
  if (airplaySupported && playerState.captions) {
    const url = airplayMasterUrl(platform);
    if (video.src !== url) video.src = url;
    syncCaptionFilters();
    return;
  }
  const cached = cachedStreamUrl(platform);
  if (cached) {
    if (video.src !== cached) attachStream(video, cached, platform);
    return;
  }
  fetchStreamUrl(platform).then(
    (url) => video.isConnected && !playerState.captions && video.src !== url && attachStream(video, url, platform),
    () => video.isConnected && failNativePlayer(platform)
  );
}

// --- AirPlay (Safari) and Chromecast (Chrome): the video goes to the TV, the chat stays here ---

const airplaySupported = typeof window.WebKitPlaybackTargetAvailabilityEvent !== "undefined";
const castState = { ready: false, available: false, requested: false };

function loadCastSdk() {
  if (castState.requested || airplaySupported || !window.chrome || !window.isSecureContext) return;
  castState.requested = true;
  window.__onGCastApiAvailable = (isAvailable) => {
    if (!isAvailable) return;
    const context = window.cast.framework.CastContext.getInstance();
    context.setOptions({
      receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });
    context.addEventListener(window.cast.framework.CastContextEventType.CAST_STATE_CHANGED, (event) => {
      castState.available = event.castState !== window.cast.framework.CastState.NO_DEVICES_AVAILABLE;
      renderPlayerButtons();
    });
    context.addEventListener(window.cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (event) => {
      if (event.sessionState === window.cast.framework.SessionState.SESSION_ENDED && playerState.casting) {
        playerState.casting = null;
        renderPlayer();
      }
    });
    castState.ready = true;
    renderPlayerButtons();
  };
  const script = document.createElement("script");
  script.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
  script.async = true;
  document.head.appendChild(script);
}

function startAirPlay() {
  playerState.native = true;
  playerState.captions = true;
  renderPlayer();
  const video = playerFrameEl.querySelector("video.native-player");
  if (video) setNativeSource(video, playerState.source);
  // The picker needs this click's user gesture; the captioned src is set synchronously above.
  try {
    video?.webkitShowPlaybackTargetPicker();
  } catch (_) {}
}

async function startChromecast() {
  const context = window.cast.framework.CastContext.getInstance();
  if (playerState.casting) {
    context.endCurrentSession(true);
    playerState.casting = null;
    renderPlayer();
    return;
  }
  const platform = playerState.source;
  const channel = playerState.channels[platform];
  const urlPromise = fetchStreamUrl(platform);
  urlPromise.catch(() => {});
  try {
    await context.requestSession(); // device picker; rejects when dismissed
  } catch (_) {
    return;
  }
  const session = context.getCurrentSession();
  try {
    const media = new window.chrome.cast.media.MediaInfo(await urlPromise, "application/x-mpegURL");
    media.streamType = window.chrome.cast.media.StreamType.LIVE;
    media.hlsSegmentFormat = window.chrome.cast.media.HlsSegmentFormat.TS;
    media.hlsVideoSegmentFormat = window.chrome.cast.media.HlsVideoSegmentFormat.MPEG2_TS;
    media.metadata = new window.chrome.cast.media.GenericMediaMetadata();
    media.metadata.title = `${channel} · ${PLATFORM_NAMES[platform]}`;
    await session.loadMedia(new window.chrome.cast.media.LoadRequest(media));
    playerState.casting = session.getCastDevice()?.friendlyName || "your TV";
  } catch (_) {
    context.endCurrentSession(true);
    failNativePlayer(platform);
    return;
  }
  renderPlayer();
}

// --- Rendering ---

function renderPlayerButtons() {
  const root = document.documentElement;
  const hasSource = Boolean(playerState.open && playerState.source);
  const docked = !root.classList.contains("player-mini"); // the floating player has no toolbar or TV layout
  root.classList.toggle("player-open", playerState.open && docked);
  root.classList.toggle("tv-mode", playerState.open && docked && playerState.layout === "side");

  playerToggleEl.innerHTML = playerState.open ? PLAYER_ICONS.hide : PLAYER_ICONS.play;
  playerToggleEl.title = playerState.open ? "Hide the video" : "Show stream player";


  // Only Kick's embed hides its own mute control; every other player (incl. our native one) has one.
  const needsSoundButton = hasSource && playerState.source === "kick" && !usesNativePlayer("kick") && !playerState.casting;
  playerSoundEl.classList.toggle("hidden", !needsSoundButton);
  playerSoundEl.classList.toggle("muted", !playerState.sound);
  playerSoundEl.innerHTML = playerState.sound ? PLAYER_ICONS.sound : `${PLAYER_ICONS.muted}<span>Unmute</span>`;
  playerSoundEl.title = playerState.sound ? "Mute the stream" : "Turn the stream sound on";

  const castable = hasSource && NATIVE_PLATFORMS.includes(playerState.source);
  const castReady = airplaySupported || (castState.ready && (castState.available || playerState.casting));
  playerCastEl.classList.toggle("hidden", !castable || !castReady);
  playerCastEl.classList.toggle("active", Boolean(playerState.casting));
  playerCastEl.innerHTML = airplaySupported ? PLAYER_ICONS.airplay : PLAYER_ICONS.cast;
  playerCastEl.title = airplaySupported
    ? "AirPlay to Apple TV"
    : playerState.casting ? `Stop casting to ${playerState.casting}` : "Cast to Chromecast";

  playerLayoutEl.classList.toggle("hidden", !playerState.open);
  playerLayoutEl.innerHTML = playerState.layout === "side" ? PLAYER_ICONS.stack : PLAYER_ICONS.side;
  playerLayoutEl.title = playerState.layout === "side" ? "Video above the chat" : "Video beside the chat (TV layout)";

  playerFullscreenEl.classList.toggle("hidden", !playerState.open || !fullscreenSupported);
  playerFullscreenEl.innerHTML = isFullscreen() ? PLAYER_ICONS.exitFullscreen : PLAYER_ICONS.fullscreen;
  playerFullscreenEl.title = isFullscreen() ? "Exit full screen" : "Full screen";
}

function renderPlayer() {
  if (!playerPaneEl || isOverlay) return; // no player inside an OBS overlay
  const mini = !isPopout && !isExpanded && playerState.open && playerState.mini;
  document.documentElement.classList.toggle("player-mini", mini);
  if (!isPopout && !isExpanded && !mini) {
    // Player only lives in the expanded chat on the main page; drop any playing video.
    document.documentElement.classList.remove("tv-mode", "player-open");
    playerPaneEl.classList.add("hidden");
    playerSourcesEl.classList.add("hidden");
    setPlayerFrame("");
    return;
  }
  const available = PLAYER_PLATFORMS.filter((platform) => playerEmbedSrc(platform) !== null);
  if (!available.includes(playerState.source)) {
    playerState.source = available[0] || null;
  }

  playerSourcesEl.classList.toggle("hidden", !playerState.open || !available.length);
  playerSourcesEl.innerHTML = available.map((platform) => `
    <button class="player-source${platform === playerState.source ? " active" : ""}" data-platform="${platform}"
      type="button" title="Watch on ${PLATFORM_NAMES[platform]}">${PLATFORM_SVGS[platform]}<span class="player-source-name">${PLATFORM_NAMES[platform]}</span></button>
  `).join("");

  playerPaneEl.classList.toggle("hidden", !playerState.open);
  renderPlayerButtons();

  if (!playerState.open) {
    setPlayerFrame(""); // drop the video so playback (and audio) stops
    return;
  }
  loadCastSdk();
  if (!playerState.source) {
    showPlayerMessage("Connect a live Twitch, Kick or YouTube channel to watch the stream here.");
    return;
  }
  if (playerState.casting) {
    setPlayerFrame(`
      <div class="player-casting">
        ${PLAYER_ICONS.cast}
        <strong>Playing on ${escapeHtml(playerState.casting)}</strong>
        <span>The chat stays right here.</span>
        <button class="player-casting-stop" type="button">Stop casting</button>
      </div>`);
    return;
  }
  if (usesNativePlayer(playerState.source)) {
    mountNativePlayer(playerState.source);
    return;
  }
  const src = playerEmbedSrc(playerState.source);
  // Reloading the iframe restarts playback (and Twitch pre-rolls) — skip if unchanged.
  if (playerFrameEl.querySelector("iframe")?.src === src) return;
  setPlayerFrame(`<iframe src="${escapeHtml(src)}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`);
}

function toggleFullscreen() {
  const root = document.documentElement;
  if (isFullscreen()) {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  } else {
    (root.requestFullscreen || root.webkitRequestFullscreen)?.call(root)?.catch?.(() => {});
  }
}

// Phones: pull down on the toolbar (or on the chat when it's scrolled to the top) to leave
// the full window; the video keeps playing in a floating corner player. Touch-only, so
// desktop is untouched.
const coarsePointer = window.matchMedia("(pointer: coarse)");
const SWIPE_CLOSE_PX = 90;
const appShellEl = document.querySelector(".app-shell");
let swipe = null;

function resetSwipeVisual() {
  appShellEl.style.transition = "transform 200ms ease, opacity 200ms ease";
  appShellEl.style.transform = "";
  appShellEl.style.opacity = "";
  setTimeout(() => { appShellEl.style.transition = ""; }, 220);
}

// Embedded players (cross-origin iframes) swallow touches, so a transparent layer over the
// top of the video catches the swipe; the bottom strip, where the player's own buttons are,
// stays free. A plain tap on the layer steps it aside for a few seconds so the next taps
// reach the player. Our own <video> passes touches through, so it needs no layer.
const SWIPE_ZONE_PASS_MS = 4000;
let swipeZoneEl = null;

if (!isPopout && playerPaneEl) {
  swipeZoneEl = document.createElement("div");
  swipeZoneEl.className = "player-swipe-zone";
  playerPaneEl.appendChild(swipeZoneEl);
  const syncTouch = () => document.documentElement.classList.toggle("touch-swipe", coarsePointer.matches);
  syncTouch();
  coarsePointer.addEventListener?.("change", syncTouch);
}

if (!isPopout && appShellEl) {
  document.addEventListener("touchstart", (event) => {
    swipe = null;
    if (!isExpanded || !coarsePointer.matches || event.touches.length !== 1) return;
    const zone = event.target.closest(".player-controls, .feed, .player-swipe-zone, video.native-player");
    if (!zone || (zone === feedEl && feedEl.scrollTop > 0)) return;
    swipe = { x: event.touches[0].clientX, y: event.touches[0].clientY, dy: 0, zone, moved: false };
  }, { passive: true });

  document.addEventListener("touchmove", (event) => {
    if (!swipe) return;
    const dy = event.touches[0].clientY - swipe.y;
    const dx = event.touches[0].clientX - swipe.x;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) swipe.moved = true;
    if (dy < 0 || Math.abs(dx) > dy) { // scrolling up or sideways: not a close gesture
      if (swipe.dy) resetSwipeVisual();
      swipe = dy < -8 || Math.abs(dx) > 24 ? null : swipe;
      return;
    }
    swipe.dy = dy;
    appShellEl.style.transform = `translateY(${dy * 0.55}px)`;
    appShellEl.style.opacity = String(1 - Math.min(dy / 700, 0.35));
  }, { passive: true });

  document.addEventListener("touchend", () => {
    if (!swipe) return;
    const close = swipe.dy > SWIPE_CLOSE_PX;
    if (swipe.zone === swipeZoneEl && !swipe.moved) {
      // A tap, not a swipe: let the next taps through to the player.
      swipeZoneEl.classList.add("pass");
      setTimeout(() => swipeZoneEl.classList.remove("pass"), SWIPE_ZONE_PASS_MS);
    }
    swipe = null;
    if (!close) {
      resetSwipeVisual();
      return;
    }
    // Measure the video where the finger left it, then drop the drag offset instantly:
    // a transformed ancestor would also offset the fixed-position floating player.
    const from = playerState.open ? playerPaneEl.getBoundingClientRect() : null;
    appShellEl.style.transition = "";
    appShellEl.style.transform = "";
    appShellEl.style.opacity = "";
    playerState.mini = playerState.open;
    setExpanded(false, { animate: false });
    if (prefersReducedMotion) return;
    if (from && playerState.mini) flyToMiniPlayer(from);
    appShellEl.querySelector(".layout-grid")?.animate(
      [{ opacity: 0 }, { opacity: 1 }], { duration: 380, easing: "ease-out" }
    );
  });
}

// The video drops down first, then glides into the corner as it shrinks.
function flyToMiniPlayer(from) {
  const to = playerPaneEl.getBoundingClientRect();
  if (!to.width || !to.height) return;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  // x/y/s: how far along the horizontal move, vertical move and shrink each keyframe is.
  const at = (x, y, s) => `translate(${dx * (1 - x)}px, ${dy * (1 - y)}px) scale(${sx + (1 - sx) * s}, ${sy + (1 - sy) * s})`;
  playerPaneEl.style.transformOrigin = "top left";
  playerPaneEl.animate([
    { transform: at(0, 0, 0), borderRadius: "0px" },
    { transform: at(0.12, 0.6, 0.4), offset: 0.4 },
    { transform: "none", borderRadius: "12px" },
  ], { duration: 620, easing: "cubic-bezier(0.4, 0, 0.2, 1)" }).finished.then(
    () => { playerPaneEl.style.transformOrigin = ""; },
    () => {}
  );
}

// Floating player controls: back to the full window, or stop the video.
if (!isPopout && playerPaneEl) {
  const miniBar = document.createElement("div");
  miniBar.className = "player-mini-bar";
  miniBar.innerHTML = `
    <button class="player-mini-expand" type="button" title="Back to full window">${PLAYER_ICONS.fullscreen}</button>
    <button class="player-mini-close" type="button" title="Close video">&#x2715;</button>`;
  playerPaneEl.appendChild(miniBar);
  miniBar.querySelector(".player-mini-expand").addEventListener("click", () => setExpanded(true));
  miniBar.querySelector(".player-mini-close").addEventListener("click", () => {
    playerState.mini = false;
    renderPlayer();
  });
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
  playerLayoutEl.addEventListener("click", () => {
    playerState.layout = playerState.layout === "side" ? "stack" : "side";
    const wasNearBottom = isNearBottom();
    savePlayerState();
    renderPlayer();
    if (wasNearBottom) requestAnimationFrame(() => { feedEl.scrollTop = feedEl.scrollHeight; });
  });
  // Embeds reload unmuted (iOS only lets a cross-origin player gain sound on a fresh load);
  // the native player just unmutes in place.
  playerSoundEl.addEventListener("click", () => {
    playerState.sound = !playerState.sound;
    renderPlayer();
  });
  playerCastEl.addEventListener("click", () => {
    if (airplaySupported) {
      startAirPlay();
    } else if (castState.ready) {
      startChromecast();
    }
  });
  playerFrameEl.addEventListener("click", (event) => {
    if (event.target.closest(".player-casting-stop")) startChromecast();
  });
  playerFullscreenEl.addEventListener("click", toggleFullscreen);
  for (const type of ["fullscreenchange", "webkitfullscreenchange"]) {
    document.addEventListener(type, renderPlayerButtons);
  }
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
  if (isOverlay && !OVERLAY_NEVER_FADE) {
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

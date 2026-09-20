/* ================================================================
   AI SETTINGS — toggle the model, prompt, and params HERE.
   - MODEL: any vision chat-model id (e.g. "gpt-5.6-luna").
   - SYSTEM_PROMPT / USER_PROMPT: the classifier prompt. NOTE: keep
     the word "JSON" in there or json_object mode 400s.
   - REASONING_EFFORT: "none" | "low" | "medium" | "high". Higher =
     smarter verdicts but pricier + slower. "low" is the sweet spot.
   - MAX_TOKENS: ceiling for reasoning + answer. Too low starves
     the answer (empty replies); 300 is plenty for true/false.
   - IMG_DETAIL: "low" (cheap, ~85 tokens) | "high" (hungry).
   - PRICE_IN/OUT_PER_M: $ per 1M tokens. Feeds the avg/frame math.
   - MUTE_AFTER_ADS / UNMUTE_AFTER_GAMES: consecutive same-verdicts
     required before the mute flips. Higher = calmer, slower.
   ================================================================ */
const AI = {
  MODEL: "gpt-5.6-luna",
  PRICE_IN_PER_M: 0.2,
  PRICE_OUT_PER_M: 1.2,
  REASONING_EFFORT: "low",
  MAX_TOKENS: 300,
  IMG_DETAIL: "low"
};
const MUTE_AFTER_ADS = 2;
const UNMUTE_AFTER_GAMES = 2;
const DEFAULT_WIDTH = 512;
const VERIFY_COOLDOWN_MS = 5000;
const HEARTBEAT_MS = 60000;

const SYSTEM_PROMPT = 'Binary classifier. Output ONLY valid JSON: {"is_game": true/false}. No other text. Look ONLY at the video player area. Ignore browser UI, tabs, and page around the player.';
const USER_PROMPT =
  'Return JSON. Judge ONLY what is inside the video player (ignore browser chrome and surrounding page). ' +
  '{"is_game": true} = player shows actual sportscast: live play, field/court/rink/players in action, score bug or scoreboard overlay. ' +
  '{"is_game": false} = player shows ad, commercial, promo, "Ad" label or countdown, fullscreen product shot, break slate ("we will be right back", "coverage resumes shortly"), menu, loading, no game. ' +
  'Unsure = false.';

const LABELS = {
  off: "Off",
  on: "Starting",
  checking: "Checking",
  game: "Game",
  ad: "Ad",
  nokey: "No key",
  error: "Error"
};

const inflight = new Set();
const trailing = new Set();

function defaultState() {
  return { status: "off", adStreak: 0, gameStreak: 0, costs: [], avgCost: 0, lastVerify: 0, error: "" };
}

async function loadState(tabId) {
  const key = `tab_${tabId}`;
  const found = (await chrome.storage.session.get(key))[key];
  return { ...defaultState(), ...found };
}

async function saveState(tabId, patch) {
  const next = { ...(await loadState(tabId)), ...patch };
  await chrome.storage.session.set({ [`tab_${tabId}`]: next });
  return next;
}

async function getEnabledTabs() {
  const s = await chrome.storage.session.get("enabledTabs");
  return s.enabledTabs || {};
}

async function ensureOffscreen() {
  try {
    if (chrome.offscreen.hasDocument) {
      if (await chrome.offscreen.hasDocument()) return;
    }
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS", "USER_MEDIA"],
      justification: "Tab video sampling and shot detection for game detection"
    });
  } catch (e) {
    if (!String(e && e.message).includes("Only a single offscreen")) throw e;
  }
}

async function sendToOffscreen(msg) {
  await ensureOffscreen();
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch {
    await new Promise((r) => setTimeout(r, 400));
    return await chrome.runtime.sendMessage(msg);
  }
}

async function updateBadge(tabId) {
  try {
    const tabs = await getEnabledTabs();
    if (!tabs[String(tabId)]) {
      await chrome.action.setBadgeText({ tabId, text: "" });
      return;
    }
    const st = await loadState(tabId);
    const text = st.status === "game" ? "LIVE" : st.status === "ad" ? "MUTE" : "ON";
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: st.status === "game" ? "#16a34a" : "#dc2626"
    });
  } catch {}
}

async function startStreamFor(tabId) {
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await sendToOffscreen({ type: "startStream", tabId, streamId, width: DEFAULT_WIDTH });
}

async function setEnabled(tabId, on) {
  const tabs = await getEnabledTabs();
  if (on) tabs[String(tabId)] = true;
  else delete tabs[String(tabId)];
  await chrome.storage.session.set({ enabledTabs: tabs });
  if (on) {
    await ensureOffscreen();
    await saveState(tabId, { status: "on", error: "" });
    try {
      await startStreamFor(tabId);
    } catch (e) {
      await saveState(tabId, { status: "error", error: String((e && e.message) || e) });
    }
  } else {
    try {
      await sendToOffscreen({ type: "stopStream", tabId });
    } catch {}
    try {
      await chrome.tabs.update(tabId, { muted: false });
    } catch {}
    await chrome.storage.session.remove([`tab_${tabId}`]);
  }
  await updateBadge(tabId);
}

async function classify(dataUrl, apiKey) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: AI.MODEL,
      reasoning_effort: AI.REASONING_EFFORT,
      max_completion_tokens: AI.MAX_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: USER_PROMPT },
            { type: "image_url", image_url: { url: dataUrl, detail: AI.IMG_DETAIL } }
          ]
        }
      ]
    })
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).error?.message || "";
    } catch {}
    throw new Error(`OpenAI ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content || "";
  if (!content.trim()) throw new Error("Empty response from model");
  const u = json.usage || {};
  const rawCost = ((u.prompt_tokens || 0) * AI.PRICE_IN_PER_M + (u.completion_tokens || 0) * AI.PRICE_OUT_PER_M) / 1e6;
  const cost = Number.isFinite(rawCost) ? rawCost : 0;
  let isGame;
  try {
    isGame = JSON.parse(content).is_game === true;
  } catch {
    isGame = /"is_game"\s*:\s*true/.test(content);
  }
  return { isGame, cost };
}

async function applyVerdict(tabId, isGame, cost) {
  const cur = await loadState(tabId);
  const costs = [...cur.costs, cost].slice(-10);
  await saveState(tabId, {
    status: isGame ? "game" : "ad",
    adStreak: isGame ? 0 : cur.adStreak + 1,
    gameStreak: isGame ? cur.gameStreak + 1 : 0,
    costs,
    avgCost: costs.reduce((a, b) => a + b, 0) / costs.length,
    lastVerify: Date.now(),
    error: ""
  });
  const next = await loadState(tabId);
  if (isGame && next.gameStreak >= UNMUTE_AFTER_GAMES) {
    try {
      await chrome.tabs.update(tabId, { muted: false });
    } catch {}
  } else if (!isGame && next.adStreak >= MUTE_AFTER_ADS) {
    try {
      await chrome.tabs.update(tabId, { muted: true });
    } catch {}
  }
  await updateBadge(tabId);
}

async function getFrame(tabId) {
  try {
    const r = await sendToOffscreen({ type: "frame", tabId, width: DEFAULT_WIDTH });
    if (r && r.dataUrl) return r.dataUrl;
  } catch {}
  await startStreamFor(tabId);
  const retry = await sendToOffscreen({ type: "frame", tabId, width: DEFAULT_WIDTH });
  if (retry && retry.dataUrl) return retry.dataUrl;
  throw new Error("No video frame from tab");
}

async function verify(tabId) {
  const tabs = await getEnabledTabs();
  if (!tabs[String(tabId)]) return;
  const { openaiKey } = await chrome.storage.local.get("openaiKey");
  if (!openaiKey) {
    await saveState(tabId, { status: "nokey" });
    await updateBadge(tabId);
    return;
  }
  await saveState(tabId, { status: "checking" });
  const frame = await getFrame(tabId);
  const { isGame, cost } = await classify(frame, openaiKey);
  await applyVerdict(tabId, isGame, cost);
}

async function requestVerify(tabId, { force = false } = {}) {
  if (inflight.has(tabId)) {
    trailing.add(tabId);
    return;
  }
  inflight.add(tabId);
  try {
    do {
      trailing.delete(tabId);
      if (!force) {
        const cur = await loadState(tabId);
        if (Date.now() - cur.lastVerify < VERIFY_COOLDOWN_MS) return;
      }
      await verify(tabId);
    } while (trailing.has(tabId));
  } catch (e) {
    const tabs = await getEnabledTabs();
    if (tabs[String(tabId)]) {
      await saveState(tabId, { status: "error", error: String((e && e.message) || e) });
      await updateBadge(tabId);
    }
  } finally {
    inflight.delete(tabId);
  }
}

async function tick() {
  const tabs = await getEnabledTabs();
  for (const id of Object.keys(tabs)) {
    const tabId = Number(id);
    const cur = await loadState(tabId);
    if (Date.now() - cur.lastVerify > HEARTBEAT_MS) requestVerify(tabId, { force: true });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "tick") {
      await tick();
      sendResponse({ ok: true });
    } else if (msg.type === "shot" || msg.type === "streamError") {
      requestVerify(msg.tabId, {});
      sendResponse({ ok: true });
    } else if (msg.type === "toggle") {
      await setEnabled(msg.tabId, msg.on);
      sendResponse({ ok: true });
    } else if (msg.type === "getState") {
      const tabs = await getEnabledTabs();
      const enabled = !!tabs[String(msg.tabId)];
      const { openaiKey } = await chrome.storage.local.get("openaiKey");
      const cur = enabled ? await loadState(msg.tabId) : defaultState();
      sendResponse({
        enabled,
        hasKey: !!openaiKey,
        status: enabled ? cur.status : "off",
        label: enabled ? LABELS[cur.status] || cur.status : LABELS.off,
        ago: cur.lastVerify ? Math.max(0, Math.round((Date.now() - cur.lastVerify) / 1000)) : -1,
        error: cur.error,
        avgCost: cur.avgCost,
        frames: cur.costs.length
      });
    } else if (msg.type === "setKey") {
      await chrome.storage.local.set({ openaiKey: msg.key });
      sendResponse({ ok: true });
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  setEnabled(tabId, false).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  getEnabledTabs().then((tabs) => {
    if (tabs[String(tabId)]) setEnabled(tabId, false).catch(() => {});
  });
});

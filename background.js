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

const debounceTimers = {};

async function ensureOffscreen() {
  try {
    if (chrome.offscreen.hasDocument) {
      if (await chrome.offscreen.hasDocument()) return;
    }
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS", "USER_MEDIA"],
      justification: "Tab video sampling, shot detection, and image resize for game detection"
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

async function getEnabledTabs() {
  const s = await chrome.storage.session.get("enabledTabs");
  return s.enabledTabs || {};
}

async function getLegacyTabs() {
  const s = await chrome.storage.session.get("legacyTabs");
  return s.legacyTabs || {};
}

async function markLegacy(tabId, on) {
  const legacy = await getLegacyTabs();
  if (on) legacy[String(tabId)] = true;
  else delete legacy[String(tabId)];
  await chrome.storage.session.set({ legacyTabs: legacy });
}

async function setEnabled(tabId, on) {
  const tabs = await getEnabledTabs();
  if (on) tabs[String(tabId)] = true;
  else delete tabs[String(tabId)];
  await chrome.storage.session.set({ enabledTabs: tabs });
  if (on) {
    await ensureOffscreen();
    await startStreamFor(tabId);
  } else {
    await stopStreamFor(tabId);
  }
  await updateBadge(tabId, on);
}

async function startStreamFor(tabId) {
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await sendToOffscreen({ type: "startStream", tabId, streamId, width: DEFAULT_WIDTH });
    await markLegacy(tabId, false);
  } catch {
    await markLegacy(tabId, true);
  }
}

async function stopStreamFor(tabId) {
  try {
    await sendToOffscreen({ type: "stopStream", tabId });
  } catch {}
  await markLegacy(tabId, false);
}

async function updateBadge(tabId, on) {
  try {
    const status = on ? (await chrome.storage.session.get(`st_${tabId}`))[`st_${tabId}`] : null;
    const text = !on ? "" : status === "game" ? "LIVE" : status === "ad" ? "MUTE" : "ON";
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: status === "game" ? "#16a34a" : "#dc2626"
    });
  } catch {}
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
  const costKey = `costs_${tabId}`;
  const prev = (await chrome.storage.session.get(costKey))[costKey] || [];
  const costs = [...prev, cost].slice(-10);
  const avgCost = costs.reduce((a, b) => a + b, 0) / costs.length;
  const s = await chrome.storage.session.get([`streak_${tabId}`, `gstreak_${tabId}`]);
  let adStreak = 0;
  let gameStreak = 0;
  if (isGame) {
    gameStreak = (s[`gstreak_${tabId}`] || 0) + 1;
  } else {
    adStreak = (s[`streak_${tabId}`] || 0) + 1;
  }
  await chrome.storage.session.set({
    [`st_${tabId}`]: isGame ? "game" : "ad",
    [`ts_${tabId}`]: Date.now(),
    [`vv_${tabId}`]: Date.now(),
    [costKey]: costs,
    [`avg_${tabId}`]: avgCost,
    [`streak_${tabId}`]: adStreak,
    [`gstreak_${tabId}`]: gameStreak
  });
  await chrome.storage.session.remove([`err_${tabId}`]);
  if (isGame && gameStreak >= UNMUTE_AFTER_GAMES) {
    await chrome.tabs.update(tabId, { muted: false });
  } else if (!isGame && adStreak >= MUTE_AFTER_ADS) {
    await chrome.tabs.update(tabId, { muted: true });
  }
  await updateBadge(tabId, true);
}

async function getFrame(tabId, width) {
  const legacy = await getLegacyTabs();
  if (!legacy[String(tabId)]) {
    try {
      const r = await sendToOffscreen({ type: "frame", tabId, width });
      if (r && r.dataUrl) return r.dataUrl;
    } catch {}
    await markLegacy(tabId, true);
  }
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) throw new Error("Tab not visible for capture");
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 50 });
  const resized = await sendToOffscreen({ type: "resize", dataUrl, width });
  return resized.dataUrl || dataUrl;
}

async function verify(tabId, { force = false } = {}) {
  const tabs = await getEnabledTabs();
  if (!tabs[String(tabId)]) return;
  const now = Date.now();
  if (!force) {
    const last = (await chrome.storage.session.get(`vv_${tabId}`))[`vv_${tabId}`] || 0;
    if (now - last < VERIFY_COOLDOWN_MS) return;
  }
  const { openaiKey } = await chrome.storage.local.get("openaiKey");
  if (!openaiKey) {
    await chrome.storage.session.set({ [`st_${tabId}`]: "nokey" });
    await updateBadge(tabId, true);
    return;
  }
  await chrome.storage.session.set({ [`st_${tabId}`]: "checking" });
  const frame = await getFrame(tabId, DEFAULT_WIDTH);
  const { isGame, cost } = await classify(frame, openaiKey);
  await applyVerdict(tabId, isGame, cost);
}

function triggerVerify(tabId, delay = 700) {
  if (debounceTimers[tabId]) return;
  debounceTimers[tabId] = setTimeout(async () => {
    delete debounceTimers[tabId];
    try {
      await verify(tabId);
    } catch (e) {
      await noteError(tabId, e);
    }
  }, delay);
}

async function noteError(tabId, e) {
  const tabs = await getEnabledTabs();
  if (!tabs[String(tabId)]) return;
  await chrome.storage.session.set({ [`st_${tabId}`]: "error", [`err_${tabId}`]: String((e && e.message) || e) });
  await updateBadge(tabId, true);
}

async function tick() {
  const tabs = await getEnabledTabs();
  const legacy = await getLegacyTabs();
  for (const id of Object.keys(tabs)) {
    const tabId = Number(id);
    try {
      if (legacy[String(tabId)]) {
        await verify(tabId, { force: true });
      } else {
        const last = (await chrome.storage.session.get(`vv_${tabId}`))[`vv_${tabId}`] || 0;
        if (Date.now() - last > HEARTBEAT_MS) await verify(tabId, { force: true });
      }
    } catch (e) {
      await noteError(tabId, e);
    }
  }
}

function clearTabState(tabId) {
  return chrome.storage.session.remove([
    `st_${tabId}`,
    `ts_${tabId}`,
    `err_${tabId}`,
    `avg_${tabId}`,
    `costs_${tabId}`,
    `streak_${tabId}`,
    `gstreak_${tabId}`,
    `vv_${tabId}`
  ]);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "tick") {
      await tick();
      sendResponse({ ok: true });
    } else if (msg.type === "shot") {
      triggerVerify(msg.tabId, 400);
      sendResponse({ ok: true });
    } else if (msg.type === "vsignal") {
      const tabId = sender.tab && sender.tab.id;
      if (tabId) triggerVerify(tabId, msg.kind === "videoAdded" ? 400 : 900);
      sendResponse({ ok: true });
    } else if (msg.type === "streamError") {
      await markLegacy(msg.tabId, true);
      triggerVerify(msg.tabId, 500);
      sendResponse({ ok: true });
    } else if (msg.type === "toggle") {
      await setEnabled(msg.tabId, msg.on);
      if (!msg.on) {
        try {
          await chrome.tabs.update(msg.tabId, { muted: false });
        } catch {}
        await clearTabState(msg.tabId);
      }
      sendResponse({ ok: true });
    } else if (msg.type === "getState") {
      const tabs = await getEnabledTabs();
      const legacy = await getLegacyTabs();
      const { openaiKey } = await chrome.storage.local.get("openaiKey");
      const st = await chrome.storage.session.get([
        `st_${msg.tabId}`,
        `ts_${msg.tabId}`,
        `err_${msg.tabId}`,
        `avg_${msg.tabId}`,
        `costs_${msg.tabId}`
      ]);
      const tsVal = st[`ts_${msg.tabId}`] || 0;
      sendResponse({
        enabled: !!tabs[String(msg.tabId)],
        hasKey: !!openaiKey,
        status: st[`st_${msg.tabId}`] || "off",
        ts: tsVal,
        ago: tsVal ? Math.max(0, Math.round((Date.now() - tsVal) / 1000)) : -1,
        error: st[`err_${msg.tabId}`] || "",
        avgCost: st[`avg_${msg.tabId}`] || 0,
        frames: (st[`costs_${msg.tabId}`] || []).length,
        mode: legacy[String(msg.tabId)] ? "poll" : "live"
      });
    } else if (msg.type === "setKey") {
      await chrome.storage.local.set({ openaiKey: msg.key });
      sendResponse({ ok: true });
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await setEnabled(tabId, false);
  await clearTabState(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    const tabs = await getEnabledTabs();
    if (tabs[String(tabId)]) {
      await setEnabled(tabId, false);
      try {
        await chrome.tabs.update(tabId, { muted: false });
      } catch {}
      await clearTabState(tabId);
    }
  }
});

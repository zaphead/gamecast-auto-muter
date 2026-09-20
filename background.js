/* ================================================================
   AI SETTINGS — toggle the model, prompt, and params HERE.
   - MODEL: any vision chat-model id (e.g. "gpt-5-nano").
   - SYSTEM_PROMPT / USER_PROMPT: the classifier prompt. Plain
     true/false text out, no JSON anywhere.
   - MAX_TOKENS: ceiling for the answer. Too low starves the reply
     (empty responses); 300 is plenty for true/false.
   - REASONING_EFFORT: "minimal" keeps answers instant and decisive.
     Higher spends more tokens thinking (and can starve the reply).
   - IMG_DETAIL: "low" (cheap, ~85 tokens) | "high" (hungry).
   - PRICE_IN/OUT_PER_M: $ per 1M tokens. Feeds the avg/frame math.
   HOW IT DECIDES: every 5s the tab is screenshotted and judged.
   If the verdict matches the current state (or there is no state
   yet), it applies immediately. If it DISAGREES, 3 fresh frames are
   judged in parallel and the flip only happens if at least 2 of
   the 3 agree with the dissenter. Blank replies get one instant
   retry; 3 blanks in a row surfaces an error, fewer stay silent.
   ================================================================ */
const AI = {
  MODEL: "gpt-5-nano",
  PRICE_IN_PER_M: 0.05,
  PRICE_OUT_PER_M: 0.4,
  MAX_TOKENS: 300,
  IMG_DETAIL: "low",
  REASONING_EFFORT: "minimal"
};
const DEFAULT_WIDTH = 512;
const CODE_VERSION = "0.6.1";

const SYSTEM_PROMPT = 'Binary sports-vs-ad classifier. Output ONLY the word true or false. No other text, no punctuation, no JSON. An answer is always required — never reply empty. If unsure, make your best guess.';
const USER_PROMPT =
  'Look at the image. Reply true or false, nothing else. You must always answer — never leave the reply blank; when in doubt, guess. ' +
  'true = actual sportscast visible: live play, field/court/rink, players/refs/ball, score bug, sideline, halftime desk talking ball. ' +
  'false = full-screen ad, commercial, promo, black screen, menu, loading spinner, no game. ' +
  'Unsure? Reply false.';

const LABELS = {
  off: "Off",
  on: "Starting",
  checking: "Checking",
  game: "Game",
  ad: "Ad",
  nokey: "No key",
  error: "Error"
};

const busy = new Set();

function defaultState() {
  return { status: "off", lastCost: null, sessionTotal: 0, lastVerify: 0, emptyStreak: 0, error: "" };
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
      reasons: ["BLOBS"],
      justification: "Reliable 5s polling interval for game detection"
    });
  } catch (e) {
    if (!String(e && e.message).includes("Only a single offscreen")) throw e;
  }
}

async function setEnabled(tabId, on) {
  const tabs = await getEnabledTabs();
  if (on) tabs[String(tabId)] = true;
  else delete tabs[String(tabId)];
  await chrome.storage.session.set({ enabledTabs: tabs });
  if (on) {
    await ensureOffscreen();
    await saveState(tabId, { status: "on", error: "" });
  } else {
    try {
      await chrome.tabs.update(tabId, { muted: false });
    } catch {}
    await chrome.storage.session.remove([`tab_${tabId}`]);
  }
  await updateBadge(tabId);
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

async function captureFrame(tab, width) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 50 });
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const height = Math.max(1, Math.round((bmp.height * width) / bmp.width));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").drawImage(bmp, 0, 0, width, height);
  bmp.close();
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 });
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(out);
  });
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
      max_completion_tokens: AI.MAX_TOKENS,
      reasoning_effort: AI.REASONING_EFFORT,
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
  const u = json.usage || {};
  const rawCost = ((u.prompt_tokens || 0) * AI.PRICE_IN_PER_M + (u.completion_tokens || 0) * AI.PRICE_OUT_PER_M) / 1e6;
  const cost = Number.isFinite(rawCost) ? rawCost : 0;
  if (!content.trim()) return { isGame: null, cost };
  const word = content.trim().toLowerCase().match(/^(true|false)\b/);
  if (word) return { isGame: word[1] === "true", cost };
  const any = content.toLowerCase().match(/\b(true|false)\b/);
  return { isGame: any ? any[1] === "true" : null, cost };
}

async function recordCost(tabId, cost) {
  const cur = await loadState(tabId);
  await saveState(tabId, {
    lastCost: cost,
    sessionTotal: cur.sessionTotal + cost,
    lastVerify: Date.now(),
    emptyStreak: 0
  });
}

async function applyVerdict(tabId, isGame) {
  await saveState(tabId, { status: isGame ? "game" : "ad", lastVerify: Date.now(), error: "" });
  try {
    await chrome.tabs.update(tabId, { muted: !isGame });
  } catch {}
  await updateBadge(tabId);
}

async function judge(tabId, tab, apiKey) {
  const frame = await captureFrame(tab, DEFAULT_WIDTH);
  return await classify(frame, apiKey);
}

async function verify(tabId) {
  if (busy.has(tabId)) return;
  busy.add(tabId);
  try {
    const tabs = await getEnabledTabs();
    if (!tabs[String(tabId)]) return;
    const { openaiKey } = await chrome.storage.local.get("openaiKey");
    if (!openaiKey) {
      await saveState(tabId, { status: "nokey" });
      await updateBadge(tabId);
      return;
    }
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      await setEnabled(tabId, false);
      return;
    }
    if (!tab.active) return;
    await saveState(tabId, { status: "checking" });
    let first = await judge(tabId, tab, openaiKey);
    if (first.isGame === null) first = await judge(tabId, tab, openaiKey);
    if (first.isGame === null) {
      const streak = (await loadState(tabId)).emptyStreak + 1;
      await saveState(tabId, {
        lastCost: first.cost,
        lastVerify: Date.now(),
        emptyStreak: streak,
        ...(streak >= 3
          ? { status: "error", error: `Empty response from the model ×${streak}` }
          : {})
      });
      if (streak >= 3) await updateBadge(tabId);
      return;
    }
    await recordCost(tabId, first.cost);
    const cur = await loadState(tabId);
    const prev = cur.status === "game" ? true : cur.status === "ad" ? false : null;
    if (prev === null || first.isGame === prev) {
      await applyVerdict(tabId, first.isGame);
      return;
    }
    const panel = await Promise.allSettled([
      judge(tabId, tab, openaiKey),
      judge(tabId, tab, openaiKey),
      judge(tabId, tab, openaiKey)
    ]);
    let votes = 0;
    for (const r of panel) {
      if (r.status !== "fulfilled") continue;
      await recordCost(tabId, r.value.cost);
      if (r.value.isGame === first.isGame) votes++;
    }
    if (votes >= 2) {
      await applyVerdict(tabId, first.isGame);
    } else {
      await saveState(tabId, { lastVerify: Date.now() });
    }
  } catch (e) {
    const tabs = await getEnabledTabs();
    if (tabs[String(tabId)]) {
      await saveState(tabId, { status: "error", error: String((e && e.message) || e) });
      await updateBadge(tabId);
    }
  } finally {
    busy.delete(tabId);
  }
}

async function tick() {
  const tabs = await getEnabledTabs();
  for (const id of Object.keys(tabs)) {
    await verify(Number(id));
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "tick") {
      await tick();
      sendResponse({ ok: true });
    } else if (msg.type === "toggle") {
      await setEnabled(msg.tabId, msg.on);
      if (msg.on) await verify(msg.tabId);
      sendResponse({ ok: true });
    } else if (msg.type === "getState") {
      const tabs = await getEnabledTabs();
      const enabled = !!tabs[String(msg.tabId)];
      const { openaiKey } = await chrome.storage.local.get("openaiKey");
      const cur = enabled ? await loadState(msg.tabId) : defaultState();
      sendResponse({
        enabled,
        hasKey: !!openaiKey,
        code: CODE_VERSION,
        status: enabled ? cur.status : "off",
        label: enabled ? LABELS[cur.status] || cur.status : LABELS.off,
        ago: cur.lastVerify ? Math.max(0, Math.round((Date.now() - cur.lastVerify) / 1000)) : -1,
        error: cur.error,
        lastCost: cur.lastCost,
        sessionTotal: cur.sessionTotal
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

const POLL_NOTE = "polling lives in offscreen.js";
const DEFAULT_WIDTH = 512;
const MODEL = "gpt-5-nano";
const PRICE_IN_PER_M = 0.05;
const PRICE_OUT_PER_M = 0.4;

const SYSTEM_PROMPT = 'Binary classifier. Output ONLY valid JSON: {"is_game": true/false}. No other text. Look ONLY at the video player area. Ignore browser UI, tabs, and page around the player.';
const USER_PROMPT =
  'Return JSON. Judge ONLY what is inside the video player (ignore browser chrome and surrounding page). ' +
  '{"is_game": true} = player shows actual sportscast: live play, field/court/rink, players/refs/ball, score bug. ' +
  '{"is_game": false} = player shows ad, commercial, promo, menu, loading, no game. Unsure = false.';

async function ensureOffscreen() {
  try {
    if (chrome.offscreen.hasDocument) {
      if (await chrome.offscreen.hasDocument()) return;
    }
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "5s screenshot polling + image resize for game detection"
    });
  } catch (e) {
    if (!String(e && e.message).includes("Only a single offscreen")) throw e;
  }
}

async function getEnabledTabs() {
  const s = await chrome.storage.session.get("enabledTabs");
  return s.enabledTabs || {};
}

async function setEnabled(tabId, on) {
  const tabs = await getEnabledTabs();
  if (on) tabs[String(tabId)] = true;
  else delete tabs[String(tabId)];
  await chrome.storage.session.set({ enabledTabs: tabs });
  if (on) await ensureOffscreen();
  await updateBadge(tabId, on);
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
      model: MODEL,
      reasoning_effort: "minimal",
      max_completion_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: USER_PROMPT },
            { type: "image_url", image_url: { url: dataUrl, detail: "low" } }
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
  const cost = ((u.prompt_tokens || 0) * PRICE_IN_PER_M + (u.completion_tokens || 0) * PRICE_OUT_PER_M) / 1e6;
  let isGame;
  try {
    isGame = JSON.parse(content).is_game === true;
  } catch {
    isGame = /"is_game"\s*:\s*true/.test(content);
  }
  return { isGame, cost };
}

async function checkTab(tabId) {
  const tabs = await getEnabledTabs();
  if (!tabs[String(tabId)]) return;
  const { openaiKey, shotWidth } = await chrome.storage.local.get(["openaiKey", "shotWidth"]);
  const width = shotWidth || DEFAULT_WIDTH;
  if (!openaiKey) {
    await chrome.storage.session.set({ [`st_${tabId}`]: "nokey" });
    await updateBadge(tabId, true);
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
  await chrome.storage.session.set({ [`st_${tabId}`]: "checking" });

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "jpeg",
    quality: 50
  });
  const resized = await chrome.runtime.sendMessage({
    type: "resize",
    dataUrl,
    width
  });
  const { isGame, cost } = await classify(resized.dataUrl || dataUrl, openaiKey);
  const costKey = `costs_${tabId}`;
  const prev = (await chrome.storage.session.get(costKey))[costKey] || [];
  const costs = [...prev, cost].slice(-10);
  const avgCost = costs.reduce((a, b) => a + b, 0) / costs.length;
  await chrome.storage.session.set({
    [`st_${tabId}`]: isGame ? "game" : "ad",
    [`ts_${tabId}`]: Date.now(),
    [costKey]: costs,
    [`avg_${tabId}`]: avgCost
  });
  await chrome.storage.session.remove([`err_${tabId}`]);
  await chrome.tabs.update(tabId, { muted: !isGame });
  await updateBadge(tabId, true);
}

async function tick() {
  const tabs = await getEnabledTabs();
  for (const id of Object.keys(tabs)) {
    try {
      await checkTab(Number(id));
    } catch (e) {
      await chrome.storage.session.set({ [`st_${id}`]: "error", [`err_${id}`]: String((e && e.message) || e) });
      await updateBadge(Number(id), true);
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "tick") {
      await tick();
      sendResponse({ ok: true });
    } else if (msg.type === "toggle") {
      await setEnabled(msg.tabId, msg.on);
      if (!msg.on) {
        try {
          await chrome.tabs.update(msg.tabId, { muted: false });
        } catch {}
        await chrome.storage.session.remove([`st_${msg.tabId}`, `ts_${msg.tabId}`, `err_${msg.tabId}`, `avg_${msg.tabId}`, `costs_${msg.tabId}`]);
      }
      sendResponse({ ok: true });
    } else if (msg.type === "getState") {
      const tabs = await getEnabledTabs();
      const { openaiKey, shotWidth } = await chrome.storage.local.get(["openaiKey", "shotWidth"]);
      const st = await chrome.storage.session.get([`st_${msg.tabId}`, `ts_${msg.tabId}`, `err_${msg.tabId}`, `avg_${msg.tabId}`, `costs_${msg.tabId}`]);
      sendResponse({
        enabled: !!tabs[String(msg.tabId)],
        hasKey: !!openaiKey,
        status: st[`st_${msg.tabId}`] || "off",
        ts: st[`ts_${msg.tabId}`] || 0,
        error: st[`err_${msg.tabId}`] || "",
        width: shotWidth || DEFAULT_WIDTH,
        avgCost: st[`avg_${msg.tabId}`] || 0,
        frames: (st[`costs_${msg.tabId}`] || []).length
      });
    } else if (msg.type === "setWidth") {
      await chrome.storage.local.set({ shotWidth: msg.width });
      sendResponse({ ok: true });
    } else if (msg.type === "setKey") {
      await chrome.storage.local.set({ openaiKey: msg.key });
      sendResponse({ ok: true });
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await setEnabled(tabId, false);
  await chrome.storage.session.remove([`st_${tabId}`, `ts_${tabId}`, `err_${tabId}`, `avg_${tabId}`, `costs_${tabId}`]);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    const tabs = await getEnabledTabs();
    if (tabs[String(tabId)]) {
      await setEnabled(tabId, false);
      try {
        await chrome.tabs.update(tabId, { muted: false });
      } catch {}
      await chrome.storage.session.remove([`st_${tabId}`, `ts_${tabId}`, `err_${tabId}`, `avg_${tabId}`, `costs_${tabId}`]);
    }
  }
});

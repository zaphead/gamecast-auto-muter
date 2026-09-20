const POLL_NOTE = "polling lives in offscreen.js";
const RESIZE_WIDTH = 300;
const MODEL = "gpt-5-nano";

const SYSTEM_PROMPT = 'Binary classifier. Output ONLY {"is_game": true/false}. No other text.';
const USER_PROMPT =
  '{"is_game": true} = actual sportscast: live play, field/court/rink, players/refs/ball, score bug. ' +
  '{"is_game": false} = full-screen ad, commercial, promo, menu, loading, no game. Unsure = false.';

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
      max_completion_tokens: 20,
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
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content || "";
  try {
    return JSON.parse(content).is_game === true;
  } catch {
    return /"is_game"\s*:\s*true/.test(content);
  }
}

async function checkTab(tabId) {
  const tabs = await getEnabledTabs();
  if (!tabs[String(tabId)]) return;
  const { openaiKey } = await chrome.storage.local.get("openaiKey");
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
    width: RESIZE_WIDTH
  });
  const isGame = await classify(resized.dataUrl || dataUrl, openaiKey);
  await chrome.storage.session.set({
    [`st_${tabId}`]: isGame ? "game" : "ad",
    [`ts_${tabId}`]: Date.now()
  });
  await chrome.tabs.update(tabId, { muted: !isGame });
  await updateBadge(tabId, true);
}

async function tick() {
  const tabs = await getEnabledTabs();
  for (const id of Object.keys(tabs)) {
    try {
      await checkTab(Number(id));
    } catch (e) {
      await chrome.storage.session.set({ [`st_${id}`]: "error" });
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
        await chrome.storage.session.remove([`st_${msg.tabId}`, `ts_${msg.tabId}`]);
      }
      sendResponse({ ok: true });
    } else if (msg.type === "getState") {
      const tabs = await getEnabledTabs();
      const { openaiKey } = await chrome.storage.local.get("openaiKey");
      const st = await chrome.storage.session.get([`st_${msg.tabId}`, `ts_${msg.tabId}`]);
      sendResponse({
        enabled: !!tabs[String(msg.tabId)],
        hasKey: !!openaiKey,
        status: st[`st_${msg.tabId}`] || "off",
        ts: st[`ts_${msg.tabId}`] || 0
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
  await chrome.storage.session.remove([`st_${tabId}`, `ts_${tabId}`]);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    const tabs = await getEnabledTabs();
    if (tabs[String(tabId)]) {
      await setEnabled(tabId, false);
      try {
        await chrome.tabs.update(tabId, { muted: false });
      } catch {}
      await chrome.storage.session.remove([`st_${tabId}`, `ts_${tabId}`]);
    }
  }
});

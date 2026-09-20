async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh() {
  const tab = await currentTab();
  if (!tab) return;
  const state = await chrome.runtime.sendMessage({ type: "getState", tabId: tab.id });
  const statusEl = document.getElementById("status");
  const toggleEl = document.getElementById("toggle");
  const labels = {
    off: "off",
    checking: "checking…",
    game: "GAME — unmuted",
    ad: "AD — muted",
    nokey: "no API key",
    error: "error"
  };
  statusEl.textContent = state.enabled ? labels[state.status] || state.status : "off";
  document.getElementById("err").textContent = state.status === "error" && state.error ? state.error : "";
  toggleEl.textContent = state.enabled ? "Turn OFF for this tab" : "Turn ON for this tab";
  toggleEl.onclick = async () => {
    await chrome.runtime.sendMessage({ type: "toggle", tabId: tab.id, on: !state.enabled });
    refresh();
  };
}

document.getElementById("save").onclick = async () => {
  const key = document.getElementById("key").value.trim();
  if (!key) return;
  await chrome.runtime.sendMessage({ type: "setKey", key });
  document.getElementById("key").value = "";
  refresh();
};

chrome.storage.local.get("openaiKey").then(({ openaiKey }) => {
  if (openaiKey) document.getElementById("key").placeholder = "Key saved ✓ (paste to replace)";
});

refresh();
setInterval(refresh, 1000);

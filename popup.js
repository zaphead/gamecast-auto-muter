async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh() {
  const tab = await currentTab();
  if (!tab) return;
  const state = await chrome.runtime.sendMessage({ type: "getState", tabId: tab.id });
  const labels = {
    off: "Off",
    checking: "Checking",
    game: "Game",
    ad: "Ad",
    nokey: "No key",
    error: "Error"
  };
  const statusEl = document.getElementById("status");
  statusEl.textContent = state.enabled ? labels[state.status] || state.status : "Off";
  const led = document.getElementById("led");
  led.className = "led" + (state.enabled ? ` ${state.status}` : "");
  const errEl = document.getElementById("err");
  const hasErr = state.status === "error" && state.error;
  errEl.textContent = hasErr ? state.error : "";
  errEl.classList.toggle("show", !!hasErr);
  const toggle = document.getElementById("toggle");
  if (document.activeElement !== toggle) toggle.checked = !!state.enabled;
  document.getElementById("powerlabel").textContent = state.enabled ? "On — this tab" : "Off";
  const slider = document.getElementById("width");
  if (document.activeElement !== slider) slider.value = state.width ?? 512;
  document.getElementById("widthval").textContent = `${state.width ?? 512}px`;
  document.getElementById("cost").textContent = state.frames
    ? `$${Number(state.avgCost || 0).toFixed(6)}`
    : "—";
  document.getElementById("costk").textContent = state.frames ? `avg/frame · ${state.frames}f` : "avg / frame";
  document.getElementById("mode").textContent = state.enabled ? state.mode || "live" : "—";
  document.getElementById("ver").textContent = `v${chrome.runtime.getManifest().version}`;
}

document.getElementById("toggle").onchange = async (e) => {
  const tab = await currentTab();
  if (!tab) return;
  await chrome.runtime.sendMessage({ type: "toggle", tabId: tab.id, on: e.target.checked });
  refresh();
};

document.getElementById("save").onclick = async () => {
  const key = document.getElementById("key").value.trim();
  if (!key) return;
  await chrome.runtime.sendMessage({ type: "setKey", key });
  document.getElementById("key").value = "";
  refresh();
};

document.getElementById("width").oninput = (e) => {
  document.getElementById("widthval").textContent = `${e.target.value}px`;
};
document.getElementById("width").onchange = async (e) => {
  await chrome.runtime.sendMessage({ type: "setWidth", width: Number(e.target.value) });
  refresh();
};

chrome.storage.local.get("openaiKey").then(({ openaiKey }) => {
  if (openaiKey) document.getElementById("key").placeholder = "Saved — paste to replace";
});

refresh();
setInterval(refresh, 1000);

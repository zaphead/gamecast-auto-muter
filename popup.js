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
  document.getElementById("status").textContent = state.enabled ? labels[state.status] || state.status : "Off";
  const led = document.getElementById("led");
  led.className = "led" + (state.enabled ? ` ${state.status}` : "");
  const errEl = document.getElementById("err");
  const hasErr = state.status === "error" && state.error;
  errEl.textContent = hasErr ? state.error : "";
  errEl.classList.toggle("show", !!hasErr);
  const toggle = document.getElementById("toggle");
  if (document.activeElement !== toggle) toggle.checked = !!state.enabled;
  document.getElementById("powerlabel").textContent = state.enabled ? "On — this tab" : "Off";
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

const gear = document.getElementById("gear");
const keypop = document.getElementById("keypop");
gear.onclick = () => {
  const open = keypop.hidden;
  keypop.hidden = !open;
  gear.classList.toggle("open", open);
  gear.setAttribute("aria-expanded", String(open));
  if (open) document.getElementById("key").focus();
};

document.getElementById("save").onclick = async () => {
  const key = document.getElementById("key").value.trim();
  if (!key) return;
  await chrome.runtime.sendMessage({ type: "setKey", key });
  document.getElementById("key").value = "";
  keypop.hidden = true;
  gear.classList.remove("open");
  gear.setAttribute("aria-expanded", "false");
  refresh();
};

chrome.storage.local.get("openaiKey").then(({ openaiKey }) => {
  if (openaiKey) document.getElementById("key").placeholder = "Saved — paste to replace";
});

refresh();
setInterval(refresh, 1000);

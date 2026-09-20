async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

let timer = 0;

async function refresh() {
  try {
    await refreshInner();
  } catch (e) {
    if (String((e && e.message) || e).includes("Extension context invalidated") && timer) {
      clearInterval(timer);
      timer = 0;
    }
  }
}

async function refreshInner() {
  const tab = await currentTab();
  if (!tab) return;
  const state = await chrome.runtime.sendMessage({ type: "getState", tabId: tab.id });
  document.getElementById("status").textContent = state.label || state.status;
  const led = document.getElementById("led");
  led.className = "led" + (state.enabled ? ` ${state.status}` : "");
  const errEl = document.getElementById("err");
  const hasErr = state.status === "error" && state.error;
  errEl.textContent = hasErr ? state.error : "";
  errEl.classList.toggle("show", !!hasErr);
  const toggle = document.getElementById("toggle");
  if (document.activeElement !== toggle) toggle.checked = !!state.enabled;
  document.getElementById("powerlabel").textContent = state.enabled ? "On — this tab" : "Off";
  document.getElementById("cost").textContent =
    state.lastCost === null || state.lastCost === undefined
      ? "—"
      : `$${Number(state.lastCost).toFixed(2)}`;
  document.getElementById("costk").textContent =
    state.ago < 0 ? "last check" : `last check · ${state.ago}s ago`;
  const mine = chrome.runtime.getManifest().version;
  document.getElementById("ver").textContent = `v${mine}`;
  if (!state.code || state.code !== mine) {
    document.getElementById("status").textContent = "Reload needed";
    document.getElementById("led").className = "led error";
  }
}

document.getElementById("toggle").onchange = async (e) => {
  try {
    const tab = await currentTab();
    if (!tab) return;
    await chrome.runtime.sendMessage({ type: "toggle", tabId: tab.id, on: e.target.checked });
    refresh();
  } catch {}
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
  try {
    const key = document.getElementById("key").value.trim();
    if (!key) return;
    await chrome.runtime.sendMessage({ type: "setKey", key });
    document.getElementById("key").value = "";
    keypop.hidden = true;
    gear.classList.remove("open");
    gear.setAttribute("aria-expanded", "false");
    refresh();
  } catch {}
};

chrome.storage.local.get("openaiKey").then(({ openaiKey }) => {
  if (openaiKey) document.getElementById("key").placeholder = "Saved — paste to replace";
});

refresh();
timer = setInterval(refresh, 1000);

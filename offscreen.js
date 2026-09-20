// 5s metronome only. Screenshots + judging live in background.js.
const TICK_MS = 5000;
let started = false;

if (!started) {
  started = true;
  setInterval(() => {
    chrome.runtime.sendMessage({ type: "tick" }).catch(() => {});
  }, TICK_MS);
}

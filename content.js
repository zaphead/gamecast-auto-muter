// Generic <video> watcher. Runs in every frame, knows nothing about ad verdicts —
// it just reports player signals so the background knows WHEN to look.
const watched = new WeakSet();

function describe(v) {
  return {
    src: v.currentSrc || v.getAttribute("src") || "",
    dur: String(v.duration),
    paused: v.paused
  };
}

function report(kind, extra) {
  try {
    chrome.runtime.sendMessage({ type: "vsignal", kind, ...extra }).catch(() => {});
  } catch {}
}

function watch(v) {
  if (watched.has(v)) return;
  watched.add(v);
  report("videoAdded", { playing: !v.paused, ...describe(v) });
  ["play", "pause", "ended", "emptied", "seeking", "seeked", "durationchange", "loadeddata"].forEach((ev) =>
    v.addEventListener(ev, () => report("videoEvent", { event: ev, ...describe(v) }))
  );
  new MutationObserver(() => report("videoEvent", { event: "srcchange", ...describe(v) })).observe(v, {
    attributes: true,
    attributeFilter: ["src"]
  });
}

try {
  document.querySelectorAll("video").forEach(watch);
  new MutationObserver(() => document.querySelectorAll("video").forEach(watch)).observe(
    document.documentElement,
    { childList: true, subtree: true }
  );
} catch {}

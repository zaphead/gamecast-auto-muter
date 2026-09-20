const TICK_MS = 5000;
const SAMPLE_MS = 500;
const HASH_W = 64;
const HASH_H = 36;
const SHOT_THRESHOLD = 28;

const streams = new Map();
let tickStarted = false;

function drawFrame(video, width) {
  const scale = width / video.videoWidth;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.6);
}

function resizeImage(dataUrl, width) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = width / img.width;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.6));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function startStream(tabId, streamId, width) {
  stopStream(tabId);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }
  });
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  const st = { stream, video, width: width || 512, prev: null, timer: 0 };
  streams.set(String(tabId), st);
  st.timer = setInterval(() => sample(tabId), SAMPLE_MS);
}

function stopStream(tabId) {
  const st = streams.get(String(tabId));
  if (!st) return;
  clearInterval(st.timer);
  try {
    st.stream.getTracks().forEach((t) => t.stop());
  } catch {}
  streams.delete(String(tabId));
}

function sample(tabId) {
  const st = streams.get(String(tabId));
  if (!st || !st.video.videoWidth || st.video.videoWidth < 100) return;
  const canvas = document.createElement("canvas");
  canvas.width = HASH_W;
  canvas.height = HASH_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(st.video, 0, 0, HASH_W, HASH_H);
  const d = ctx.getImageData(0, 0, HASH_W, HASH_H).data;
  const cur = new Uint8Array(HASH_W * HASH_H);
  for (let i = 0; i < cur.length; i++) cur[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
  if (st.prev) {
    let sum = 0;
    for (let i = 0; i < cur.length; i++) sum += Math.abs(cur[i] - st.prev[i]);
    if (sum / cur.length > SHOT_THRESHOLD) {
      chrome.runtime.sendMessage({ type: "shot", tabId }).catch(() => {});
    }
  }
  st.prev = cur;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "resize") {
      try {
        sendResponse({ dataUrl: await resizeImage(msg.dataUrl, msg.width || 512) });
      } catch {
        sendResponse({});
      }
    } else if (msg.type === "startStream") {
      try {
        await startStream(msg.tabId, msg.streamId, msg.width);
        sendResponse({ ok: true });
      } catch (e) {
        chrome.runtime.sendMessage({ type: "streamError", tabId: msg.tabId }).catch(() => {});
        sendResponse({ ok: false });
      }
    } else if (msg.type === "stopStream") {
      stopStream(msg.tabId);
      sendResponse({ ok: true });
    } else if (msg.type === "frame") {
      const st = streams.get(String(msg.tabId));
      if (st && st.video.videoWidth) {
        sendResponse({ dataUrl: drawFrame(st.video, msg.width || st.width || 512) });
      } else {
        sendResponse({});
      }
    }
  })();
  return true;
});

if (!tickStarted) {
  tickStarted = true;
  setInterval(() => {
    chrome.runtime.sendMessage({ type: "tick" }).catch(() => {});
  }, TICK_MS);
}

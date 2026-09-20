const INTERVAL_MS = 5000;
let started = false;

function resizeImage(dataUrl, width) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = width / img.width;
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, width, h);
      resolve(canvas.toDataURL("image/jpeg", 0.6));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "resize") {
    resizeImage(msg.dataUrl, msg.width || 300).then(
      (dataUrl) => sendResponse({ dataUrl }),
      () => sendResponse({})
    );
    return true;
  }
});

function start() {
  if (started) return;
  started = true;
  setInterval(() => {
    chrome.runtime.sendMessage({ type: "tick" }).catch(() => {});
  }, INTERVAL_MS);
}

start();

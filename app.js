/* Steam Happy Paint
 * Every stroke you draw is stamped with the Steam Happy face,
 * so literally everything you draw becomes Steam Happy. :D
 */

const SRC = "steam-happy-but-high-quality-v0-22ku6htw4u0c1.webp";

const stage = document.getElementById("stage");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const hint = document.getElementById("hint");

const sizeEl = document.getElementById("size");
const densityEl = document.getElementById("density");
const chaosEl = document.getElementById("chaos");
const sizeVal = document.getElementById("sizeVal");
const densityVal = document.getElementById("densityVal");
const chaosVal = document.getElementById("chaosVal");

const undoBtn = document.getElementById("undo");
const clearBtn = document.getElementById("clear");
const saveBtn = document.getElementById("save");

let dpr = 1;
let cssW = 0;
let cssH = 0;

let faceSprite = null;   // preprocessed image (background made transparent)
let drawing = false;
let lastX = 0;
let lastY = 0;
let leftover = 0;        // carried distance for even spacing between stamps

const MAX_HISTORY = 12;
const history = [];

/* -------------------- Canvas setup / resize -------------------- */
function setupCanvas(preserve) {
  const rect = stage.getBoundingClientRect();
  let temp = null;

  if (preserve && canvas.width > 0) {
    temp = document.createElement("canvas");
    temp.width = canvas.width;
    temp.height = canvas.height;
    temp.getContext("2d").drawImage(canvas, 0, 0);
  }

  dpr = window.devicePixelRatio || 1;
  cssW = Math.max(1, rect.width);
  cssH = Math.max(1, rect.height);

  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cssW, cssH);

  if (temp) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); // device pixels
    ctx.drawImage(temp, 0, 0);
    ctx.restore();
  }

  // Resizing changes pixel dimensions, so snapshots would misalign — reset.
  history.length = 0;
  pushHistory();
}

/* -------------------- Undo history -------------------- */
function pushHistory() {
  try {
    history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (history.length > MAX_HISTORY) history.shift();
  } catch (e) {
    /* getImageData can fail on a tainted canvas; ignore. */
  }
}

function undo() {
  if (history.length <= 1) {
    // Back to the last known blank/base state.
    if (history.length === 1) ctx.putImageData(history[0], 0, 0);
    return;
  }
  history.pop();
  const snap = history[history.length - 1];
  ctx.putImageData(snap, 0, 0);
}

/* -------------------- Stamp helpers -------------------- */
function spacing() {
  const size = +sizeEl.value;
  const d = +densityEl.value / 100;          // 0..1
  const factor = 1.15 - d * 0.9;              // dense -> smaller gap
  return Math.max(3, size * factor);
}

function stampFace(x, y) {
  if (!faceSprite) return;
  const size = +sizeEl.value;
  const chaos = +chaosEl.value / 100;

  const scaleJit = 1 + (Math.random() * 2 - 1) * chaos * 0.35;
  const s = size * scaleJit;
  const angle = (Math.random() * 2 - 1) * chaos * Math.PI * 0.55;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.drawImage(faceSprite, -s / 2, -s / 2, s, s);
  ctx.restore();
}

function addStampsTo(x, y) {
  const dx = x - lastX;
  const dy = y - lastY;
  const dist = Math.hypot(dx, dy);
  const step = spacing();

  if (dist === 0) return;

  const ux = dx / dist;
  const uy = dy / dist;

  let d = leftover;
  while (d <= dist) {
    stampFace(lastX + ux * d, lastY + uy * d);
    d += step;
  }
  leftover = d - dist;

  lastX = x;
  lastY = y;
}

/* -------------------- Pointer handling -------------------- */
function pointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function onDown(e) {
  if (!faceSprite) return;
  drawing = true;
  canvas.setPointerCapture(e.pointerId);
  hint.classList.add("hidden");

  pushHistory(); // snapshot BEFORE this stroke so undo removes the whole stroke

  const p = pointerPos(e);
  lastX = p.x;
  lastY = p.y;
  leftover = 0;
  stampFace(p.x, p.y); // immediate dot on click
}

function onMove(e) {
  if (!drawing) return;
  // Use coalesced events for smoother, gap-free strokes when available.
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of events) {
    const p = pointerPos(ev);
    addStampsTo(p.x, p.y);
  }
}

function onUp(e) {
  if (!drawing) return;
  drawing = false;
  try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
}

/* -------------------- Buttons -------------------- */
function clearCanvas() {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.restore();
  history.length = 0;
  pushHistory();
  hint.classList.remove("hidden");
}

function savePng() {
  const link = document.createElement("a");
  link.download = "steam-happy-masterpiece.png";
  try {
    link.href = canvas.toDataURL("image/png");
    link.click();
  } catch (e) {
    alert("無法匯出圖片。請透過本機伺服器（而非 file://）開啟本頁，下載功能才能正常運作。");
  }
}

/* -------------------- Image preprocessing --------------------
 * Flood-fill from the edges to make the connected background transparent,
 * while keeping interior white areas (like the eyes) intact.
 */
function makeTransparentSprite(img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const cx = c.getContext("2d");
  cx.drawImage(img, 0, 0, w, h);

  let imageData;
  try {
    imageData = cx.getImageData(0, 0, w, h);
  } catch (e) {
    return img; // tainted (file://) — fall back to the raw image
  }

  const px = imageData.data;
  const visited = new Uint8Array(w * h);
  const stack = [];

  const isBg = (idx) => {
    const i = idx * 4;
    // treat near-white OR already-transparent as background
    return (px[i + 3] < 20) || (px[i] > 232 && px[i + 1] > 232 && px[i + 2] > 232);
  };

  const seed = (x, y) => {
    const idx = y * w + x;
    if (!visited[idx] && isBg(idx)) {
      visited[idx] = 1;
      stack.push(idx);
    }
  };

  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }

  while (stack.length) {
    const idx = stack.pop();
    px[idx * 4 + 3] = 0; // transparent
    const x = idx % w;
    const y = (idx / w) | 0;
    if (x > 0)     seed(x - 1, y);
    if (x < w - 1) seed(x + 1, y);
    if (y > 0)     seed(x, y - 1);
    if (y < h - 1) seed(x, y + 1);
  }

  cx.putImageData(imageData, 0, 0);
  return c;
}

/* -------------------- Wire up -------------------- */
function bindUI() {
  const sync = () => {
    sizeVal.textContent = sizeEl.value;
    densityVal.textContent = densityEl.value;
    chaosVal.textContent = chaosEl.value;
  };
  sizeEl.addEventListener("input", sync);
  densityEl.addEventListener("input", sync);
  chaosEl.addEventListener("input", sync);
  sync();

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);

  undoBtn.addEventListener("click", undo);
  clearBtn.addEventListener("click", clearCanvas);
  saveBtn.addEventListener("click", savePng);

  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
    }
  });

  let rt;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => setupCanvas(true), 150);
  });
}

function init() {
  bindUI();
  setupCanvas(false);

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    faceSprite = makeTransparentSprite(img);
  };
  img.onerror = () => {
    console.error("Could not load Steam Happy image:", SRC);
  };
  img.src = SRC;
}

init();

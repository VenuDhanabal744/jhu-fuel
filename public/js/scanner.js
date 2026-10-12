// Live barcode scanner: a full-screen camera view that reads barcodes as you point the
// phone at them - no photo to take. Uses the browser's BarcodeDetector where it exists
// (Android Chrome) and ZXing (WebAssembly) everywhere else, including iPhone Safari.

import { h } from './ui.js';
import { decodeFrame } from './barcode.js';

const DETECTOR_FORMATS = ['ean_13', 'upc_a', 'upc_e', 'ean_8'];

async function nativeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const formats = DETECTOR_FORMATS.filter((f) => supported.includes(f));
    return formats.length ? new window.BarcodeDetector({ formats }) : null;
  } catch {
    return null;
  }
}

/** A short beep. The AudioContext must be created during a tap, so open the scanner from a click. */
function beeper() {
  let ctx = null;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    /* no audio */
  }
  return () => {
    navigator.vibrate?.(60);
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 1800;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
  };
}

export function cameraAvailable() {
  return !!navigator.mediaDevices?.getUserMedia;
}

/**
 * Open the scanner.
 *  - single mode: closes after the first barcode and calls onCode(code).
 *  - multi mode: keeps scanning; onCode(code) may return a label (e.g. the product name) to
 *    show as confirmation. The same code isn't reported twice in a row.
 * onClose(reason) is called once when the scanner closes ('done' | 'cancel' | 'error').
 * Returns a promise that rejects if the camera can't be opened.
 */
export async function openScanner({ multi = false, onCode, onClose, title = 'Point at a barcode' }) {
  const beep = beeper();
  const video = h('video', { playsinline: true, muted: true, autoplay: true, 'aria-label': 'Camera' });
  video.muted = true;
  video.setAttribute('playsinline', '');
  const status = h('div', { class: 'scan-status' }, 'Starting camera…');
  const count = h('span');
  const frame = h('div', { class: 'scan-frame' }, h('div', { class: 'scan-line' }));
  const torchBtn = h('button', { type: 'button', class: 'scan-btn hidden', 'aria-label': 'Flashlight', onclick: () => toggleTorch() }, '🔦');
  const doneBtn = multi ? h('button', { type: 'button', class: 'scan-btn primary', onclick: () => close('done') }, 'Done ', count) : null;
  const overlay = h(
    'div',
    { class: 'scanner', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Barcode scanner' },
    video,
    h('div', { class: 'scan-shade' }, frame),
    h(
      'div',
      { class: 'scan-top' },
      h('button', { type: 'button', class: 'scan-btn', 'aria-label': 'Close scanner', onclick: () => close('cancel') }, '✕'),
      h('div', { class: 'scan-title' }, title),
      torchBtn,
    ),
    h('div', { class: 'scan-bottom' }, status, doneBtn),
  );

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (err) {
    throw new Error(
      err?.name === 'NotAllowedError'
        ? 'Camera access is turned off for this app. Turn it on in Settings › Safari › Camera (or Settings › Privacy › Camera), or take a photo of the barcode instead.'
        : 'Couldn’t open the camera. Take a photo of the barcode instead.',
      { cause: err },
    );
  }

  document.body.append(overlay);
  document.body.style.overflow = 'hidden';
  video.srcObject = stream;
  await video.play().catch(() => {});
  const track = stream.getVideoTracks()[0];
  if (track?.getCapabilities?.().torch) torchBtn.classList.remove('hidden');

  let torch = false;
  async function toggleTorch() {
    torch = !torch;
    await track.applyConstraints({ advanced: [{ torch }] }).catch(() => (torch = false));
    torchBtn.classList.toggle('on', torch);
  }

  const detector = await nativeDetector();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let closed = false;
  let last = { code: null, at: 0 };
  let found = 0;
  let frameNo = 0;
  status.textContent = multi ? 'Scan items one after another, then tap Done.' : 'Hold the barcode inside the box.';

  function close(reason) {
    if (closed) return;
    closed = true;
    for (const t of stream.getTracks()) t.stop();
    overlay.remove();
    document.body.style.overflow = '';
    document.removeEventListener('visibilitychange', onHide);
    onClose?.(reason);
  }
  // iOS stops the camera when the app is backgrounded; close cleanly rather than freeze.
  const onHide = () => document.hidden && close('cancel');
  document.addEventListener('visibilitychange', onHide);

  async function readFrame() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    if (detector) {
      const codes = await detector.detect(video);
      return codes.find((c) => /^\d{6,14}$/.test(c.rawValue))?.rawValue ?? null;
    }
    // Decode the middle band where the on-screen box is (faster and less noise than the
    // whole frame); every 4th frame look at the whole picture with the slower, thorough mode.
    const full = ++frameNo % 4 === 0;
    const sw = full ? vw : Math.round(vw * 0.85);
    const sh = full ? vh : Math.round(vh * 0.45);
    const scale = Math.min(1, 1280 / sw);
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
    return decodeFrame(ctx.getImageData(0, 0, canvas.width, canvas.height), { tryHarder: full });
  }

  async function loop() {
    while (!closed) {
      let code = null;
      try {
        code = await readFrame();
      } catch {
        /* a bad frame - keep going */
      }
      if (closed) return;
      const now = Date.now();
      if (code && !(code === last.code && now - last.at < 4000)) {
        last = { code, at: now };
        beep();
        frame.classList.add('hit');
        setTimeout(() => frame.classList.remove('hit'), 500);
        if (!multi) {
          close('done');
          onCode(code);
          return;
        }
        found++;
        count.textContent = `(${found})`;
        status.textContent = `Looking up ${code}…`;
        Promise.resolve(onCode(code))
          .then((label) => !closed && (status.textContent = `✓ ${label || code} — scan the next one`))
          .catch((err) => !closed && (status.textContent = `⚠ ${err.message}`));
      } else if (code) {
        last.at = now; // still pointing at the same item
      }
      await new Promise((r) => setTimeout(r, detector ? 150 : 60));
    }
  }
  loop();
  return { close };
}

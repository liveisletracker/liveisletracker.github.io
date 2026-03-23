// ═══════════════════════════════════════════════════════════════════
//  The Isle - Screen Capture & OCR Pipeline (ocr.js)
//  Screen Capture API, region selection, Tesseract.js OCR
// ═══════════════════════════════════════════════════════════════════

// ── State ──
let mediaStream = null;
let videoElement = null;
let captureCanvas = null;
let captureCtx = null;
let cropRegion = null;
let ocrWorker = null;
let ocrRunning = false;
let lastCoords = null;
let ocrLastSuccess = 0;

// ── Regex (matches server.py patterns) ──
const LAT_RE = /Lat[:\s]*(-?[\d,]+\.?\d*)/;
const LONG_RE = /Long[:\s]*(-?[\d,]+\.?\d*)/;
const ALT_RE = /Alt[:\s]*(-?[\d,]+\.?\d*)/;

// ── Screen Capture ──

async function startScreenCapture() {
  try {
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'never' },
    });
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      alert('Screen sharing was denied. Click "Share Screen" to try again.');
    } else {
      alert('Screen capture failed: ' + err.message);
    }
    return false;
  }

  const videoTrack = mediaStream.getVideoTracks()[0];

  // Handle user stopping share via browser UI
  videoTrack.addEventListener('ended', () => {
    stopOCR();
    const btn = document.getElementById('capture-btn');
    btn.textContent = 'SHARE SCREEN';
    btn.classList.remove('active-capture');
    updateOCRStatus('offline');
  });

  // Hidden video element to receive stream
  videoElement = document.createElement('video');
  videoElement.srcObject = mediaStream;
  videoElement.autoplay = true;
  videoElement.muted = true;

  await new Promise(resolve => {
    videoElement.onloadedmetadata = resolve;
  });
  await videoElement.play();

  // Offscreen canvas for frame capture
  captureCanvas = document.createElement('canvas');
  captureCanvas.width = videoElement.videoWidth;
  captureCanvas.height = videoElement.videoHeight;
  captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });

  return true;
}

function stopScreenCapture() {
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  videoElement = null;
  captureCanvas = null;
  captureCtx = null;
}

// ── Region Selection (replaces setup_region.py) ──

async function selectRegion() {
  // Capture current frame
  captureCtx.drawImage(videoElement, 0, 0);

  return new Promise(resolve => {
    const overlay = document.getElementById('region-overlay');
    const regionCanvas = document.getElementById('region-canvas');
    const rCtx = regionCanvas.getContext('2d');

    regionCanvas.width = window.innerWidth;
    regionCanvas.height = window.innerHeight;

    // Scale captured frame to fit overlay
    const imgW = captureCanvas.width;
    const imgH = captureCanvas.height;
    const scaleX = regionCanvas.width / imgW;
    const scaleY = regionCanvas.height / imgH;
    const scale = Math.min(scaleX, scaleY);
    const drawW = imgW * scale;
    const drawH = imgH * scale;
    const offsetX = (regionCanvas.width - drawW) / 2;
    const offsetY = (regionCanvas.height - drawH) / 2;

    function drawFrame() {
      rCtx.fillStyle = '#0a0e17';
      rCtx.fillRect(0, 0, regionCanvas.width, regionCanvas.height);
      rCtx.drawImage(captureCanvas, offsetX, offsetY, drawW, drawH);

      // Instruction bar
      rCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      rCtx.fillRect(0, 0, regionCanvas.width, 50);
      rCtx.fillStyle = '#5ccfe6';
      rCtx.font = '14px Consolas';
      rCtx.textAlign = 'center';
      rCtx.fillText(
        'Click and drag to select the Asset Location region  |  ESC to cancel',
        regionCanvas.width / 2, 30
      );
    }

    drawFrame();
    overlay.style.display = 'block';

    let startX = 0, startY = 0, drawing = false;

    function onMouseDown(e) {
      startX = e.clientX;
      startY = e.clientY;
      drawing = true;
    }

    function onMouseMove(e) {
      if (!drawing) return;
      drawFrame();
      // Selection rectangle
      rCtx.strokeStyle = '#5ccfe6';
      rCtx.lineWidth = 2;
      rCtx.setLineDash([6, 4]);
      rCtx.strokeRect(startX, startY, e.clientX - startX, e.clientY - startY);
      rCtx.setLineDash([]);
    }

    function onMouseUp(e) {
      if (!drawing) return;
      drawing = false;

      const rectX = Math.min(startX, e.clientX);
      const rectY = Math.min(startY, e.clientY);
      const rectW = Math.abs(e.clientX - startX);
      const rectH = Math.abs(e.clientY - startY);

      if (rectW < 50 || rectH < 20) return; // Too small

      // Convert screen coords back to video coords
      cropRegion = {
        x: Math.max(0, Math.round((rectX - offsetX) / scale)),
        y: Math.max(0, Math.round((rectY - offsetY) / scale)),
        width: Math.round(rectW / scale),
        height: Math.round(rectH / scale),
      };
      cropRegion.width = Math.min(cropRegion.width, imgW - cropRegion.x);
      cropRegion.height = Math.min(cropRegion.height, imgH - cropRegion.y);

      cleanup();
      overlay.style.display = 'none';
      resolve(cropRegion);
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        cleanup();
        overlay.style.display = 'none';
        resolve(null);
      }
    }

    function cleanup() {
      regionCanvas.removeEventListener('mousedown', onMouseDown);
      regionCanvas.removeEventListener('mousemove', onMouseMove);
      regionCanvas.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keydown', onKeyDown);
    }

    regionCanvas.addEventListener('mousedown', onMouseDown);
    regionCanvas.addEventListener('mousemove', onMouseMove);
    regionCanvas.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', onKeyDown);
  });
}

// ── Tesseract.js Init ──

async function initOCR() {
  ocrWorker = await Tesseract.createWorker('eng', 1, {
    logger: () => {},
  });
  await ocrWorker.setParameters({
    tessedit_pageseg_mode: '6',
    tessedit_char_whitelist: '0123456789.,-:AltLaong ',
  });
}

// ── Image Preprocessing (matches server.py pipeline) ──

function preprocessFrame() {
  // Draw current video frame
  captureCtx.drawImage(videoElement, 0, 0);

  // Get cropped region
  const imageData = captureCtx.getImageData(
    cropRegion.x, cropRegion.y,
    cropRegion.width, cropRegion.height
  );

  // Grayscale → threshold → invert
  // The game's teal text is ~150-220 brightness; background is ~20-50
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const binary = gray > 100 ? 255 : 0;
    const inverted = 255 - binary;
    data[i] = data[i + 1] = data[i + 2] = inverted;
    data[i + 3] = 255;
  }

  // Put processed pixels on temp canvas
  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = cropRegion.width;
  tmpCanvas.height = cropRegion.height;
  const tmpCtx = tmpCanvas.getContext('2d');
  tmpCtx.putImageData(imageData, 0, 0);

  // Upscale 2x with nearest neighbor
  const procCanvas = document.createElement('canvas');
  procCanvas.width = cropRegion.width * 2;
  procCanvas.height = cropRegion.height * 2;
  const procCtx = procCanvas.getContext('2d');
  procCtx.imageSmoothingEnabled = false;
  procCtx.drawImage(tmpCanvas, 0, 0, procCanvas.width, procCanvas.height);

  return procCanvas;
}

// ── Coordinate Parsing (matches server.py regex) ──

function parseCoords(text) {
  const latMatch = text.match(LAT_RE);
  const longMatch = text.match(LONG_RE);

  if (!latMatch || !longMatch) return null;

  const lat = parseFloat(latMatch[1].replace(/,/g, ''));
  const long = parseFloat(longMatch[1].replace(/,/g, ''));

  if (isNaN(lat) || isNaN(long)) return null;

  // Game coords are in the -500k to +500k range — reject OCR misreads
  if (Math.abs(lat) > 1000000 || Math.abs(long) > 1000000) return null;

  let alt = null;
  const altMatch = text.match(ALT_RE);
  if (altMatch) {
    alt = parseFloat(altMatch[1].replace(/,/g, ''));
    if (isNaN(alt)) alt = null;
  }

  return { lat, long, alt };
}

// ── OCR Loop ──

async function ocrLoop() {
  if (!ocrRunning || !cropRegion || !ocrWorker || !videoElement) return;

  try {
    const processedCanvas = preprocessFrame();
    const { data: { text } } = await ocrWorker.recognize(processedCanvas);

    const coords = parseCoords(text);

    if (coords) {
      // Jump rejection (matches server.py threshold of 50000)
      let valid = true;
      if (lastCoords) {
        if (Math.abs(coords.lat - lastCoords.lat) > 50000) valid = false;
        if (Math.abs(coords.long - lastCoords.long) > 50000) valid = false;
      }

      if (valid) {
        lastCoords = coords;
        ocrLastSuccess = Date.now();
        updateMyPosition(coords.lat, coords.long, coords.alt);
        updateOCRStatus('active');
      }
    }
  } catch (err) {
    // Silent — OCR fails when Tab menu is closed (expected)
  }

  // Update status based on time since last success
  const elapsed = Date.now() - ocrLastSuccess;
  if (ocrLastSuccess > 0 && elapsed > 5000) {
    updateOCRStatus('stale');
  }

  // Schedule next iteration (~5 Hz, self-adjusting)
  if (ocrRunning) {
    setTimeout(ocrLoop, 200);
  }
}

// ── Public API ──

async function beginCapture() {
  const btn = document.getElementById('capture-btn');

  // Check browser support
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    alert('Screen capture requires a modern browser with HTTPS.');
    return;
  }

  btn.textContent = 'Starting capture...';

  const captureOk = await startScreenCapture();
  if (!captureOk) {
    btn.textContent = 'SHARE SCREEN';
    return;
  }

  btn.textContent = 'Select region...';
  const region = await selectRegion();
  if (!region) {
    stopScreenCapture();
    btn.textContent = 'SHARE SCREEN';
    return;
  }

  btn.textContent = 'Loading OCR engine...';
  if (!ocrWorker) {
    await initOCR();
  }

  btn.textContent = 'OCR ACTIVE';
  btn.classList.add('active-capture');
  updateOCRStatus('offline'); // Will switch to 'active' on first successful read

  ocrRunning = true;
  ocrLoop();
}

function stopOCR() {
  ocrRunning = false;
  stopScreenCapture();
  cropRegion = null;
  lastCoords = null;
}

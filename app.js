// ═══════════════════════════════════════════════════════════════════
//  The Isle - Multiplayer Position Tracker (app.js)
//  Room management, WebSocket sync, multi-player map rendering
// ═══════════════════════════════════════════════════════════════════

// ── Server Config ──
// For local dev: 'ws://localhost:3000'
// For production: 'wss://your-app.fly.dev'
const WS_URL = 'ws://localhost:3000';

// ── Constants ──
const MAX_PLAYERS = 8;
const MAX_TRAIL = 500;
const TRAIL_EXPIRE_MS = 20 * 60 * 1000; // 20 minutes
const WRITE_THROTTLE_MS = 500;

// ── State ──
let ws = null;
let roomCode = null;
let playerId = null;
let playerName = '';
let playerColor = '#5ccfe6';
let players = new Map(); // id → {name, color, lat, long, alt, lastUpdate, trail:[]}

// Map image — bounds in game coordinates (official map grid coords × 1000)
// X = horizontal = Long, Y = vertical = Lat
// Image corners: top-left (Lat=-615, Long=-560), bottom-right (Lat=615, Long=675)
const MAP_BOUNDS = { minX: -560000, maxX: 675000, minY: -615000, maxY: 615000 };
const mapImg = new Image();
mapImg.src = 'map-light.png';
let mapLoaded = false;
mapImg.onload = () => { mapLoaded = true; };

const waterImg = new Image();
waterImg.src = 'water.png';
let waterLoaded = false;
waterImg.onload = () => { waterLoaded = true; };

const mudImg = new Image();
mudImg.src = 'mudOverlay.png';
let mudLoaded = false;
mudImg.onload = () => { mudLoaded = true; };

const structImg = new Image();
structImg.src = 'structures.png';
let structLoaded = false;
structImg.onload = () => { structLoaded = true; };

const migrationImg = new Image();
migrationImg.src = 'migration.png';
let migrationLoaded = false;
migrationImg.onload = () => { migrationLoaded = true; };

const sanctImg = new Image();
sanctImg.src = 'sanctuaries.png';
let sanctLoaded = false;
sanctImg.onload = () => { sanctLoaded = true; };

// Toggle state for optional overlays
let showMigration = false;
let showSanctuaries = false;
let showSalt = false;

// Salt deposit locations (long × 1000, lat × 1000)
const SALT_LOCATIONS = [
  [-320000, 315000],
  [-136000, 270000],
  [-285000, 130000],
  [-180000, 125000],
  [-92000, 37000],
  [13000, 286000],
  [35000, 403000],
  [123000, 178000],
  [55000, 74000],
  [55000, 72000],
  [54000, 73000],
  [278000, 57000],
  [385000, 142000],
  [332000, 519000],
  [478000, 322000],
  [457000, -51000],
  [541000, -251000],
  [420000, -205000],
  [367000, -270000],
  [468000, -492000],
  [-24000, -384000],
  [49000, -232000],
  [155000, -182000],
  [236000, -323000],
  [230000, -441000],
  [297000, -162000],
  [157000, -53000],
  [-20000, -54000],
  [-152000, -115000],
  [-302000, -25000],
  [-395000, -110000],
];

// Map state
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
let viewX = 0, viewY = 0, zoom = 0.0008;
let dragging = false, dragStartX = 0, dragStartY = 0, dragViewX = 0, dragViewY = 0;
let autoCenter = true;
let lastWrite = 0;
let mouseWorldX = 0, mouseWorldY = 0;
let mouseOnCanvas = false;
// Waypoints: playerId → {lat, long} or null
let waypoints = new Map();

// ── WebSocket ──

function connectWebSocket() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      document.getElementById('connection-status').textContent = '';
      resolve();
    };

    ws.onerror = () => {
      reject(new Error('Could not connect to server'));
    };

    ws.onclose = () => {
      document.getElementById('connection-status').textContent = '(Disconnected)';
      ws = null;
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleServerMessage(msg);
    };
  });
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'created':
      roomCode = msg.room;
      playerId = msg.playerId;
      playerColor = msg.color;
      players.set(playerId, { name: playerName, color: msg.color, lat: null, long: null, alt: null, lastUpdate: Date.now(), trail: [] });
      enterTracker();
      break;

    case 'joined':
      playerId = msg.playerId;
      playerColor = msg.color;
      // Load existing players
      for (const p of msg.players) {
        players.set(p.id, { ...p, trail: [] });
      }
      enterTracker();
      break;

    case 'error':
      showLobbyError(msg.message);
      break;

    case 'player_joined':
      players.set(msg.playerId, { name: msg.name, color: msg.color, lat: null, long: null, alt: null, lastUpdate: Date.now(), trail: [] });
      renderSidebar();
      break;

    case 'update': {
      const p = players.get(msg.playerId);
      if (p) {
        if (msg.lat != null && msg.long != null) {
          const last = p.trail[p.trail.length - 1];
          if (!last || last[0] !== msg.lat || last[1] !== msg.long) {
            p.trail.push([msg.lat, msg.long, Date.now()]);
            if (p.trail.length > MAX_TRAIL) p.trail = p.trail.slice(-MAX_TRAIL);
          }
        }
        p.lat = msg.lat;
        p.long = msg.long;
        p.alt = msg.alt;
        p.lastUpdate = msg.lastUpdate;
      }
      renderSidebar();
      break;
    }

    case 'player_left':
      players.delete(msg.playerId);
      waypoints.delete(msg.playerId);
      renderSidebar();
      break;

    case 'waypoint':
      if (msg.lat != null && msg.long != null) {
        waypoints.set(msg.playerId, { lat: msg.lat, long: msg.long });
      } else {
        waypoints.delete(msg.playerId);
      }
      break;
  }
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── Lobby ──

function showJoinInput() {
  const section = document.getElementById('join-section');
  section.style.display = section.style.display === 'none' ? 'block' : 'none';
  if (section.style.display === 'block') {
    document.getElementById('room-code-input').focus();
  }
}

function showLobbyError(msg) {
  document.getElementById('lobby-error').textContent = msg;
}

async function createRoom() {
  playerName = document.getElementById('player-name').value.trim();
  if (!playerName) { showLobbyError('Enter your name'); return; }

  try {
    await connectWebSocket();
    wsSend({ type: 'create', name: playerName });
  } catch (e) {
    showLobbyError('Failed to connect: ' + e.message);
  }
}

async function joinRoom() {
  playerName = document.getElementById('player-name').value.trim();
  if (!playerName) { showLobbyError('Enter your name'); return; }

  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  if (code.length !== 6) { showLobbyError('Room code must be 6 characters'); return; }

  roomCode = code;

  try {
    await connectWebSocket();
    wsSend({ type: 'join', room: code, name: playerName });
  } catch (e) {
    showLobbyError('Failed to connect: ' + e.message);
  }
}

function enterTracker() {
  document.getElementById('lobby').classList.add('hidden');
  document.getElementById('tracker').classList.add('active');
  document.getElementById('room-code-display').textContent = roomCode;
  resize();
  draw();
}

function leaveRoom() {
  if (ws) { ws.close(); ws = null; }
  stopOCR();
  players.clear();
  roomCode = null;
  playerId = null;

  document.getElementById('lobby').classList.remove('hidden');
  document.getElementById('tracker').classList.remove('active');
  document.getElementById('lobby-error').textContent = '';
  document.getElementById('capture-btn').textContent = 'SHARE SCREEN';
  document.getElementById('capture-btn').classList.remove('active-capture');
}

let codeHidden = false;
function toggleCodeVisibility(e) {
  e.stopPropagation();
  codeHidden = !codeHidden;
  const display = document.getElementById('room-code-display');
  const btn = document.getElementById('hide-code-btn');
  if (codeHidden) {
    display.textContent = '******';
    btn.style.color = '#e06c75';
  } else {
    display.textContent = roomCode;
    btn.style.color = '#556';
  }
}

function copyRoomCode() {
  navigator.clipboard.writeText(roomCode).then(() => {
    const badge = document.getElementById('room-badge');
    const hint = badge.querySelector('.copy-hint');
    hint.textContent = 'copied!';
    setTimeout(() => { hint.textContent = 'copy'; }, 1500);
  });
}

// ── Sidebar ──

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function formatAgo(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 3) return 'now';
  if (sec < 60) return sec + 's ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  return Math.floor(min / 60) + 'h ago';
}

// Re-render sidebar every second to keep "ago" times fresh
// Also prune expired trail entries
setInterval(() => {
  if (players.size === 0) return;
  const cutoff = Date.now() - TRAIL_EXPIRE_MS;
  for (const [, p] of players) {
    if (p.trail.length > 1 && p.trail[0][2] < cutoff) {
      const fresh = p.trail.filter(t => t[2] >= cutoff);
      // Always keep the last point (current position)
      p.trail = fresh.length > 0 ? fresh : [p.trail[p.trail.length - 1]];
    }
  }
  renderSidebar();
}, 1000);

function renderSidebar() {
  document.getElementById('player-count').textContent = `${players.size}/${MAX_PLAYERS}`;

  const listEl = document.getElementById('player-list');
  listEl.innerHTML = '';
  for (const [id, p] of players) {
    const isStale = p.lastUpdate && (Date.now() - p.lastUpdate > 5000);
    const div = document.createElement('div');
    div.className = 'player-item' + (isStale ? ' player-stale' : '');
    const ago = p.lastUpdate && p.lat != null ? formatAgo(Date.now() - p.lastUpdate) : '';
    div.innerHTML = `
      <span class="player-dot" style="background:${p.color}"></span>
      <div style="flex:1;overflow:hidden">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <span class="player-name" style="color:${p.color}">${escapeHtml(p.name)}${id === playerId ? ' (you)' : ''}</span>
          <span class="player-coords">${p.lat != null ? p.lat.toFixed(0) + ', ' + p.long.toFixed(0) : '---'}</span>
        </div>
        ${ago ? '<div style="color:#556;font-size:9px;margin-top:1px">updated ' + ago + '</div>' : ''}
      </div>
    `;
    listEl.appendChild(div);
  }

  const local = players.get(playerId);
  if (local) {
    document.getElementById('lat-val').textContent = local.lat != null ? local.lat.toFixed(3) : '---';
    document.getElementById('long-val').textContent = local.long != null ? local.long.toFixed(3) : '---';
    document.getElementById('alt-val').textContent = local.alt != null ? local.alt.toFixed(3) : '---';
  }
}

// ── Position Update (called from ocr.js) ──

function updateMyPosition(lat, long, alt) {
  if (!ws || !playerId) return;

  const now = Date.now();
  if (now - lastWrite < WRITE_THROTTLE_MS) return;
  lastWrite = now;

  // Update local player trail immediately (don't wait for server echo)
  const local = players.get(playerId);
  if (local) {
    const last = local.trail[local.trail.length - 1];
    if (!last || last[0] !== lat || last[1] !== long) {
      local.trail.push([lat, long, Date.now()]);
      if (local.trail.length > MAX_TRAIL) local.trail = local.trail.slice(-MAX_TRAIL);
    }
    local.lat = lat;
    local.long = long;
    local.alt = alt;
    local.lastUpdate = now;
  }

  wsSend({ type: 'position', lat, long, alt });
  renderSidebar();
}

function updateOCRStatus(status) {
  const dot = document.getElementById('ocr-dot');
  dot.className = 'ocr-dot ' + status;

  const statusEl = document.getElementById('status');
  if (status === 'active') {
    statusEl.textContent = 'Tracking (OCR active)';
    statusEl.className = '';
  } else if (status === 'stale') {
    statusEl.textContent = 'Tracking (last known position)';
    statusEl.className = '';
  } else {
    statusEl.textContent = 'Waiting for OCR data... Press Tab in-game';
    statusEl.className = 'detecting';
  }
}

// ── Canvas / Map ──

function resize() {
  if (!canvas.parentElement) return;
  canvas.width = canvas.parentElement.clientWidth;
  canvas.height = canvas.parentElement.clientHeight;
}
window.addEventListener('resize', resize);

canvas.addEventListener('mousedown', e => {
  dragging = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragViewX = viewX;
  dragViewY = viewY;
  autoCenter = false;
});
canvas.addEventListener('mousemove', e => {
  if (!dragging) return;
  viewX = dragViewX + (e.clientX - dragStartX) / zoom;
  viewY = dragViewY + (e.clientY - dragStartY) / zoom;
});
canvas.addEventListener('mouseup', () => dragging = false);
canvas.addEventListener('mouseleave', () => dragging = false);
canvas.addEventListener('wheel', e => {
  const factor = e.deltaY > 0 ? 0.85 : 1.18;
  zoom *= factor;
  zoom = Math.max(0.0002, Math.min(0.1, zoom));
  e.preventDefault();
});
canvas.addEventListener('dblclick', () => { autoCenter = true; });
canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (!playerId) return;
  const rect = canvas.getBoundingClientRect();
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const sx = (e.clientX - rect.left) * (canvas.width / rect.width);
  const sy = (e.clientY - rect.top) * (canvas.height / rect.height);
  const wLong = (sx - cx) / zoom - viewX;
  const wLat = (sy - cy) / zoom - viewY;
  // If already have a waypoint near where we clicked, clear it
  const existing = waypoints.get(playerId);
  if (existing) {
    const [ex, ey] = worldToScreen(existing.long, existing.lat);
    const dist = Math.sqrt((sx - ex) ** 2 + (sy - ey) ** 2);
    if (dist < 30) {
      waypoints.delete(playerId);
      wsSend({ type: 'waypoint', lat: null, long: null });
      return;
    }
  }
  waypoints.set(playerId, { lat: wLat, long: wLong });
  wsSend({ type: 'waypoint', lat: wLat, long: wLong });
});
canvas.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const sx = (e.clientX - rect.left) * (canvas.width / rect.width);
  const sy = (e.clientY - rect.top) * (canvas.height / rect.height);
  mouseWorldX = (sx - cx) / zoom - viewX;
  mouseWorldY = (sy - cy) / zoom - viewY;
  mouseOnCanvas = true;
});
canvas.addEventListener('mouseleave', () => { mouseOnCanvas = false; });

function worldToScreen(wx, wy) {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  return [
    cx + (wx + viewX) * zoom,
    cy + (wy + viewY) * zoom  // Y not flipped — matches game convention (positive = south)
  ];
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function draw() {
  if (!document.getElementById('tracker').classList.contains('active')) {
    requestAnimationFrame(draw);
    return;
  }

  ctx.fillStyle = '#0a0e17';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let anyReady = false;
  for (const [, p] of players) {
    if (p.lat != null) { anyReady = true; break; }
  }

  if (!anyReady && players.size === 0) {
    ctx.fillStyle = '#5ccfe6';
    ctx.font = '16px Consolas';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for players...', canvas.width / 2, canvas.height / 2);
    requestAnimationFrame(draw);
    return;
  }

  // Map image
  if (mapLoaded) {
    const [mapSX, mapSY] = worldToScreen(MAP_BOUNDS.minX, MAP_BOUNDS.minY); // top-left (NW corner)
    const [mapEX, mapEY] = worldToScreen(MAP_BOUNDS.maxX, MAP_BOUNDS.maxY); // bottom-right (SE corner)
    const mapW = mapEX - mapSX;
    const mapH = mapEY - mapSY;
    ctx.globalAlpha = 0.85;
    ctx.drawImage(mapImg, mapSX, mapSY, mapW, mapH);
    if (waterLoaded) {
      ctx.drawImage(waterImg, mapSX, mapSY, mapW, mapH);
    }
    if (mudLoaded) {
      ctx.drawImage(mudImg, mapSX, mapSY, mapW, mapH);
    }
    if (structLoaded) {
      ctx.drawImage(structImg, mapSX, mapSY, mapW, mapH);
    }
    if (showMigration && migrationLoaded) {
      ctx.drawImage(migrationImg, mapSX, mapSY, mapW, mapH);
    }
    if (showSanctuaries && sanctLoaded) {
      ctx.drawImage(sanctImg, mapSX, mapSY, mapW, mapH);
    }
    if (showSalt) {
      for (const [lng, lat] of SALT_LOCATIONS) {
        const [sx, sy] = worldToScreen(lng, lat);
        ctx.fillStyle = 'rgba(255, 105, 180, 0.7)';
        ctx.beginPath();
        ctx.arc(sx, sy, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 105, 180, 0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1.0;
  }

  // Grid
  const startWX = -viewX - canvas.width / 2 / zoom;
  const endWX = -viewX + canvas.width / 2 / zoom;
  const startWY = -viewY - canvas.height / 2 / zoom;
  const endWY = -viewY + canvas.height / 2 / zoom;

  // Major grid — 100k game units = 100 on official map
  const majorGrid = 100000;
  ctx.strokeStyle = 'rgba(200, 220, 255, 0.12)';
  ctx.lineWidth = 1;
  for (let gx = Math.floor(startWX / majorGrid) * majorGrid; gx < endWX; gx += majorGrid) {
    const [sx] = worldToScreen(gx, 0);
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, canvas.height); ctx.stroke();
  }
  for (let gy = Math.floor(startWY / majorGrid) * majorGrid; gy < endWY; gy += majorGrid) {
    const [, sy] = worldToScreen(0, gy);
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(canvas.width, sy); ctx.stroke();
  }

  // Minor grid — 50k game units = 50 on official map (subdivides major grid)
  const minorGrid = 50000;
  ctx.strokeStyle = 'rgba(200, 220, 255, 0.05)';
  for (let gx = Math.floor(startWX / minorGrid) * minorGrid; gx < endWX; gx += minorGrid) {
    if (gx % majorGrid === 0) continue; // skip major lines
    const [sx] = worldToScreen(gx, 0);
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, canvas.height); ctx.stroke();
  }
  for (let gy = Math.floor(startWY / minorGrid) * minorGrid; gy < endWY; gy += minorGrid) {
    if (gy % majorGrid === 0) continue;
    const [, sy] = worldToScreen(0, gy);
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(canvas.width, sy); ctx.stroke();
  }

  // Grid labels — major (bold white) and minor (smaller, dimmer)
  // Major labels (every 100)
  ctx.font = 'bold 11px Consolas';
  ctx.textAlign = 'left';
  for (let gx = Math.floor(startWX / majorGrid) * majorGrid; gx < endWX; gx += majorGrid) {
    const [sx] = worldToScreen(gx, startWY);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = 2;
    ctx.strokeText((gx / 1000).toFixed(0), sx + 2, 14);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.fillText((gx / 1000).toFixed(0), sx + 2, 14);
  }
  ctx.textAlign = 'right';
  for (let gy = Math.floor(startWY / majorGrid) * majorGrid; gy < endWY; gy += majorGrid) {
    const [, sy] = worldToScreen(startWX, gy);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = 2;
    ctx.strokeText((gy / 1000).toFixed(0), 30, sy - 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.fillText((gy / 1000).toFixed(0), 30, sy - 2);
  }
  // Minor labels (every 50, skip majors)
  ctx.font = '9px Consolas';
  ctx.textAlign = 'left';
  for (let gx = Math.floor(startWX / minorGrid) * minorGrid; gx < endWX; gx += minorGrid) {
    if (gx % majorGrid === 0) continue;
    const [sx] = worldToScreen(gx, startWY);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 2;
    ctx.strokeText((gx / 1000).toFixed(0), sx + 2, 14);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.fillText((gx / 1000).toFixed(0), sx + 2, 14);
  }
  ctx.textAlign = 'right';
  for (let gy = Math.floor(startWY / minorGrid) * minorGrid; gy < endWY; gy += minorGrid) {
    if (gy % majorGrid === 0) continue;
    const [, sy] = worldToScreen(startWX, gy);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 2;
    ctx.strokeText((gy / 1000).toFixed(0), 30, sy - 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.fillText((gy / 1000).toFixed(0), 30, sy - 2);
  }

  // Sector labels (name, long × 1000, lat × 1000)
  const SECTOR_LABELS = [
    ['Jungle I Sector', 94910, -74000],
    ['Water Access', 56000, -214000],
    ['Northern Jungle', 181000, -359000],
    ['North Lake', 326000, -384000],
    ['East Swamp', 471000, -134000],
    ['Swamps', 71000, 256000],
    ['South Plains', -124000, 171000],
    ['West Rail Access', -239000, 31000],
    ['Highlands J Sector', -119000, -29000],
    ['West Access', -384000, -134000],
    ['Northwest Ridge', -104000, -309000],
  ];
  ctx.font = 'bold 16px Consolas';
  ctx.textAlign = 'center';
  for (const [label, lng, lat] of SECTOR_LABELS) {
    const [sx, sy] = worldToScreen(lng, lat);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.lineWidth = 4;
    ctx.strokeText(label, sx, sy);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.fillText(label, sx, sy);
  }

  // Building labels (smaller, less prominent)
  const BUILDING_LABELS = [
    ['D10', -22000, -399000],
    ['C14', 208000, -424000],
    ['Port', 478000, -264000],
    ['Volcano Bunker', 283000, -234000],
    ['I12', 86910, -104000],
    ['K15', 253910, 31000],
    ['Swamp Tunnel', 124910, 118000],
    ['Entrance', 24910, 103000],
    ['Perimeter', -40090, 118000],
    ['H4', -300090, -142000],
    ['North Dome', -110090, -182000],
  ];
  ctx.font = '11px Consolas';
  ctx.textAlign = 'center';
  for (const [label, lng, lat] of BUILDING_LABELS) {
    const [sx, sy] = worldToScreen(lng, lat);
    ctx.strokeStyle = 'rgba(120, 50, 180, 0.9)';
    ctx.lineWidth = 3;
    ctx.strokeText(label, sx, sy);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.fillText(label, sx, sy);
  }

  // Draw all players
  for (const [id, p] of players) {
    const color = p.color || '#5ccfe6';
    const isLocal = id === playerId;

    // Trail line (trail stores [lat, long], worldToScreen takes (long, lat))
    if (p.trail.length > 1) {
      ctx.strokeStyle = hexToRgba(color, 0.3);
      ctx.lineWidth = 2;
      ctx.beginPath();
      const [sx0, sy0] = worldToScreen(p.trail[0][1], p.trail[0][0]);
      ctx.moveTo(sx0, sy0);
      for (let i = 1; i < p.trail.length; i++) {
        const [sx, sy] = worldToScreen(p.trail[i][1], p.trail[i][0]);
        ctx.lineTo(sx, sy);
      }
      ctx.stroke();

      // Trail dots (last 50)
      for (let i = Math.max(0, p.trail.length - 50); i < p.trail.length; i++) {
        const [sx, sy] = worldToScreen(p.trail[i][1], p.trail[i][0]);
        const alpha = (i - p.trail.length + 50) / 50;
        ctx.fillStyle = hexToRgba(color, Math.max(0.1, alpha * 0.6));
        ctx.beginPath();
        ctx.arc(sx, sy, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Position marker (long=horizontal, lat=vertical)
    if (p.lat != null && p.long != null) {
      const [px, py] = worldToScreen(p.long, p.lat);

      // Blinking halo for visibility
      const pulse = (Math.sin(Date.now() / 400 + (isLocal ? 0 : 2)) + 1) / 2; // 0-1
      const haloRadius = (isLocal ? 22 : 18) + pulse * 8;
      ctx.fillStyle = hexToRgba(color, 0.06 + pulse * 0.1);
      ctx.beginPath();
      ctx.arc(px, py, haloRadius, 0, Math.PI * 2);
      ctx.fill();

      // Static glow
      ctx.fillStyle = hexToRgba(color, 0.15);
      ctx.beginPath();
      ctx.arc(px, py, isLocal ? 16 : 12, 0, Math.PI * 2);
      ctx.fill();

      // Inner dot
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, py, isLocal ? 6 : 5, 0, Math.PI * 2);
      ctx.fill();

      // Name label
      ctx.fillStyle = color;
      ctx.font = '11px Consolas';
      ctx.textAlign = 'center';
      const ago = p.lastUpdate ? formatAgo(Date.now() - p.lastUpdate) : '';
      ctx.fillText(p.name + (ago ? '  ' + ago : ''), px, py - 16);
    }
  }

  // Waypoints
  for (const [id, wp] of waypoints) {
    const p = players.get(id);
    if (!p || wp.lat == null) continue;
    const color = p.color || '#5ccfe6';
    const [wx, wy] = worldToScreen(wp.long, wp.lat);
    const pulse = (Math.sin(Date.now() / 300) + 1) / 2;

    // Pulsing outer ring
    const ringRadius = 12 + pulse * 6;
    ctx.strokeStyle = hexToRgba(color, 0.3 + pulse * 0.4);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(wx, wy, ringRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Inner diamond shape
    const size = 8;
    ctx.fillStyle = hexToRgba(color, 0.8);
    ctx.beginPath();
    ctx.moveTo(wx, wy - size);
    ctx.lineTo(wx + size, wy);
    ctx.lineTo(wx, wy + size);
    ctx.lineTo(wx - size, wy);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Label
    ctx.font = '10px Consolas';
    ctx.textAlign = 'center';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.lineWidth = 2;
    ctx.strokeText(p.name + "'s waypoint", wx, wy - 20);
    ctx.fillStyle = color;
    ctx.fillText(p.name + "'s waypoint", wx, wy - 20);

    // Dashed line from player to waypoint
    if (p.lat != null && p.long != null) {
      const [px, py] = worldToScreen(p.long, p.lat);
      ctx.strokeStyle = hexToRgba(color, 0.25);
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(wx, wy);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Hint text
  const local = players.get(playerId);
  if (!local || local.lat == null) {
    ctx.fillStyle = '#f0c674';
    ctx.font = '14px Consolas';
    ctx.textAlign = 'center';
    ctx.fillText('Share your screen and press Tab in-game', canvas.width / 2, 30);
  }

  // Cursor coordinates
  if (mouseOnCanvas) {
    const coordText = `${(mouseWorldY / 1000).toFixed(0)}, ${(mouseWorldX / 1000).toFixed(0)}`;
    ctx.font = 'bold 13px Consolas';
    ctx.textAlign = 'center';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.lineWidth = 3;
    ctx.strokeText(coordText, canvas.width / 2, canvas.height - 12);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.fillText(coordText, canvas.width / 2, canvas.height - 12);
  }

  // Auto-center on local player (X=Long, Y=Lat)
  if (autoCenter && local && local.lat != null && local.long != null) {
    viewX = -local.long;
    viewY = -local.lat;
  }

  requestAnimationFrame(draw);
}

// ── Overlay Toggles ──

function toggleMigration() {
  showMigration = !showMigration;
  const btn = document.getElementById('toggle-migration');
  btn.classList.toggle('active-capture', showMigration);
}

function toggleSanctuaries() {
  showSanctuaries = !showSanctuaries;
  const btn = document.getElementById('toggle-sanctuaries');
  btn.classList.toggle('active-capture', showSanctuaries);
}

function toggleSalt() {
  showSalt = !showSalt;
  const btn = document.getElementById('toggle-salt');
  btn.classList.toggle('active-capture', showSalt);
}

// ── Keyboard shortcuts ──
document.getElementById('room-code-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') joinRoom();
});
document.getElementById('player-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const joinSection = document.getElementById('join-section');
    if (joinSection.style.display === 'block') {
      document.getElementById('room-code-input').focus();
    }
  }
});

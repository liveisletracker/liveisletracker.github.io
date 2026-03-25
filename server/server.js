const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const MAX_NAME_LEN = 16;
const RATE_LIMIT = 10; // max messages per second
const ROOM_EXPIRE_MS = 30 * 60 * 1000; // 30 min (empty rooms)
const ROOM_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks (absolute max)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const COLORS = [
  '#5ccfe6', '#f0c674', '#c678dd', '#e06c75',
  '#98c379', '#d19a66', '#61afef', '#56b6c2',
];

// ── State ──
const rooms = new Map(); // code → { players: Map<id, {ws, name, color, lat, long, alt, lastUpdate}>, createdAt }

function generateCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function broadcast(room, msg, excludeId) {
  const data = JSON.stringify(msg);
  for (const [id, player] of room.players) {
    if (id !== excludeId && player.ws.readyState === 1) {
      player.ws.send(data);
    }
  }
}

function getPlayerList(room) {
  const list = [];
  for (const [id, p] of room.players) {
    list.push({ id, name: p.name, color: p.color, lat: p.lat, long: p.long, alt: p.alt, lastUpdate: p.lastUpdate });
  }
  return list;
}

function removePlayer(playerId, room, code) {
  if (!room || !room.players.has(playerId)) return;
  room.players.delete(playerId);
  broadcast(room, { type: 'player_left', playerId });
  if (room.players.size === 0) {
    room.emptyAt = Date.now();
  }
  console.log(`[-] ${playerId} left ${code} (${room.players.size} players)`);
}

// ── Cleanup ──
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    // Sweep stale players (dead WebSocket connections that never fired 'close')
    for (const [id, player] of room.players) {
      if (player.ws.readyState !== 1) { // 1 = OPEN
        removePlayer(id, room, code);
      }
    }
    // Force-close rooms older than 1 week
    if (now - room.createdAt > ROOM_MAX_AGE_MS) {
      for (const [id, player] of room.players) {
        player.ws.send(JSON.stringify({ type: 'room_expired', message: 'This room has been open for over 2 weeks and has expired. Please refresh and create a new room!' }));
        player.ws.close(1000, 'Room expired');
      }
      rooms.delete(code);
      console.log(`[x] Room ${code} force-expired (age limit)`);
      continue;
    }
    // Remove empty rooms after 30 min
    if (room.players.size === 0 && room.emptyAt && now - room.emptyAt > ROOM_EXPIRE_MS) {
      rooms.delete(code);
      console.log(`[x] Room ${code} expired`);
    }
  }
}, 60000);

// ── Server ──
const wss = new WebSocketServer({ port: PORT });
console.log(`WebSocket relay running on port ${PORT}`);

// ── Heartbeat ── keep connections alive & detect dead clients
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 60000);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let playerId = null;
  let roomCode = null;
  let msgCount = 0;
  let msgResetTime = Date.now();

  ws.on('message', (raw) => {
    // Rate limiting
    const now = Date.now();
    if (now - msgResetTime > 1000) { msgCount = 0; msgResetTime = now; }
    if (++msgCount > RATE_LIMIT) return;

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'create': {
        const name = String(msg.name || '').trim().slice(0, MAX_NAME_LEN);
        if (!name) { ws.send(JSON.stringify({ type: 'error', message: 'Name required' })); return; }

        const code = generateCode();
        playerId = generateId();
        roomCode = code;

        rooms.set(code, {
          players: new Map(),
          createdAt: now,
          emptyAt: null,
        });

        const room = rooms.get(code);
        const color = COLORS[0];
        room.players.set(playerId, { ws, name, color, lat: null, long: null, alt: null, lastUpdate: now });

        ws.send(JSON.stringify({ type: 'created', room: code, playerId, color }));
        console.log(`[+] ${name} created room ${code}`);
        break;
      }

      case 'join': {
        const name = String(msg.name || '').trim().slice(0, MAX_NAME_LEN);
        const code = String(msg.room || '').trim().toUpperCase();
        if (!name) { ws.send(JSON.stringify({ type: 'error', message: 'Name required' })); return; }

        const room = rooms.get(code);
        if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found' })); return; }
        if (room.players.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ type: 'error', message: `Room full (${MAX_PLAYERS}/${MAX_PLAYERS})` })); return; }

        playerId = generateId();
        roomCode = code;
        const color = COLORS[room.players.size % COLORS.length];
        room.players.set(playerId, { ws, name, color, lat: null, long: null, alt: null, lastUpdate: now });
        room.emptyAt = null;

        // Tell the new player about everyone
        ws.send(JSON.stringify({ type: 'joined', playerId, color, players: getPlayerList(room) }));

        // Tell everyone else about the new player
        broadcast(room, { type: 'player_joined', playerId, name, color }, playerId);
        console.log(`[+] ${name} joined room ${code} (${room.players.size} players)`);
        break;
      }

      case 'position': {
        if (!playerId || !roomCode) return;
        const room = rooms.get(roomCode);
        if (!room) return;
        const player = room.players.get(playerId);
        if (!player) return;

        const lat = Number(msg.lat);
        const long = Number(msg.long);
        const alt = msg.alt != null ? Number(msg.alt) : null;

        // Validate coordinate ranges
        if (isNaN(lat) || isNaN(long) || Math.abs(lat) > 1000000 || Math.abs(long) > 1000000) return;
        if (alt != null && (isNaN(alt) || Math.abs(alt) > 1000000)) return;

        player.lat = lat;
        player.long = long;
        player.alt = alt;
        player.lastUpdate = now;

        broadcast(room, { type: 'update', playerId, lat, long, alt, lastUpdate: now }, playerId);
        break;
      }

      case 'waypoint': {
        if (!playerId || !roomCode) return;
        const room = rooms.get(roomCode);
        if (!room) return;
        if (!room.players.has(playerId)) return;

        // null waypoint = clear it
        if (msg.lat == null || msg.long == null) {
          broadcast(room, { type: 'waypoint', playerId, lat: null, long: null });
          break;
        }

        const wLat = Number(msg.lat);
        const wLong = Number(msg.long);
        if (isNaN(wLat) || isNaN(wLong) || Math.abs(wLat) > 1000000 || Math.abs(wLong) > 1000000) return;

        broadcast(room, { type: 'waypoint', playerId, lat: wLat, long: wLong });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (playerId && roomCode) {
      const room = rooms.get(roomCode);
      removePlayer(playerId, room, roomCode);
    }
  });
});

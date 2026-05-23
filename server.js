const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = 8000;
const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Simple file-based JSON store
function readStore(name) {
  const fp = path.join(DATA_DIR, name + '.json');
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function writeStore(name, data) {
  const fp = path.join(DATA_DIR, name + '.json');
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
}

function readStoreArray(name) {
  return readStore(name) ?? [];
}

function writeStoreArray(name, data) {
  writeStore(name, data);
}

// --- Data stores ---
function getUsers() { return readStore('users') ?? {}; }
function saveUsers(u) { writeStore('users', u); }

function getLeaderboard() { return readStore('leaderboard') ?? {}; }
function saveLeaderboard(lb) { writeStore('leaderboard', lb); }

function getRecordings() { return readStore('recordings') ?? {}; }
function saveRecordings(r) { writeStore('recordings', r); }

function getUploadCounter() { return readStore('uploadCounter') ?? 0; }
function saveUploadCounter(c) { writeStore('uploadCounter', c); }

function getVerificationQueue() { return readStoreArray('verificationQueue'); }
function saveVerificationQueue(q) { writeStoreArray('verificationQueue', q); }

const TRACK_CATEGORIES = ['official', 'community'];
function getTrackId(name) {
  return crypto.createHash('sha256').update(name).digest('hex');
}

// --- Express App ---
const app = express();

// --- CORS middleware ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.wasm')) {
      res.setHeader('Content-Type', 'application/wasm');
    }
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
    if (filePath.endsWith('.track')) {
      res.setHeader('Content-Type', 'application/octet-stream');
    }
  }
}));

// --- API Endpoints (all under /v6/ prefix, matching the game's ku="v6/" config) ---

// GET /v6/leaderboard
app.get('/v6/leaderboard', (req, res) => {
  const trackId = req.query.trackId;
  const skip = parseInt(req.query.skip) || 0;
  const amount = parseInt(req.query.amount) || 50;
  const onlyVerified = req.query.onlyVerified === 'true';
  const userTokenHash = req.query.userTokenHash;

  const lb = getLeaderboard();
  const entries = lb[trackId] ?? [];

  let filtered = entries;
  if (onlyVerified) {
    filtered = entries.filter(e => e.verifiedState === 2);
  }

  filtered.sort((a, b) => (a.frames ?? Infinity) - (b.frames ?? Infinity));

  const total = filtered.length;
  const paged = filtered.slice(skip, skip + amount);

  const mapped = paged.map(e => ({
    id: e.uploadId,
    userId: e.userToken ? crypto.createHash('sha256').update(e.userToken).digest('hex') : null,
    nickname: e.nickname,
    frames: e.frames,
    carStyle: e.carStyle,
    verifiedState: e.verifiedState,
    countryCode: e.countryCode
  }));

  let userEntry = null;
  if (userTokenHash) {
    const match = filtered.find(e => {
      const hash = e.userToken ? crypto.createHash('sha256').update(e.userToken).digest('hex') : null;
      return hash === userTokenHash;
    });
    if (match) {
      userEntry = {
        id: match.uploadId,
        userId: userTokenHash,
        nickname: match.nickname,
        frames: match.frames,
        carStyle: match.carStyle,
        verifiedState: match.verifiedState,
        countryCode: match.countryCode
      };
    }
  }

  res.json({ entries: mapped, total, userEntry });
});

// POST /v6/leaderboard
app.post('/v6/leaderboard', (req, res) => {
  const { version, userToken, nickname, countryCode, carStyle, trackId, frames, recording, onlyVerified } = req.body;

  const uploadId = getUploadCounter() + 1;
  saveUploadCounter(uploadId);

  const entry = {
    uploadId,
    nickname: nickname || 'Anonymous',
    countryCode: countryCode || null,
    carStyle: carStyle || '',
    trackId,
    frames: parseInt(frames) || 0,
    recording,
    userToken: userToken || null,
    verifiedState: 0,
    submittedAt: new Date().toISOString()
  };

  const lb = getLeaderboard();
  if (!lb[trackId]) lb[trackId] = [];
  lb[trackId].push(entry);
  saveLeaderboard(lb);

  // Store recording
  const recordings = getRecordings();
  recordings[uploadId] = { recording, frames: entry.frames, verifiedState: 0, carStyle };
  saveRecordings(recordings);

  // Add to verification queue
  const queue = getVerificationQueue();
  queue.push({ id: uploadId, recording, frames: entry.frames, trackId });
  saveVerificationQueue(queue);

  // Return just the uploadId (simple response as the game expects)
  res.json(uploadId);
});

// GET /v6/recordings
app.get('/v6/recordings', (req, res) => {
  const ids = req.query.ids ? req.query.ids.split(',').map(Number) : [];
  const recordings = getRecordings();
  const result = ids.map(id => {
    const r = recordings[id];
    if (!r) return null;
    return {
      recording: r.recording,
      verifiedState: r.verifiedState ?? 0,
      frames: r.frames,
      carStyle: r.carStyle ?? ''
    };
  });
  res.json(result);
});

// GET /v6/user
app.get('/v6/user', (req, res) => {
  const { userToken } = req.query;
  if (!userToken) return res.status(400).json({ error: 'Missing userToken' });

  const users = getUsers();
  const user = users[userToken];
  if (!user) return res.json(null);

  res.json({
    nickname: user.nickname,
    countryCode: user.countryCode,
    carStyle: user.carStyle,
    isVerifier: user.isVerifier || false
  });
});

// POST /v6/user
app.post('/v6/user', (req, res) => {
  const { version, userToken, nickname, countryCode, carStyle } = req.body;
  if (!userToken) return res.status(400).json({ error: 'Missing userToken' });

  const users = getUsers();
  users[userToken] = {
    nickname: nickname || 'Anonymous',
    countryCode: countryCode || null,
    carStyle: carStyle || '',
    isVerifier: users[userToken]?.isVerifier || false
  };
  saveUsers(users);

  res.json({ success: true });
});

// POST /v6/verifyRecordings
app.post('/v6/verifyRecordings', (req, res) => {
  const { version, userToken, trackId, maxFrames, getEstimatedRemaining, recordings } = req.body;

  const users = getUsers();
  const user = users[userToken];
  if (!user || !user.isVerifier) {
    return res.status(403).json({ error: 'User is not a verifier' });
  }

  // Parse recordings
  let recs;
  try { recs = JSON.parse(recordings); } catch { recs = []; }

  const unverifiedRecordings = recs.map(r => ({
    id: r.id,
    recording: r.recording,
    frames: r.frames
  }));

  // Auto-verify (in production this would run physics simulation)
  const allRecordings = getRecordings();
  for (const ur of unverifiedRecordings) {
    if (allRecordings[ur.id]) {
      allRecordings[ur.id].verifiedState = 1; // Mark as verified
    }
  }
  saveRecordings(allRecordings);

  // Remove from queue
  const queue = getVerificationQueue();
  const verifiedIds = new Set(unverifiedRecordings.map(r => r.id));
  saveVerificationQueue(queue.filter(q => !verifiedIds.has(q.id)));

  res.json({
    unverifiedRecordings: [],
    exhaustive: true,
    estimatedRemaining: 0
  });
});

// GET /v6/iceServers
app.get('/v6/iceServers', (req, res) => {
  res.json([]);
});

// --- Multiplayer WebSocket ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Multiplayer rooms: key -> { host: WebSocket, guests: Map<sessionId, WebSocket>, createdAt: number }
const rooms = new Map();

wss.on('connection', (ws, req) => {
  const url = req.url;

  if (url === '/v6/multiplayer/host') {
    handleHostConnection(ws);
  } else if (url === '/v6/multiplayer/join') {
    handleJoinConnection(ws);
  } else {
    ws.close();
  }
});

function handleHostConnection(ws) {
  let roomKey = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'createInvite') {
        // Room key may be undefined on first call (client's sn is uninitialized)
        roomKey = msg.key || crypto.randomUUID().replace(/-/g, '').substring(0, 6).toUpperCase();
        rooms.set(roomKey, { host: ws, guests: new Map(), createdAt: Date.now() });

        ws.send(JSON.stringify({
          type: 'createInvite',
          inviteCode: roomKey,
          key: roomKey,
          timeoutMilliseconds: null,
          censoredNickname: msg.nickname || null
        }));
        return;
      }

      // All other messages need a room
      const room = roomKey ? rooms.get(roomKey) : null;
      if (!room) return;

      if (msg.type === 'acceptJoin') {
        const guest = room.guests.get(msg.session);
        if (guest) {
          guest.send(JSON.stringify({
            type: 'acceptJoin',
            answer: msg.answer,
            mods: msg.mods || [],
            isModsVanillaCompatible: msg.isModsVanillaCompatible !== false,
            clientId: msg.clientId
          }));
        }
      } else if (msg.type === 'declineJoin') {
        const guest = room.guests.get(msg.session);
        if (guest) {
          guest.send(JSON.stringify({ type: 'declineJoin', reason: msg.reason }));
          guest.close();
          room.guests.delete(msg.session);
        }
      } else if (msg.type === 'iceCandidate') {
        const guest = room.guests.get(msg.session);
        if (guest) {
          guest.send(JSON.stringify({
            type: 'iceCandidate',
            candidate: msg.candidate
          }));
        }
      }
    } catch (e) {
      console.error('Host WS error:', e);
    }
  });

  ws.on('close', () => {
    if (roomKey && rooms.has(roomKey)) {
      const room = rooms.get(roomKey);
      for (const [, guest] of room.guests) {
        try {
          guest.send(JSON.stringify({ type: 'error', error: 'ExpiredInvite' }));
          guest.close();
        } catch {}
      }
      rooms.delete(roomKey);
    }
  });
}

function handleJoinConnection(ws) {
  let sessionId = null;
  let roomKey = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      // First message from guest: has inviteCode and offer, NO type field
      if (!msg.type && msg.inviteCode && msg.offer) {
        roomKey = msg.inviteCode;
        const room = rooms.get(roomKey);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', error: 'ExpiredInvite' }));
          ws.close();
          return;
        }

        sessionId = crypto.randomUUID();
        room.guests.set(sessionId, ws);

        if (room.host.readyState === 1) {
          room.host.send(JSON.stringify({
            type: 'joinInvite',
            session: sessionId,
            offer: msg.offer,
            mods: msg.mods || [],
            isModsVanillaCompatible: msg.isModsVanillaCompatible !== false,
            nickname: msg.nickname || 'Anonymous',
            countryCode: msg.countryCode || null,
            carStyle: msg.carStyle || '',
            iceServers: [
              { urls: ['stun:stun.l.google.com:19302'] },
              { urls: ['stun:stun1.l.google.com:19302'] }
            ]
          }));
        } else {
          ws.send(JSON.stringify({ type: 'error', error: 'ExpiredInvite' }));
          ws.close();
        }
        return;
      }

      // ICE candidate from guest (may be null to signal end-of-candidates)
      if (!msg.type && 'candidate' in msg) {
        const room = roomKey ? rooms.get(roomKey) : null;
        if (room && room.host.readyState === 1 && sessionId) {
          room.host.send(JSON.stringify({
            version: '0.6.0',
            type: 'iceCandidate',
            session: sessionId,
            candidate: msg.candidate
          }));
        }
        return;
      }
    } catch (e) {
      console.error('Join WS error:', e);
    }
  });

  ws.on('close', () => {
    console.log('Join WS close: roomKey=' + roomKey + ' sessionId=' + sessionId);
    if (roomKey && sessionId) {
      const room = rooms.get(roomKey);
      console.log('Join WS close: room found=' + !!room);
      if (room) {
        room.guests.delete(sessionId);
        if (room.host.readyState === 1) {
          room.host.send(JSON.stringify({
            type: 'joinDisconnect',
            session: sessionId
          }));
          console.log('Sent joinDisconnect to host');
        } else {
          console.log('Host not ready, readyState=' + room.host.readyState);
        }
        if (room.guests.size === 0) {
          setTimeout(() => {
            if (room.guests.size === 0) rooms.delete(roomKey);
          }, 60000);
        }
      }
    } else {
      console.log('Join WS close: roomKey or sessionId null');
    }
  });
}

// --- Find and serve track files ---
app.get('/api/tracks', (req, res) => {
  const tracksDir = path.join(__dirname, 'public', 'tracks');
  const result = { official: [], community: [] };

  for (const category of ['official', 'community']) {
    const dir = path.join(tracksDir, category);
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.track') && f !== 'thumbnails');
      result[category] = files.map(f => ({
        filename: f,
        name: path.basename(f, '.track')
          .replace(/_/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase()),
        id: getTrackId(f)
      }));
    }
  }
  res.json(result);
});

// --- Health check ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '0.6.0' });
});

// Fallback to index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Start ---
server.listen(PORT, '0.0.0.0', () => {
  console.log(`PolyTrack Web Server running on http://localhost:${PORT}`);
  console.log(`Serving game from: ${path.join(__dirname, 'public')}`);
});

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('./ws-lite');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'index.html');
const MAX_PLAYERS = 6;
const MAX_WORD_LEN = 20;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  fs.readFile(INDEX, (err, data) => {
    if (err) {
      res.writeHead(500);
      return res.end('index.html missing');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

/** rooms: code -> room */
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function normalize(w) {
  return String(w)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function publicState(room, me) {
  return {
    t: 'state',
    code: room.code,
    phase: room.phase,
    round: room.history.length + 1,
    history: room.history,
    winWord: room.winWord,
    finishedAt: room.finishedAt,
    meIndex: room.players.indexOf(me),
    myWord: me.word,
    players: room.players.map((p, i) => ({
      name: p.name,
      color: i,
      submitted: p.word !== null,
      online: !!p.ws,
      host: p === room.players[0],
    })),
  };
}

function broadcast(room) {
  for (const p of room.players) send(p.ws, publicState(room, p));
}

function checkReveal(room) {
  if (room.phase !== 'playing') return;
  const active = room.players.filter((p) => p.ws);
  if (active.length === 0) return;
  if (!active.every((p) => p.word !== null)) return;

  const round = room.players.map((p, i) => ({
    name: p.name,
    color: i,
    word: p.word === null ? '—' : p.word,
  }));
  room.history.push(round);

  const norms = active.map((p) => normalize(p.word));
  const same = active.length >= 2 && norms[0] !== '' && norms.every((n) => n === norms[0]);
  if (same) {
    room.phase = 'done';
    room.winWord = active[0].word;
    room.finishedAt = Date.now();
  }
  room.players.forEach((p) => (p.word = null));
}

function removeIfEmpty(room) {
  if (room.players.some((p) => p.ws)) return;
  room.cleanup = setTimeout(() => {
    if (!room.players.some((p) => p.ws)) rooms.delete(room.code);
  }, 10 * 60 * 1000);
}

wss.on('connection', (ws) => {
  let room = null;
  let me = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  function attach(r, p) {
    room = r;
    me = p;
    if (r.cleanup) {
      clearTimeout(r.cleanup);
      r.cleanup = null;
    }
    if (p.ws && p.ws !== ws) {
      try { p.ws.close(); } catch (e) {}
    }
    p.ws = ws;
    send(ws, { t: 'joined', token: p.token, code: r.code });
    broadcast(r);
  }

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'ping') return send(ws, { t: 'pong' });

    const name = String(m.name || '').trim().slice(0, 10);

    if (m.t === 'create') {
      if (!name) return send(ws, { t: 'error', msg: '请先填写昵称' });
      const code = newCode();
      const r = { code, players: [], phase: 'lobby', history: [], winWord: null, finishedAt: null, cleanup: null };
      const p = { token: crypto.randomUUID(), name, word: null, ws: null };
      r.players.push(p);
      rooms.set(code, r);
      return attach(r, p);
    }

    if (m.t === 'join') {
      const r = rooms.get(String(m.code || '').trim().toUpperCase());
      if (!r) return send(ws, { t: 'error', msg: '房间不存在，请检查房间号', fatal: !!m.token });
      // 重连
      const existing = m.token && r.players.find((p) => p.token === m.token);
      if (existing) return attach(r, existing);
      if (!name) return send(ws, { t: 'error', msg: '请先填写昵称' });
      if (r.phase !== 'lobby') return send(ws, { t: 'error', msg: '游戏已经开始了' });
      if (r.players.length >= MAX_PLAYERS) return send(ws, { t: 'error', msg: '房间已满' });
      let finalName = name;
      let n = 2;
      while (r.players.some((p) => p.name === finalName)) finalName = name + n++;
      const p = { token: crypto.randomUUID(), name: finalName, word: null, ws: null };
      r.players.push(p);
      return attach(r, p);
    }

    if (!room || !me) return;

    if (m.t === 'start') {
      if (room.players[0] !== me) return;
      if (room.phase !== 'lobby') return;
      if (room.players.filter((p) => p.ws).length < 2) return send(ws, { t: 'error', msg: '至少需要 2 个人才能开始' });
      room.players = room.players.filter((p) => p.ws);
      room.phase = 'playing';
      room.history = [];
      room.players.forEach((p) => (p.word = null));
      return broadcast(room);
    }

    if (m.t === 'submit') {
      if (room.phase !== 'playing' || me.word !== null) return;
      const word = String(m.word || '').trim().slice(0, MAX_WORD_LEN);
      if (!word) return;
      me.word = word;
      checkReveal(room);
      return broadcast(room);
    }

    if (m.t === 'again') {
      if (room.phase !== 'done') return;
      room.phase = 'lobby';
      room.history = [];
      room.winWord = null;
      room.finishedAt = null;
      room.players = room.players.filter((p) => p.ws);
      room.players.forEach((p) => (p.word = null));
      return broadcast(room);
    }

    if (m.t === 'leave') {
      leave();
    }
  });

  function leave() {
    if (!room || !me) return;
    const r = room;
    const p = me;
    room = null;
    me = null;
    p.ws = null;
    if (r.phase === 'lobby') {
      r.players = r.players.filter((x) => x !== p);
    }
    checkReveal(r);
    broadcast(r);
    removeIfEmpty(r);
  }

  ws.on('close', () => {
    if (me && me.ws === ws) leave();
  });
});

// 心跳，清理断线连接
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => console.log('同词相遇 running on http://localhost:' + PORT));

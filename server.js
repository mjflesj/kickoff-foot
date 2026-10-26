const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;
const W = 1000, H = 600;
const FIELD = { left: 44, right: 956, top: 44, bottom: 556 };
const GOAL_HALF = 76;
const PLAYER_R = 15, BALL_R = 10;
const rooms = new Map();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

function makeCode() {
  let code;
  do { code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function freshBall() { return { x: W / 2, y: H / 2, vx: 0, vy: 0 }; }
function cleanRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    score: room.score,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, team: p.team, x: p.x, y: p.y, ready: true }))
  };
}
function publicRoom(room) { io.to(room.code).emit('room:update', cleanRoom(room)); }
function resetPositions(room) {
  let blues = 0, reds = 0;
  for (const p of room.players.values()) {
    if (p.team === 0) { p.x = 235; p.y = 250 + (blues++ % 3) * 48; }
    else { p.x = 765; p.y = 250 + (reds++ % 3) * 48; }
    p.vx = 0; p.vy = 0; p.keys = {};
  }
  room.ball = freshBall();
  room.lastTouch = null;
}
function getRoomForSocket(socket) {
  for (const room of rooms.values()) if (room.players.has(socket.id)) return room;
  return null;
}
function leaveRoom(socket) {
  const room = getRoomForSocket(socket);
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(room.code);
  if (!room.players.size) { rooms.delete(room.code); return; }
  if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
  if (room.players.size < 2) room.status = 'lobby';
  resetPositions(room);
  publicRoom(room);
}

io.on('connection', socket => {
  socket.emit('server:hello', { id: socket.id });

  socket.on('room:create', payload => {
    leaveRoom(socket);
    const code = makeCode();
    const room = { code, hostId: socket.id, status: 'lobby', players: new Map(), ball: freshBall(), score: [0, 0], lastTouch: null, endedAt: null };
    room.players.set(socket.id, { id: socket.id, name: safeName(payload?.name), team: 0, x: 235, y: 300, vx: 0, vy: 0, keys: {} });
    rooms.set(code, room);
    socket.join(code);
    socket.emit('room:joined', { code, host: true });
    publicRoom(room);
  });

  socket.on('room:join', payload => {
    leaveRoom(socket);
    const code = String(payload?.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return socket.emit('notice', { kind: 'error', text: 'Cette salle n’existe pas. Vérifie le code.' });
    if (room.players.size >= 4) return socket.emit('notice', { kind: 'error', text: 'Cette salle est complète (4 joueurs maximum).' });
    if (room.status === 'playing') return socket.emit('notice', { kind: 'error', text: 'Le match a déjà commencé. Rejoins une autre salle.' });
    const teamCount = [...room.players.values()].filter(p => p.team === 0).length;
    const redCount = [...room.players.values()].filter(p => p.team === 1).length;
    const team = teamCount <= redCount ? 0 : 1;
    room.players.set(socket.id, { id: socket.id, name: safeName(payload?.name), team, x: team === 0 ? 235 : 765, y: 300, vx: 0, vy: 0, keys: {} });
    socket.join(code);
    socket.emit('room:joined', { code, host: false });
    publicRoom(room);
  });

  socket.on('room:leave', () => {
    leaveRoom(socket);
    socket.emit('room:left');
  });

  socket.on('match:start', () => {
    const room = getRoomForSocket(socket);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.size < 2) return socket.emit('notice', { kind: 'error', text: 'Il faut au moins 2 joueurs pour commencer.' });
    room.status = 'playing'; room.score = [0, 0]; resetPositions(room); publicRoom(room);
    io.to(room.code).emit('match:started');
  });

  socket.on('match:back-to-lobby', () => {
    const room = getRoomForSocket(socket);
    if (!room || room.hostId !== socket.id) return;
    room.status = 'lobby'; room.score = [0, 0]; resetPositions(room); publicRoom(room);
  });

  socket.on('player:input', input => {
    const room = getRoomForSocket(socket);
    if (!room || room.status !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || !input || typeof input !== 'object') return;
    player.keys = {
      up: !!input.up, down: !!input.down, left: !!input.left, right: !!input.right,
      kick: !!input.kick
    };
  });

  socket.on('disconnect', () => leaveRoom(socket));
});
function safeName(name) {
  const n = String(name || 'Joueur').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16);
  return n || 'Joueur';
}

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - last) / 1000, 0.035);
  last = now;
  for (const room of rooms.values()) {
    if (room.status !== 'playing') continue;
    for (const p of room.players.values()) {
      const k = p.keys;
      let dx = (k.right ? 1 : 0) - (k.left ? 1 : 0);
      let dy = (k.down ? 1 : 0) - (k.up ? 1 : 0);
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const speed = 220;
      p.x = clamp(p.x + dx * speed * dt, FIELD.left + PLAYER_R, FIELD.right - PLAYER_R);
      p.y = clamp(p.y + dy * speed * dt, FIELD.top + PLAYER_R, FIELD.bottom - PLAYER_R);

      let bx = p.x - room.ball.x, by = p.y - room.ball.y;
      let dist = Math.hypot(bx, by);
      if (dist < PLAYER_R + BALL_R && dist > 0) {
        const nx = bx / dist, ny = by / dist;
        const overlap = PLAYER_R + BALL_R - dist;
        room.ball.x -= nx * overlap * 0.55;
        room.ball.y -= ny * overlap * 0.55;
        room.ball.vx += dx * 38 + nx * 30;
        room.ball.vy += dy * 38 + ny * 30;
        room.lastTouch = p.id;
        if (k.kick) {
          const aimX = p.team === 0 ? 1 : -1;
          let aimY = dy * 0.7 + ny * 0.4;
          const aimLen = Math.hypot(aimX, aimY) || 1;
          room.ball.vx = (aimX / aimLen) * 520;
          room.ball.vy = (aimY / aimLen) * 330;
          room.lastTouch = p.id;
        }
      }
    }
    const b = room.ball;
    b.x += b.vx * dt; b.y += b.vy * dt;
    const friction = Math.pow(0.986, dt * 60);
    b.vx *= friction; b.vy *= friction;
    if (b.y < FIELD.top + BALL_R) { b.y = FIELD.top + BALL_R; b.vy = Math.abs(b.vy) * 0.78; }
    if (b.y > FIELD.bottom - BALL_R) { b.y = FIELD.bottom - BALL_R; b.vy = -Math.abs(b.vy) * 0.78; }
    const inGoalMouth = b.y >= H / 2 - GOAL_HALF && b.y <= H / 2 + GOAL_HALF;
    if (b.x < FIELD.left && inGoalMouth) {
      room.score[1]++; resetPositions(room); io.to(room.code).emit('goal', { team: 1 });
    } else if (b.x > FIELD.right && inGoalMouth) {
      room.score[0]++; resetPositions(room); io.to(room.code).emit('goal', { team: 0 });
    } else {
      if (b.x < FIELD.left + BALL_R) { b.x = FIELD.left + BALL_R; b.vx = Math.abs(b.vx) * 0.75; }
      if (b.x > FIELD.right - BALL_R) { b.x = FIELD.right - BALL_R; b.vx = -Math.abs(b.vx) * 0.75; }
    }
    // Light player separation prevents characters from stacking completely.
    const players = [...room.players.values()];
    for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
      const a = players[i], c = players[j], x = c.x - a.x, y = c.y - a.y, d = Math.hypot(x, y);
      if (d > 0 && d < PLAYER_R * 2) {
        const push = (PLAYER_R * 2 - d) * 0.5;
        a.x -= x / d * push; a.y -= y / d * push;
        c.x += x / d * push; c.y += y / d * push;
      }
    }
    io.to(room.code).volatile.emit('game:state', {
      ball: room.ball, score: room.score,
      players: players.map(p => ({ id: p.id, name: p.name, team: p.team, x: p.x, y: p.y })),
      serverTime: now
    });
  }
}, 1000 / 30);

server.listen(PORT, '0.0.0.0', () => console.log(`Foot multijoueur lancé sur le port ${PORT}`));

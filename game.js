(() => {
  const socket = io();
  const $ = id => document.getElementById(id);
  const homeView = $('homeView'), lobbyView = $('lobbyView'), gameView = $('gameView');
  const nameInput = $('playerName'), codeInput = $('roomCode');
  const canvas = $('pitch'), ctx = canvas.getContext('2d');
  let myId = null, currentCode = null, isHost = false, roomState = null, latestGame = null;
  let lastKick = false, kickQueued = false, aimingWithMouse = false, kickToastTimer = null, lastNoticeTimer = null;
  const keys = { up:false, down:false, left:false, right:false, kick:false };
  // Network smoothing: predict the local player immediately, interpolate remote
  // snapshots slightly in the past, and softly reconcile the local prediction.
  const PLAYER_SPEED = 220;
  const PLAYER_RADIUS = 15;
  const FIELD = { left: 44, right: 956, top: 44, bottom: 556 };
  const SNAPSHOT_INTERPOLATION_MS = 60;
  const SNAPSHOT_BUFFER_LIMIT = 12;
  const snapshotBuffer = [];
  let predictedSelf = null;
  let predictionOffset = { x: 0, y: 0 };
  let lastFrameTime = performance.now();
  let estimatedRttMs = 100;
  let receivedRttSample = false;
  // Aim coordinates use the canvas' 1000 x 600 game-world coordinate system.
  const mouseAim = { x: 900, y: 300 };

  function setView(view) {
    homeView.classList.toggle('hidden', view !== 'home');
    lobbyView.classList.toggle('hidden', view !== 'lobby');
    gameView.classList.toggle('hidden', view !== 'game');
  }
  function getName() { return (nameInput.value || '').trim().slice(0, 16) || 'Joueur'; }
  function showNotice(id, message, good = false) {
    const el = $(id); el.textContent = message; el.classList.toggle('good', good);
    clearTimeout(lastNoticeTimer); lastNoticeTimer = setTimeout(() => { if (el.textContent === message) el.textContent = ''; }, 5500);
  }
  function notify(message, good = false) {
    const target = !homeView.classList.contains('hidden') ? 'homeNotice' : 'lobbyNotice';
    showNotice(target, message, good);
  }
  function roomUrl() { const u = new URL(window.location.href); u.searchParams.set('room', currentCode || ''); return u.toString(); }
  async function copyText(text, success) {
    try { await navigator.clipboard.writeText(text); showNotice('lobbyNotice', success, true); }
    catch { showNotice('lobbyNotice', 'Copie impossible ici : sélectionne le code et copie-le manuellement.', false); }
  }

  $('createBtn').addEventListener('click', () => {
    if (!socket.connected) return showNotice('homeNotice', 'Le serveur n’est pas encore connecté. Réessaie dans un instant.');
    socket.emit('room:create', { name: getName(), targetGoals: Number($('targetGoals').value) });
  });
  $('joinBtn').addEventListener('click', () => {
    const code = codeInput.value.trim().toUpperCase();
    if (code.length < 5) return showNotice('homeNotice', 'Entre le code à 5 caractères de ton salon.');
    if (!socket.connected) return showNotice('homeNotice', 'Le serveur n’est pas encore connecté. Réessaie dans un instant.');
    socket.emit('room:join', { code, name: getName() });
  });
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('createBtn').click(); });
  codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });
  $('copyCodeBtn').addEventListener('click', () => copyText(currentCode, 'Code copié !'));
  $('copyLinkBtn').addEventListener('click', () => copyText(roomUrl(), 'Lien d’invitation copié !'));
  $('startBtn').addEventListener('click', () => socket.emit('match:start'));
  $('leaveLobbyBtn').addEventListener('click', () => { socket.emit('room:leave'); });
  $('exitGameBtn').addEventListener('click', () => { socket.emit('room:leave'); });
  $('backLobbyBtn').addEventListener('click', () => { socket.emit('match:back-to-lobby'); });
  $('finishLobbyBtn').addEventListener('click', () => { if (isHost) socket.emit('match:back-to-lobby'); });

  socket.on('connect', () => { $('connectionText').textContent = 'Serveur connecté'; document.querySelector('.top-right .live-dot').style.background = 'var(--lime)'; });
  socket.on('disconnect', () => { $('connectionText').textContent = 'Reconnexion…'; document.querySelector('.top-right .live-dot').style.background = 'var(--red)'; });
  socket.on('net:pong', data => {
    if (!Number.isFinite(data?.clientTime)) return;
    const sample = performance.now() - data.clientTime;
    if (!Number.isFinite(sample) || sample < 0 || sample > 2000) return;
    // EWMA filters jitter, while the first valid sample initializes the estimate.
    estimatedRttMs = receivedRttSample ? estimatedRttMs * 0.75 + sample * 0.25 : sample;
    receivedRttSample = true;
  });
  setInterval(() => {
    if (socket.connected) socket.emit('net:ping', { clientTime: performance.now() });
  }, 2000);
  socket.on('server:hello', data => { myId = data.id; });
  socket.on('room:joined', data => {
    currentCode = data.code; isHost = !!data.host;
    $('lobbyCode').textContent = currentCode;
    $('gameRoomCode').textContent = '· ' + currentCode;
    const u = new URL(window.location.href); u.searchParams.set('room', currentCode); history.replaceState({}, '', u.toString());
    setView('lobby');
    showNotice('lobbyNotice', isHost ? 'Salon créé. Envoie le code à ton adversaire !' : 'Tu as rejoint le salon. Bonne chance !', true);
  });
  socket.on('notice', data => {
    const target = homeView.classList.contains('hidden') ? 'lobbyNotice' : 'homeNotice';
    showNotice(target, data.text || 'Une erreur est survenue.', false);
  });
  socket.on('room:update', room => {
    const previousStatus = roomState?.status;
    roomState = room;
    isHost = room.hostId === myId;
    renderRoom(room);
    if (room.status === 'playing') {
      $('matchEndOverlay').classList.add('hidden');
      $('pauseOverlay').classList.add('hidden');
      setView('game');
    } else if (room.status === 'finished') {
      setView('game');
      showMatchEnd(room);
    } else if (room.status === 'lobby' && previousStatus === 'finished') {
      $('matchEndOverlay').classList.add('hidden');
      setView('lobby');
    }
    if (room.status === 'lobby' && !gameView.classList.contains('hidden') && room.players.length < 2) $('pauseOverlay').classList.remove('hidden');
  });
  socket.on('room:left', () => {
    currentCode = null; roomState = null; latestGame = null;
    snapshotBuffer.length = 0; predictedSelf = null; predictionOffset = { x: 0, y: 0 };
    $('matchEndOverlay').classList.add('hidden');
    $('pauseOverlay').classList.add('hidden');
    history.replaceState({}, '', window.location.pathname);
    setView('home');
  });
  socket.on('match:started', () => {
    snapshotBuffer.length = 0; predictedSelf = null; predictionOffset = { x: 0, y: 0 };
    lastFrameTime = performance.now();
    $('pauseOverlay').classList.add('hidden');
    $('matchEndOverlay').classList.add('hidden');
    $('goalToast').classList.add('hidden');
    setView('game');
  });
  socket.on('game:state', state => {
    latestGame = state;
    const receivedAt = performance.now();
    snapshotBuffer.push({ state, receivedAt });
    while (snapshotBuffer.length > SNAPSHOT_BUFFER_LIMIT) snapshotBuffer.shift();
    reconcileLocalPrediction(state, receivedAt);
    renderScore(state.score);
  });
  socket.on('match:ended', result => showMatchEnd(result));
  socket.on('goal', data => {
    $('goalToast').classList.remove('hidden'); $('goalToast').textContent = data.team === 0 ? 'BUUUUT BLEU !' : 'BUUUUT ROUGE !';
    clearTimeout(kickToastTimer); kickToastTimer = setTimeout(() => $('goalToast').classList.add('hidden'), 1600);
  });

  function renderRoom(room) {
    $('playerCount').textContent = `${room.players.length}/4`;
    const target = room.targetGoals || 5;
    $('matchRules').textContent = `Match en ${target} buts · le premier à ${target} gagne`;
    $('matchTarget').textContent = `PREMIER À ${target} BUTS`;
    $('bluePlayers').innerHTML = ''; $('redPlayers').innerHTML = '';
    const blue = room.players.filter(p => p.team === 0), red = room.players.filter(p => p.team === 1);
    appendPlayers('bluePlayers', blue, room.hostId);
    appendPlayers('redPlayers', red, room.hostId);
    const start = $('startBtn'); start.disabled = !(isHost && room.players.length >= 2);
    start.querySelector('span').textContent = isHost ? (room.players.length >= 2 ? 'Lancer le match' : 'En attente d’un adversaire…') : 'En attente du créateur…';
    if (room.status === 'playing' || room.status === 'finished') setView('game');
  }
  function appendPlayers(id, players, hostId) {
    const root = $(id);
    if (!players.length) { root.innerHTML = '<div class="empty-player">En attente d’un joueur…</div>'; return; }
    for (const p of players) {
      const row = document.createElement('div'); row.className = 'player-row';
      const avatar = document.createElement('div'); avatar.className = 'avatar' + (p.team === 1 ? ' red' : ''); avatar.textContent = (p.name || 'J').slice(0,1).toUpperCase();
      const meta = document.createElement('div'); meta.className = 'player-meta';
      const name = document.createElement('div'); name.className = 'player-name'; name.textContent = p.name;
      const role = document.createElement('div'); role.className = 'player-role'; role.textContent = p.id === myId ? 'C’est toi' : 'Prêt à jouer';
      meta.append(name, role); row.append(avatar, meta);
      if (p.id === hostId) { const tag = document.createElement('span'); tag.className='host-tag'; tag.textContent='HÔTE'; row.append(tag); }
      root.append(row);
    }
  }
  function renderScore(score) { if (!score) return; $('blueScore').textContent = score[0] ?? 0; $('redScore').textContent = score[1] ?? 0; }

  function showMatchEnd(result) {
    const score = result.score || roomState?.score || [0, 0];
    const targetGoals = result.targetGoals || roomState?.targetGoals || 5;
    const winnerTeam = result.winnerTeam ?? roomState?.winnerTeam;
    const me = roomState?.players?.find(p => p.id === myId) || latestGame?.players?.find(p => p.id === myId);
    const won = !!me && me.team === winnerTeam;
    renderScore(score);
    $('matchTarget').textContent = `PREMIER À ${targetGoals} BUTS`;
    $('matchEndTitle').textContent = won ? 'VICTOIRE !' : 'DÉFAITE';
    $('matchEndSubtitle').textContent = `Score final : ${score[0] ?? 0} – ${score[1] ?? 0} · Premier à ${targetGoals} buts`;
    $('matchEndHint').textContent = isHost ? 'Tu peux retourner au vestiaire pour lancer une revanche.' : 'L’hôte peut retourner au vestiaire pour lancer une revanche.';
    $('finishLobbyBtn').classList.toggle('hidden', !isHost);
    $('matchEndOverlay').classList.toggle('loss', !won);
    $('pauseOverlay').classList.add('hidden');
    $('matchEndOverlay').classList.remove('hidden');
  }

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function movementVector() {
    let dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    let dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    const length = Math.hypot(dx, dy) || 1;
    return { x: dx / length, y: dy / length };
  }

  function clampPlayerPosition(x, y) {
    return {
      x: clamp(x, FIELD.left + PLAYER_RADIUS, FIELD.right - PLAYER_RADIUS),
      y: clamp(y, FIELD.top + PLAYER_RADIUS, FIELD.bottom - PLAYER_RADIUS)
    };
  }

  // The server remains authoritative. We estimate how far the latest packet
  // has travelled, extrapolate the authoritative position for that one-way
  // delay, and preserve the current on-screen position while correction fades.
  function reconcileLocalPrediction(state) {
    if (!myId || !state?.players) return;
    const authoritative = state.players.find(player => player.id === myId);
    if (!authoritative) return;
    const movement = movementVector();
    const oneWaySeconds = clamp(estimatedRttMs / 2000, 0, 0.12);
    const target = clampPlayerPosition(
      authoritative.x + movement.x * PLAYER_SPEED * oneWaySeconds,
      authoritative.y + movement.y * PLAYER_SPEED * oneWaySeconds
    );

    if (!predictedSelf || state.status !== 'playing') {
      predictedSelf = target;
      predictionOffset = { x: 0, y: 0 };
      return;
    }

    const visibleX = predictedSelf.x + predictionOffset.x;
    const visibleY = predictedSelf.y + predictionOffset.y;
    const error = Math.hypot(target.x - visibleX, target.y - visibleY);
    // A large correction usually means a goal reset, a reconnect, or a real
    // collision. Snap those exceptional cases instead of gliding across pitch.
    if (error > 85) {
      predictedSelf = target;
      predictionOffset = { x: 0, y: 0 };
      return;
    }
    predictedSelf = target;
    predictionOffset = { x: visibleX - target.x, y: visibleY - target.y };
  }

  function advanceLocalPrediction(now) {
    const dt = clamp((now - lastFrameTime) / 1000, 0, 0.05);
    lastFrameTime = now;
    if (predictedSelf && latestGame?.status === 'playing' && socket.connected && !gameView.classList.contains('hidden')) {
      const movement = movementVector();
      const next = clampPlayerPosition(
        predictedSelf.x + movement.x * PLAYER_SPEED * dt,
        predictedSelf.y + movement.y * PLAYER_SPEED * dt
      );
      predictedSelf.x = next.x;
      predictedSelf.y = next.y;
      // Ease small network corrections out over ~100 ms; never delay the input itself.
      const fade = Math.exp(-dt / 0.10);
      predictionOffset.x *= fade;
      predictionOffset.y *= fade;
    }
  }

  function interpolatePair(a, b, t) { return a + (b - a) * t; }

  function interpolateSnapshots(before, after, t) {
    const a = before.state, b = after.state;
    const previousPlayers = new Map((a.players || []).map(player => [player.id, player]));
    const players = (b.players || []).map(player => {
      const old = previousPlayers.get(player.id);
      if (!old) return { ...player };
      // Position resets after a goal should happen immediately, not interpolate
      // a player from one end of the pitch to the other.
      if (Math.hypot(player.x - old.x, player.y - old.y) > 180) return { ...player };
      return {
        ...player,
        x: interpolatePair(old.x, player.x, t),
        y: interpolatePair(old.y, player.y, t)
      };
    });
    let ball = { ...b.ball };
    if (a.ball && b.ball && Math.hypot(b.ball.x - a.ball.x, b.ball.y - a.ball.y) < 260) {
      ball = {
        ...b.ball,
        x: interpolatePair(a.ball.x, b.ball.x, t),
        y: interpolatePair(a.ball.y, b.ball.y, t)
      };
    }
    return { ...b, players, ball };
  }

  function extrapolateSnapshot(now) {
    const last = snapshotBuffer[snapshotBuffer.length - 1];
    if (!last) return latestGame;
    const previous = snapshotBuffer[snapshotBuffer.length - 2];
    const extraSeconds = clamp((now - SNAPSHOT_INTERPOLATION_MS - last.receivedAt) / 1000, 0, 0.09);
    if (!previous || extraSeconds <= 0) return last.state;
    const span = Math.max(0.001, (last.receivedAt - previous.receivedAt) / 1000);
    const oldPlayers = new Map((previous.state.players || []).map(player => [player.id, player]));
    const players = (last.state.players || []).map(player => {
      if (player.id === myId) return { ...player };
      const old = oldPlayers.get(player.id);
      if (!old) return { ...player };
      const vx = clamp((player.x - old.x) / span, -PLAYER_SPEED, PLAYER_SPEED);
      const vy = clamp((player.y - old.y) / span, -PLAYER_SPEED, PLAYER_SPEED);
      const next = clampPlayerPosition(player.x + vx * extraSeconds, player.y + vy * extraSeconds);
      return { ...player, x: next.x, y: next.y };
    });
    const oldBall = previous.state.ball, ball = last.state.ball;
    let predictedBall = { ...ball };
    if (oldBall && ball) {
      const vx = clamp((ball.x - oldBall.x) / span, -900, 900);
      const vy = clamp((ball.y - oldBall.y) / span, -900, 900);
      predictedBall = { ...ball, x: clamp(ball.x + vx * extraSeconds, 10, 990), y: clamp(ball.y + vy * extraSeconds, 54, 546) };
    }
    return { ...last.state, players, ball: predictedBall };
  }

  function getRenderedSnapshot(now) {
    if (!snapshotBuffer.length) return latestGame;
    const targetTime = now - SNAPSHOT_INTERPOLATION_MS;
    if (targetTime <= snapshotBuffer[0].receivedAt) return snapshotBuffer[0].state;
    for (let i = 1; i < snapshotBuffer.length; i++) {
      const after = snapshotBuffer[i];
      if (after.receivedAt >= targetTime) {
        const before = snapshotBuffer[i - 1];
        const span = Math.max(1, after.receivedAt - before.receivedAt);
        const t = clamp((targetTime - before.receivedAt) / span, 0, 1);
        return interpolateSnapshots(before, after, t);
      }
    }
    return extrapolateSnapshot(now);
  }

  // ZQSD for French AZERTY keyboards, WASD for QWERTY, or arrow keys.
  const downMap = {
    z:'up', w:'up', ArrowUp:'up',
    s:'down', ArrowDown:'down',
    q:'left', a:'left', ArrowLeft:'left',
    d:'right', ArrowRight:'right',
    ' ':'kick', Spacebar:'kick'
  };
  window.addEventListener('keydown', e => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const k = downMap[key];
    if (!k || gameView.classList.contains('hidden')) return;
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault();
    keys[k] = true;
  });
  window.addEventListener('keyup', e => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const k = downMap[key];
    if (k) keys[k] = false;
  });
  window.addEventListener('blur', () => Object.keys(keys).forEach(k => keys[k] = false));

  function updateAim(event) {
    const rect = canvas.getBoundingClientRect();
    mouseAim.x = Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) / rect.width * canvas.width));
    mouseAim.y = Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) / rect.height * canvas.height));
    aimingWithMouse = true;
  }
  canvas.style.cursor = 'crosshair';
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointermove', updateAim);
  canvas.addEventListener('pointerdown', event => {
    if (gameView.classList.contains('hidden')) return;
    if (event.button !== 0) return;
    updateAim(event);
    // Queue the click so a quick click cannot be missed between network ticks.
    kickQueued = true;
    event.preventDefault();
  });

  setInterval(() => {
    if (!gameView.classList.contains('hidden') && socket.connected) {
      const kickNow = keys.kick;
      const kickPulse = (kickNow && !lastKick) || kickQueued;
      const payload = { ...keys, kick: kickPulse };
      if (aimingWithMouse) {
        payload.aimX = mouseAim.x;
        payload.aimY = mouseAim.y;
      }
      socket.emit('player:input', payload);
      kickQueued = false;
      lastKick = kickNow;
    } else {
      lastKick = false;
      kickQueued = false;
    }
  }, 1000 / 30);

  function drawPitch() {
    const now = performance.now();
    advanceLocalPrediction(now);
    const renderGame = getRenderedSnapshot(now);
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0,0,w,h);
    // Turf and alternating mowing stripes.
    ctx.fillStyle = '#176440'; ctx.fillRect(0,0,w,h);
    for(let i=0;i<10;i++){ctx.fillStyle=i%2?'rgba(0,0,0,.055)':'rgba(255,255,255,.025)';ctx.fillRect(i*w/10,0,w/10,h);}
    // Field lines.
    ctx.strokeStyle='rgba(240,255,246,.78)'; ctx.lineWidth=3;
    ctx.strokeRect(44,44,912,512);
    ctx.beginPath();ctx.moveTo(500,44);ctx.lineTo(500,556);ctx.stroke();
    ctx.beginPath();ctx.arc(500,300,76,0,Math.PI*2);ctx.stroke();ctx.fillStyle='rgba(245,255,247,.85)';ctx.beginPath();ctx.arc(500,300,4,0,Math.PI*2);ctx.fill();
    // Penalty areas.
    ctx.strokeRect(44,196,130,208);ctx.strokeRect(826,196,130,208);
    ctx.strokeRect(44,244,52,112);ctx.strokeRect(904,244,52,112);
    ctx.beginPath();ctx.arc(137,300,3,0,Math.PI*2);ctx.arc(863,300,3,0,Math.PI*2);ctx.fill();
    // Goals, slightly outside the field.
    ctx.fillStyle='rgba(208,244,229,.28)';ctx.fillRect(18,224,28,152);ctx.fillRect(956,224,28,152);
    ctx.strokeStyle='rgba(240,255,246,.65)';ctx.lineWidth=2;ctx.strokeRect(18,224,28,152);ctx.strokeRect(956,224,28,152);
    if(renderGame){
      // Live aiming guide: click to kick the ball along this direction.
      const localPlayer = renderGame.players.find(p => p.id === myId);
      if (localPlayer && aimingWithMouse && !gameView.classList.contains('hidden')) {
        ctx.save();
        ctx.setLineDash([9, 8]);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(244,255,194,.58)';
        ctx.beginPath(); ctx.moveTo(renderGame.ball.x, renderGame.ball.y); ctx.lineTo(mouseAim.x, mouseAim.y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(244,255,194,.95)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(mouseAim.x, mouseAim.y, 9, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(mouseAim.x - 14, mouseAim.y); ctx.lineTo(mouseAim.x + 14, mouseAim.y); ctx.moveTo(mouseAim.x, mouseAim.y - 14); ctx.lineTo(mouseAim.x, mouseAim.y + 14); ctx.stroke();
        ctx.restore();
      }
      for(const serverPlayer of renderGame.players){
        const p = serverPlayer.id === myId && predictedSelf && renderGame.status === 'playing'
          ? { ...serverPlayer, x: clamp(predictedSelf.x + predictionOffset.x, FIELD.left + PLAYER_RADIUS, FIELD.right - PLAYER_RADIUS), y: clamp(predictedSelf.y + predictionOffset.y, FIELD.top + PLAYER_RADIUS, FIELD.bottom - PLAYER_RADIUS) }
          : serverPlayer;
        const c=p.team===0?'#68ceff':'#ff7179';
        // Shadow
        ctx.beginPath();ctx.fillStyle='rgba(0,0,0,.22)';ctx.ellipse(p.x+2,p.y+6,17,9,0,0,Math.PI*2);ctx.fill();
        ctx.beginPath();ctx.fillStyle=c;ctx.arc(p.x,p.y,15,0,Math.PI*2);ctx.fill();
        ctx.lineWidth=3;ctx.strokeStyle=p.id===myId?'#f5ffcf':'rgba(255,255,255,.72)';ctx.stroke();
        ctx.fillStyle='#10232c';ctx.font='800 12px Inter,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText((p.name||'J').slice(0,1).toUpperCase(),p.x,p.y+.5);
        if(p.id===myId){ctx.fillStyle='#f4ffc2';ctx.beginPath();ctx.moveTo(p.x,p.y-27);ctx.lineTo(p.x-6,p.y-37);ctx.lineTo(p.x+6,p.y-37);ctx.closePath();ctx.fill();}
        ctx.textBaseline='alphabetic';ctx.font='600 10px Inter,sans-serif';ctx.fillStyle='rgba(255,255,255,.92)';ctx.fillText(p.name,p.x,p.y+30);
      }
      const b=renderGame.ball;
      // Ball shadow
      ctx.beginPath();ctx.fillStyle='rgba(0,0,0,.25)';ctx.ellipse(b.x+2,b.y+5,11,6,0,0,Math.PI*2);ctx.fill();
      ctx.beginPath();ctx.fillStyle='#fffdf0';ctx.arc(b.x,b.y,10,0,Math.PI*2);ctx.fill();ctx.lineWidth=1.5;ctx.strokeStyle='#233a32';ctx.stroke();
      ctx.fillStyle='#26362f';ctx.beginPath();ctx.arc(b.x,b.y,3.2,0,Math.PI*2);ctx.fill();
      for(let i=0;i<5;i++){const a=i*Math.PI*2/5;ctx.beginPath();ctx.arc(b.x+6*Math.cos(a),b.y+6*Math.sin(a),1.7,0,Math.PI*2);ctx.fill();}
    } else {
      ctx.beginPath();ctx.fillStyle='#f8f9eb';ctx.arc(w/2,h/2,10,0,Math.PI*2);ctx.fill();
    }
    requestAnimationFrame(drawPitch);
  }
  requestAnimationFrame(drawPitch);

  const initialCode = new URL(window.location.href).searchParams.get('room');
  if (initialCode) { codeInput.value = initialCode.toUpperCase(); }
})();

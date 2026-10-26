(() => {
  const socket = io();
  const $ = id => document.getElementById(id);
  const homeView = $('homeView'), lobbyView = $('lobbyView'), gameView = $('gameView');
  const nameInput = $('playerName'), codeInput = $('roomCode');
  const canvas = $('pitch'), ctx = canvas.getContext('2d');
  let myId = null, currentCode = null, isHost = false, roomState = null, latestGame = null;
  let lastKick = false, kickToastTimer = null, lastNoticeTimer = null;
  const keys = { up:false, down:false, left:false, right:false, kick:false };

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
    socket.emit('room:create', { name: getName() });
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
  $('backLobbyBtn').addEventListener('click', () => { setView('lobby'); });

  socket.on('connect', () => { $('connectionText').textContent = 'Serveur connecté'; document.querySelector('.top-right .live-dot').style.background = 'var(--lime)'; });
  socket.on('disconnect', () => { $('connectionText').textContent = 'Reconnexion…'; document.querySelector('.top-right .live-dot').style.background = 'var(--red)'; });
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
  socket.on('room:update', room => { roomState = room; isHost = room.hostId === myId; renderRoom(room); if (room.status === 'lobby' && !gameView.classList.contains('hidden') && room.players.length < 2) $('pauseOverlay').classList.remove('hidden'); });
  socket.on('room:left', () => { currentCode = null; roomState = null; latestGame = null; history.replaceState({}, '', window.location.pathname); setView('home'); });
  socket.on('match:started', () => { $('pauseOverlay').classList.add('hidden'); setView('game'); });
  socket.on('game:state', state => { latestGame = state; renderScore(state.score); });
  socket.on('goal', data => {
    $('goalToast').classList.remove('hidden'); $('goalToast').textContent = data.team === 0 ? 'BUUUUT BLEU !' : 'BUUUUT ROUGE !';
    clearTimeout(kickToastTimer); kickToastTimer = setTimeout(() => $('goalToast').classList.add('hidden'), 1600);
  });

  function renderRoom(room) {
    $('playerCount').textContent = `${room.players.length}/4`;
    $('bluePlayers').innerHTML = ''; $('redPlayers').innerHTML = '';
    const blue = room.players.filter(p => p.team === 0), red = room.players.filter(p => p.team === 1);
    appendPlayers('bluePlayers', blue, room.hostId);
    appendPlayers('redPlayers', red, room.hostId);
    const start = $('startBtn'); start.disabled = !(isHost && room.players.length >= 2);
    start.querySelector('span').textContent = isHost ? (room.players.length >= 2 ? 'Lancer le match' : 'En attente d’un adversaire…') : 'En attente du créateur…';
    if (room.status === 'playing') setView('game');
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

  const downMap = { w:'up', ArrowUp:'up', s:'down', ArrowDown:'down', a:'left', ArrowLeft:'left', d:'right', ArrowRight:'right', ' ':'kick', Spacebar:'kick' };
  window.addEventListener('keydown', e => {
    const k = downMap[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!k || gameView.classList.contains('hidden')) return;
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault();
    keys[k] = true;
  });
  window.addEventListener('keyup', e => { const k = downMap[e.key.length === 1 ? e.key.toLowerCase() : e.key]; if (k) keys[k] = false; });
  window.addEventListener('blur', () => Object.keys(keys).forEach(k => keys[k] = false));
  setInterval(() => {
    if (!gameView.classList.contains('hidden') && socket.connected) {
      const kickNow = keys.kick;
      socket.emit('player:input', { ...keys, kick: kickNow && !lastKick });
      lastKick = kickNow;
    } else lastKick = false;
  }, 1000 / 30);

  function drawPitch() {
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
    if(latestGame){
      for(const p of latestGame.players){
        const c=p.team===0?'#68ceff':'#ff7179';
        // Shadow
        ctx.beginPath();ctx.fillStyle='rgba(0,0,0,.22)';ctx.ellipse(p.x+2,p.y+6,17,9,0,0,Math.PI*2);ctx.fill();
        ctx.beginPath();ctx.fillStyle=c;ctx.arc(p.x,p.y,15,0,Math.PI*2);ctx.fill();
        ctx.lineWidth=3;ctx.strokeStyle=p.id===myId?'#f5ffcf':'rgba(255,255,255,.72)';ctx.stroke();
        ctx.fillStyle='#10232c';ctx.font='800 12px Inter,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText((p.name||'J').slice(0,1).toUpperCase(),p.x,p.y+.5);
        if(p.id===myId){ctx.fillStyle='#f4ffc2';ctx.beginPath();ctx.moveTo(p.x,p.y-27);ctx.lineTo(p.x-6,p.y-37);ctx.lineTo(p.x+6,p.y-37);ctx.closePath();ctx.fill();}
        ctx.textBaseline='alphabetic';ctx.font='600 10px Inter,sans-serif';ctx.fillStyle='rgba(255,255,255,.92)';ctx.fillText(p.name,p.x,p.y+30);
      }
      const b=latestGame.ball;
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

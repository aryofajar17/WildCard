// ============================================================
// UNO Chips - Aplikasi klien (PWA)
// Dua mode: 'local' (vs bot, engine jalan di browser)
//           'online' (kode ruang / WiFi lokal, via WebSocket)
// ============================================================
import * as uno from '/shared/uno.js';
import { botAction } from '/shared/bot.js';

/* ---------- util ---------- */
const $ = (s) => document.querySelector(s);
const fmt = (n) => Number(n || 0).toLocaleString('id-ID');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AVA = ['#e74c3c', '#f1c40f', '#27ae60', '#2980b9', '#8e44ad', '#e67e22'];
const RULE_LABELS = {
  stacking: ['Stacking +2/+4', 'Penalti +2/+4 bisa ditumpuk ke pemain berikutnya'],
  jumpIn: ['Jump-in', 'Mainkan kartu identik dgn kartu atas walau bukan giliranmu'],
  sevenZero: ['Aturan 7-0', 'Kartu 7 = tukar tangan · kartu 0 = putar semua tangan'],
  extreme: ['Kartu Ekstrem', '+99 (penalti maut) & 🛡 COUNTER untuk memantulkan penalti'],
};
const COLOR_ORDER = { R: 0, Y: 1, G: 2, B: 3, W: 4 };
const KIND_ORDER = { num: 0, skip: 1, rev: 2, d2: 3, wild: 5, d4: 6, counter: 7, d99: 8 };

const store = {
  get name() { return localStorage.getItem('uno_name') || ''; },
  set name(v) { localStorage.setItem('uno_name', v); },
  get chips() { return parseInt(localStorage.getItem('uno_chips') || '5000', 10) || 0; },
  set chips(v) { localStorage.setItem('uno_chips', String(v)); },
  // token identitas per-tab (sessionStorage): dua tab di browser yang sama = dua pemain berbeda
  get token() { return sessionStorage.getItem('uno_token') || null; },
  set token(v) { v ? sessionStorage.setItem('uno_token', v) : sessionStorage.removeItem('uno_token'); },
};

const App = {
  mode: null, st: null, mySeat: 0, ws: null, lobby: null, isHost: false,
  timers: [], installEvt: null, createRules: { stacking: true, jumpIn: true, sevenZero: true, extreme: true },
  roundEndShown: false, lastTopId: null, turnTotal: 30,
  roomCode: null, reconnectTry: 0,
};

function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
  $('#' + id).classList.remove('hidden');
}
let toastTimer = null;
function toast(txt) {
  const t = $('#toast');
  t.textContent = txt;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
}
function legal(st) { return uno.legalMoves(st, App.mySeat); }
function secs(deadline) { return Math.max(0, Math.ceil((deadline - Date.now()) / 1000)); }
function updateChipsUI() { $('#home-chips').textContent = fmt(store.chips); }
function setChips(v) { if (Number.isFinite(v)) { store.chips = v; updateChipsUI(); } }

/* ---------- modal ---------- */
function openModal(el, lock) {
  const r = $('#modal-root');
  r.innerHTML = '';
  r.appendChild(el);
  r.dataset.lock = lock ? '1' : '';
  r.classList.remove('hidden');
}
function closeModal(force) {
  const r = $('#modal-root');
  if (!force && r.dataset.lock) return;
  r.classList.add('hidden');
  r.innerHTML = '';
}
function askColor(cb) {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = '<h3>🎨 Pilih warna</h3>';
  const g = document.createElement('div');
  g.className = 'color-grid';
  [['R', 'Merah', '#e74c3c'], ['Y', 'Kuning', '#f1c40f'], ['G', 'Hijau', '#27ae60'], ['B', 'Biru', '#2980b9']].forEach(([k, n, c]) => {
    const b = document.createElement('button');
    b.className = 'color-btn';
    b.style.background = c;
    b.textContent = n;
    b.onclick = () => { closeModal(true); cb(k); };
    g.appendChild(b);
  });
  m.appendChild(g);
  openModal(m, true);
}
function askSwap(cb) {
  const st = App.st;
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = '<h3>🔄 Tukar tangan dengan siapa?</h3>';
  const g = document.createElement('div');
  g.className = 'target-list';
  st.players.forEach((p, i) => {
    if (i === App.mySeat) return;
    const cnt = p.handCount ?? p.hand.length;
    const b = document.createElement('button');
    b.className = 'target-btn';
    b.textContent = `${p.name} (${cnt} kartu)`;
    b.onclick = () => { closeModal(true); cb(i); };
    g.appendChild(b);
  });
  m.appendChild(g);
  openModal(m, true);
}

/* ---------- kartu ---------- */
function cardEl(card) {
  const el = document.createElement('div');
  el.className = 'card c-' + card.color;
  el.dataset.id = card.id;
  const v = document.createElement('span');
  v.className = 'val';
  v.textContent = card.kind === 'num' ? card.val : uno.CARD_ICON[card.kind];
  el.appendChild(v);
  const c = document.createElement('span');
  c.className = 'corner';
  c.textContent = card.kind === 'num' || card.kind === 'counter' || card.kind === 'wild' ? '' : uno.CARD_LABEL[card.kind];
  el.appendChild(c);
  return el;
}
function cmpCard(a, b) {
  const ca = COLOR_ORDER[a.color] - COLOR_ORDER[b.color];
  if (ca) return ca;
  if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  return (a.val || 0) - (b.val || 0);
}

/* ============================================================
   RENDER GAME (dipakai mode lokal & online)
   ============================================================ */
function renderGame() {
  const st = App.st;
  if (!st) return;
  const my = App.mySeat;

  // lawan
  const oppBox = $('#opponents');
  oppBox.innerHTML = '';
  st.players.forEach((p, i) => {
    if (i === my) return;
    const div = document.createElement('div');
    div.className = 'opp' + (st.turn === i && st.phase === 'playing' ? ' turn' : '');
    const cnt = p.handCount ?? p.hand.length;
    div.innerHTML = `
      <div class="ava" style="background:${AVA[i % AVA.length]}">${esc((p.name || '?')[0].toUpperCase())}</div>
      <div class="info">
        <div class="nm">${esc(p.name)}${p.isBot ? ' 🤖' : ''}</div>
        <div class="cnt"><b>${cnt}</b> kartu
          ${st.unoPending === i && Date.now() < st.unoDeadline ? '<span class="uno-flag">UNO!</span>' : ''}
          ${st.pendingPlayer === i && st.pendingDraw > 0 ? `<span class="pen">⚠ ${st.pendingDraw}</span>` : ''}
        </div>
      </div>`;
    oppBox.appendChild(div);
  });
  const q = document.createElement('button');
  q.className = 'btn-back';
  q.textContent = '🚪';
  q.style.width = '34px';
  q.style.height = '34px';
  q.style.fontSize = '15px';
  q.title = App.mode === 'online' && App.isHost ? 'Akhiri game — kembali ke lobby' : 'Keluar';
  // Host online: kembali ke lobby (game diakhiri untuk semua). Selain itu: keluar ruang.
  q.onclick = () => {
    if (App.mode === 'online' && App.isHost) send({ t: 'lobby' });
    else leaveGame();
  };
  oppBox.appendChild(q);

  // tengah
  $('#dir-arrow').textContent = st.dir === 1 ? '↻' : '↺';
  $('#color-dot').className = 'c-dot c-' + (st.activeColor || 'W');
  $('#round-info').textContent = 'Ronde ' + st.round;
  const deckLeft = st.deckCount != null ? st.deckCount : (st.deck ? st.deck.length : 0);
  $('#deck-count').textContent = deckLeft + ' sisa';

  const dis = $('#discard');
  dis.innerHTML = '';
  const top = st.discard[st.discard.length - 1];
  if (top) {
    const el = cardEl(top);
    if (App.lastTopId !== top.id) el.classList.add('card-play-anim');
    App.lastTopId = top.id;
    dis.appendChild(el);
  }
  $('#log-line').textContent = st.log[st.log.length - 1] || '';

  renderBanner(st);
  renderActions(st);
  renderHand(st);
  maybeRoundEnd(st);

  // mode tukar tangan (kartu 7): paksa modal pilih target selama belum dipilih
  if (st.phase === 'playing' && st.awaiting === 'seven' && st.turn === App.mySeat
      && $('#modal-root').classList.contains('hidden')) {
    askSwap((t) => doAct({ t: 'swap', target: t }));
  }
}

function renderBanner(st) {
  const b = $('#banner');
  const my = App.mySeat;
  if (st.phase !== 'playing') { b.textContent = ''; b.className = ''; return; }
  if (st.pendingDraw > 0) {
    if (st.pendingPlayer === my) {
      const L = legal(st);
      b.textContent = L.canCounter.length
        ? `🛡 Kena ${st.pendingDraw} kartu — PANTULKAN dengan COUNTER!`
        : `⚠ Kamu kena ${st.pendingDraw} kartu!`;
      b.className = 'danger';
    } else {
      b.textContent = `${st.players[st.pendingPlayer].name} kena ${st.pendingDraw} kartu…`;
      b.className = 'warn';
    }
  } else if (st.awaiting === 'seven' && st.turn === my) {
    b.textContent = '🔄 Pilih tangan untuk ditukar!';
    b.className = 'warn';
  } else if (st.turn === my) {
    b.textContent = '🎯 Giliranmu!';
    b.className = 'good';
  } else {
    b.textContent = `Giliran ${st.players[st.turn].name}`;
    b.className = '';
  }
}

function renderActions(st) {
  const bar = $('#action-bar');
  bar.innerHTML = '';
  if (st.phase !== 'playing') return;
  const my = App.mySeat;
  const L = legal(st);
  const add = (label, cls, fn) => {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = label;
    b.onclick = fn;
    bar.appendChild(b);
  };
  if (L.canCatch.length) {
    add(`✋ TANGKAP! (${secs(st.unoDeadline)}s)`, 'btn-accent pulse', () => doAct({ t: 'catch', target: L.canCatch[0] }));
  }
  if (L.mustRespond) {
    if (L.canCounter.length) add(`🛡 PANTULKAN ${st.pendingDraw}`, 'btn-accent pulse', () => doAct({ t: 'counter', cardId: L.canCounter[0] }));
    add(`Ambil ${st.pendingDraw} kartu`, 'btn-primary', () => doAct({ t: 'draw' }));
    return;
  }
  if (st.turn === my && st.awaiting === 'draw-keep') {
    add('Simpan & Lewati', 'btn-ghost', () => doAct({ t: 'keep' }));
    return;
  }
  if (st.turn === my && st.awaiting === 'play') {
    add('🃏 Ambil Kartu', 'btn-primary', () => doAct({ t: 'draw' }));
  }
  if (L.canUno) add('‼️ UNO!', 'btn-accent pulse', () => doAct({ t: 'uno' }));
  if (L.canJump.length && st.turn !== my) {
    const note = document.createElement('span');
    note.style.cssText = 'font-size:12px;color:var(--blue);font-weight:700';
    note.textContent = '⚡ Jump-in: tap kartu menyala biru!';
    bar.appendChild(note);
  }
}

function renderHand(st) {
  const box = $('#hand');
  box.innerHTML = '';
  const me = st.players[App.mySeat];
  if (!me) return;
  const L = legal(st);
  for (const c of [...me.hand].sort(cmpCard)) {
    const el = cardEl(c);
    if (L.canPlay.includes(c.id)) el.classList.add('playable');
    if (L.canStack.includes(c.id)) el.classList.add('stackable');
    if (L.canJump.includes(c.id)) el.classList.add('jumpable');
    if (L.canCounter.includes(c.id)) el.classList.add('counter-glow');
    el.onclick = () => onCardTap(c.id);
    box.appendChild(el);
  }
  if (st.drawnCard && st.turn === App.mySeat && st.awaiting === 'draw-keep') {
    const el = [...box.children].find((e) => e.dataset.id === st.drawnCard);
    if (el) el.classList.add('sel');
  }
}

/* ---------- aksi ---------- */
function doAct(act) {
  if (App.mode === 'local') {
    uno.applyAction(App.st, App.mySeat, act);
    afterLocalAction();
  } else {
    send({ t: 'action', action: act });
  }
}
function onCardTap(cardId) {
  const st = App.st;
  if (!st || st.phase !== 'playing') return;
  const L = legal(st);
  const card = st.players[App.mySeat].hand.find((c) => c.id === cardId);
  if (!card) return;
  if (L.canPlay.includes(cardId) || L.canStack.includes(cardId)) {
    if (card.kind === 'wild' || card.kind === 'd4' || card.kind === 'd99') {
      askColor((col) => doAct({ t: 'play', cardId, color: col }));
      return;
    }
    // kartu 7: mainkan dulu, engine minta target tukar setelahnya (modal muncul otomatis)
    doAct({ t: 'play', cardId });
    return;
  }
  if (L.canJump.includes(cardId)) { doAct({ t: 'jump', cardId }); return; }
  if (L.canCounter.includes(cardId)) { doAct({ t: 'counter', cardId }); return; }
  toast('Kartu ini belum bisa dimainkan');
}

/* ============================================================
   MODE LOKAL (vs bot)
   ============================================================ */
function clearTimers() { App.timers.forEach(clearTimeout); App.timers = []; }
function later(fn, ms) { const t = setTimeout(fn, ms); App.timers.push(t); return t; }

function startLocal(botCount) {
  clearTimers();
  const players = [{ name: store.name || 'Kamu', isBot: false }];
  for (let i = 1; i <= botCount; i++) players.push({ name: 'Bot ' + i, isBot: true });
  App.mode = 'local';
  App.mySeat = 0;
  App.roundEndShown = false;
  App.st = uno.newGame({ players });
  uno.startRound(App.st);
  closeModal(true);
  show('screen-game');
  afterLocalAction();
}

function afterLocalAction() {
  clearTimers();
  const st = App.st;
  renderGame();
  if (!st || st.phase !== 'playing') return;

  // jendela UNO: bot memanggil / menangkap
  if (st.unoPending !== null && Date.now() < st.unoDeadline) {
    const off = st.unoPending;
    if (st.players[off].isBot) {
      later(() => {
        const s2 = App.st;
        if (s2 && s2.phase === 'playing' && s2.unoPending === off) {
          uno.applyAction(s2, off, { t: 'uno' });
          afterLocalAction();
        }
      }, 700 + Math.random() * 500);
    } else {
      const catcher = st.players.findIndex((p) => p.isBot);
      if (catcher >= 0) {
        later(() => {
          const s2 = App.st;
          if (s2 && s2.phase === 'playing' && s2.unoPending === off) {
            uno.applyAction(s2, catcher, { t: 'catch', target: off });
            afterLocalAction();
          }
        }, 1300 + Math.random() * 900);
      }
    }
  }

  // giliran bot
  if (st.players[st.turn].isBot) {
    later(() => {
      const s2 = App.st;
      if (!s2 || s2.phase !== 'playing') return;
      const act = botAction(s2, s2.turn);
      if (act) uno.applyAction(s2, s2.turn, act);
      afterLocalAction();
    }, 850 + Math.random() * 750);
  }
}

/* ============================================================
   MODE ONLINE (WebSocket)
   ============================================================ */
function send(o) { if (App.ws && App.ws.readyState === 1) App.ws.send(JSON.stringify(o)); }

function connect(then) {
  if (App.ws && App.ws.readyState === 1) { then && then(); return; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  try {
    ws = new WebSocket(`${proto}://${location.host}`);
  } catch {
    toast('Tidak bisa membuka koneksi ke server');
    goHome();
    return;
  }
  App.ws = ws;
  ws.onmessage = (e) => { try { onServerMsg(JSON.parse(e.data)); } catch { /* abaikan */ } };
  ws.onopen = () => { App.wsOpened = true; then && then(); };
  // Server tidak terjangkau: beri tahu pengguna penyebab yang paling mungkin.
  ws.onerror = () => {
    if (!App.wsOpened && App.mode !== 'online') {
      toast('❌ Tidak bisa terhubung ke server! Pastikan: (1) server jalan di PC, (2) HP & PC di WiFi yang sama, (3) firewall mengizinkan Node.js');
    }
  };
  ws.onclose = () => {
    App.wsOpened = false;
    if (App.mode !== 'online') return;
    // Coba sambung ulang dulu (token ada di sessionStorage, server bisa memulihkan kursi).
    if (App.roomCode && App.reconnectTry < 3) {
      App.reconnectTry++;
      toast(`Koneksi putus — menyambung ulang (${App.reconnectTry}/3)...`);
      setTimeout(() => {
        if (App.mode !== 'online') return;
        connect(() => send({ t: 'join', code: App.roomCode, name: store.name, token: store.token }));
      }, 1000 * App.reconnectTry);
      return;
    }
    goHome('Koneksi terputus');
  };
}

function goHome(message) {
  App.ws = null; App.st = null; App.lobby = null; App.mode = null;
  App.roomCode = null; App.reconnectTry = 0;
  if (message) toast(message);
  show('screen-home');
}

function onServerMsg(msg) {
  switch (msg.t) {
    case 'joined':
      store.token = msg.token;
      App.mySeat = msg.seat;
      App.reconnectTry = 0;
      break;
    case 'kicked':
      goHome(msg.msg || 'Kamu dikeluarkan dari ruang');
      break;
    case 'lobby': {
      App.lobby = msg;
      App.mode = 'online';
      App.roomCode = msg.code || App.roomCode;
      App.reconnectTry = 0;
      App.isHost = msg.hostSeat === App.mySeat;
      App.roundEndShown = false;
      const meSeat = (msg.seats || []).find((s) => s && s.seat === App.mySeat);
      if (meSeat) setChips(meSeat.chips);
      closeModal(true); // tutup modal akhir ronde / modal dalam game yang masih menggantung
      show('screen-lobby');
      renderLobby();
      break;
    }
    case 'err':
      toast(msg.msg);
      // Gagal saat menyambung ulang (ruang sudah hilang / penuh) -> kembali ke menu.
      if (App.reconnectTry > 0) goHome();
      break;
    default:
      if (msg.players) {
        if (typeof msg.now === 'number') {
          const off = Date.now() - msg.now;
          if (typeof msg.unoDeadline === 'number') msg.unoDeadline += off;
          if (typeof msg.turnDeadline === 'number') msg.turnDeadline += off;
        }
        if (msg.settings && msg.settings.turnTime > 0) App.turnTotal = msg.settings.turnTime;
        if (Array.isArray(msg.chips)) setChips(msg.chips[App.mySeat]);
        App.st = msg;
        App.mode = 'online';
        App.reconnectTry = 0;
        App.roundEndShown = false;
        closeModal(true);
        show('screen-game');
        renderGame();
      }
  }
}

/* ---------- lobby ---------- */
function renderLobby() {
  const lb = App.lobby;
  if (!lb) return;
  $('#lobby-code').textContent = lb.code;
  const box = $('#lobby-players');
  box.innerHTML = '';
  (lb.seats || []).forEach((s, i) => {
    if (!s) return;
    const div = document.createElement('div');
    div.className = 'pl-row';
    div.innerHTML = `
      <div class="ava" style="background:${AVA[i % AVA.length]}">${esc((s.name || '?')[0].toUpperCase())}</div>
      <div class="nm">${esc(s.name)} ${s.isBot ? '🤖' : ''}${i === lb.hostSeat ? ' 👑' : ''}
        <i>${s.isBot ? 'bot' : s.connected ? 'terhubung' : 'terputus'}</i></div>
      <div class="chipn">🪙 ${fmt(s.chips)}</div>`;
    box.appendChild(div);
  });
  const count = (lb.seats || []).filter(Boolean).length;
  $('#btn-addbot').classList.toggle('hidden', !(App.isHost && count < Math.min(lb.settings.maxPlayers, 6)));

  const sl = $('#lobby-settings');
  sl.innerHTML = '';
  const line = (txt) => {
    const d = document.createElement('div');
    d.className = 'set-line';
    d.textContent = txt;
    sl.appendChild(d);
  };
  Object.entries(RULE_LABELS).forEach(([k, [t]]) => {
    const on = !!lb.settings[k];
    if (App.isHost && !App.lobbyInGame) {
      const row = document.createElement('div');
      row.className = 'toggle-row';
      row.innerHTML = `<div class="lbl"><b>${t}</b></div>`;
      const tg = document.createElement('button');
      tg.className = 'tgl' + (on ? ' on' : '');
      tg.onclick = () => send({ t: 'settings', patch: { [k]: !on } });
      row.appendChild(tg);
      sl.appendChild(row);
    } else {
      line(`${t}: ${on ? '✅' : '❌'}`);
    }
  });
  line(`Taruhan/ronde: ${lb.settings.ante} chip · Waktu giliran: ${lb.settings.turnTime ? lb.settings.turnTime + 's' : 'bebas'}`);
  line('Pemenang ronde mengambil pot dari tiap pemain');

  $('#btn-start').classList.toggle('hidden', !App.isHost);
  $('#btn-start').disabled = count < 2;
  $('#btn-start').textContent = count < 2 ? 'Minimal 2 pemain' : '▶ Mulai Main';

  // Undangan WiFi: QR yang memuat alamat server + kode ruang (teman tinggal scan)
  const inv = $('#lobby-invite');
  const urls = (App.isHost && Array.isArray(lb.lanUrls)) ? lb.lanUrls : null;
  if (urls && urls.length) {
    inv.classList.remove('hidden');
    const qrs = $('#invite-qrs');
    qrs.innerHTML = '';
    for (const u of urls) {
      const full = `${u}/?join=${encodeURIComponent(lb.code)}`;
      const item = document.createElement('a');
      item.className = 'qr-item';
      item.href = full;
      item.innerHTML = `<img src="/qr?text=${encodeURIComponent(full)}" alt="QR undangan">
        <b>${esc(u.replace('http://', ''))}</b>
        <span>scan → isi nama → Gabung</span>`;
      qrs.appendChild(item);
    }
  } else {
    inv.classList.add('hidden');
  }
}

/* ---------- ronde selesai ---------- */
function maybeRoundEnd(st) {
  if (st.phase !== 'roundEnd') { App.roundEndShown = false; return; }
  if (App.roundEndShown) return;
  App.roundEndShown = true;
  openModal(roundEndModal(st), true);
}
function roundEndModal(st) {
  const wrap = document.createElement('div');
  wrap.className = 'modal round-end';
  let rows = '';
  if (Array.isArray(st.deltas)) {
    st.players.forEach((p, i) => {
      const d = (st.deltas[i] || 0);
      rows += `<div class="delta-row ${d > 0 ? 'win' : ''}"><span>${esc(p.name)}</span>
        <span class="${d > 0 ? 'd-plus' : 'd-minus'}">${d > 0 ? '+' : ''}${fmt(d)}</span></div>`;
    });
  } else {
    st.players.forEach((p) => {
      const tot = p.hand.reduce((s, c) => s + uno.cardScore(c), 0);
      rows += `<div class="delta-row ${p.seat === st.winner ? 'win' : ''}"><span>${esc(p.name)}</span>
        <span>${p.seat === st.winner ? '🏆 MENANG' : tot + ' poin sisa'}</span></div>`;
    });
  }
  wrap.innerHTML = `<div class="crown">👑</div><h3>${esc(st.players[st.winner].name)} menang ronde ${st.round}!</h3>${rows}`;
  const btn = document.createElement('button');
  btn.className = 'btn btn-accent big';
  if (App.mode === 'local') {
    btn.textContent = '🔁 Main Lagi';
    btn.onclick = () => { closeModal(true); uno.startRound(App.st); App.roundEndShown = false; renderGame(); afterLocalAction(); };
  } else if (App.isHost) {
    btn.textContent = '▶ Ronde Berikutnya';
    btn.onclick = () => { closeModal(true); send({ t: 'next' }); };
  } else {
    btn.disabled = true;
    btn.textContent = '⏳ Menunggu tuan rumah…';
  }
  wrap.appendChild(btn);
  // Host online bisa menutup meja dan membawa semua pemain balik ke lobby
  if (App.mode === 'online' && App.isHost) {
    const lob = document.createElement('button');
    lob.className = 'btn btn-outline';
    lob.textContent = '🏠 Kembali ke Lobby';
    lob.onclick = () => { closeModal(true); send({ t: 'lobby' }); };
    wrap.appendChild(lob);
  }
  const quit = document.createElement('button');
  quit.className = 'btn btn-ghost';
  quit.textContent = '🚪 Keluar dari meja';
  quit.onclick = leaveGame;
  wrap.appendChild(quit);
  return wrap;
}

/* ---------- keluar ---------- */
function leaveGame() {
  clearTimers();
  const wasOnline = App.mode === 'online';
  App.mode = null;            // set dulu supaya onclose tidak memicu sambung ulang
  App.roomCode = null;
  App.reconnectTry = 0;
  if (wasOnline) {
    send({ t: 'leave' });
    try { App.ws && App.ws.close(); } catch { }
    App.ws = null;
  }
  App.st = null; App.lobby = null; App.roundEndShown = false;
  closeModal(true);
  updateChipsUI();
  show('screen-home');
}

/* ============================================================
   EVENT UI AWAL
   ============================================================ */
function ensureName() {
  if (!store.name.trim()) {
    store.name = 'Pemain' + Math.floor(Math.random() * 900 + 100);
    $('#inp-name').value = store.name;
  }
}

function buildCreateToggles() {
  const box = $('#create-toggles');
  box.innerHTML = '';
  Object.entries(RULE_LABELS).forEach(([k, [t, d]]) => {
    const row = document.createElement('div');
    row.className = 'toggle-row';
    row.innerHTML = `<div class="lbl"><b>${t}</b><i>${d}</i></div>`;
    const tg = document.createElement('button');
    tg.className = 'tgl' + (App.createRules[k] ? ' on' : '');
    tg.onclick = () => { App.createRules[k] = !App.createRules[k]; tg.classList.toggle('on'); };
    row.appendChild(tg);
    box.appendChild(row);
  });
}

function init() {
  $('#inp-name').value = store.name;
  updateChipsUI();
  buildCreateToggles();

  $('#inp-name').addEventListener('input', (e) => { store.name = e.target.value.trim(); });
  $('#btn-topup').onclick = () => { store.chips += 5000; updateChipsUI(); toast('🎁 +5.000 chip gratis ditambahkan!'); };

  $('#btn-create').onclick = () => { ensureName(); show('screen-create'); };
  $('#btn-create-go').onclick = () => {
    ensureName();
    const settings = {
      ...App.createRules,
      ante: +$('#sel-ante').value,
      turnTime: +$('#sel-turntime').value,
      maxPlayers: +$('#sel-maxp').value,
    };
    connect(() => send({ t: 'create', name: store.name, chips: store.chips, token: store.token, settings }));
  };
  $('#btn-join').onclick = () => { ensureName(); show('screen-join'); };
  $('#btn-join-go').onclick = () => {
    ensureName();
    const code = $('#inp-code').value.trim().toUpperCase();
    if (code.length < 4) { toast('Kode ruang harus 4 huruf'); return; }
    App.roomCode = code;
    App.reconnectTry = 0;
    connect(() => send({ t: 'join', code, name: store.name, chips: store.chips, token: store.token }));
  };
  $('#btn-local').onclick = () => {
    ensureName();
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = '<h3>🤖 Latihan melawan berapa bot?</h3><p class="hint" style="margin-top:-8px">Mode latihan — chip tidak dipertaruhkan</p>';
    const g = document.createElement('div');
    g.className = 'target-list';
    [1, 2, 3, 4].forEach((n) => {
      const b = document.createElement('button');
      b.className = 'target-btn';
      b.textContent = `${n} bot`;
      b.onclick = () => startLocal(n);
      g.appendChild(b);
    });
    m.appendChild(g);
    openModal(m, false);
  };

  $('#btn-addbot').onclick = () => send({ t: 'addBot' });
  $('#btn-start').onclick = () => send({ t: 'start' });
  $('#btn-leave').onclick = leaveGame;
  $('#btn-copy').onclick = async () => {
    const code = App.lobby ? App.lobby.code : '';
    try { await navigator.clipboard.writeText(code); toast('Kode ' + code + ' disalin!'); }
    catch { toast('Kode ruang: ' + code); }
  };

  document.querySelectorAll('[data-back]').forEach((b) => { b.onclick = () => { if (!App.mode) show('screen-home'); }; });

  // PWA
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    App.installEvt = e;
    $('#btn-install').classList.remove('hidden');
  });
  $('#btn-install').onclick = async () => {
    if (!App.installEvt) return;
    App.installEvt.prompt();
    App.installEvt = null;
    $('#btn-install').classList.add('hidden');
  };
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('/sw.js').catch(() => { });
  }

  // Hasil scan QR undangan: /?join=KODE -> langsung ke layar gabung dengan kode terisi
  const joinCode = (new URLSearchParams(location.search).get('join') || '').trim().toUpperCase();
  if (/^[A-Z0-9]{4}$/.test(joinCode)) {
    ensureName();
    $('#inp-code').value = joinCode;
    show('screen-join');
    toast('Kode ruang terisi — isi namamu lalu tekan Gabung');
  }
}
init();

/* ---------- ticker: timer bar & jendela UNO ---------- */
setInterval(() => {
  const st = App.st;
  const tw = $('#timer-wrap');
  if (!st || st.phase !== 'playing' || $('#screen-game').classList.contains('hidden')) {
    tw.classList.remove('show');
    return;
  }
  if (st.turnDeadline) {
    const total = (App.turnTotal || 30) * 1000;
    const rem = Math.max(0, st.turnDeadline - Date.now());
    tw.classList.add('show');
    const f = $('#timer-fill');
    f.style.width = (rem / total) * 100 + '%';
    f.style.background = rem < 6000 ? 'var(--red)' : rem < 12000 ? 'var(--accent)' : 'var(--green)';
  } else {
    tw.classList.remove('show');
  }
  // jendela UNO habis -> segarkan tombol
  if (st.unoPending !== null && Date.now() >= st.unoDeadline && document.querySelector('#action-bar .pulse')) {
    renderGame();
  }
}, 300);

// ============================================================
// UNO Chips - Engine bersama (dipakai server & browser)
// Aturan: standar + stacking +2/+4, jump-in, 7-0,
//         paket ekstrem (+99 & kartu Counter pemantul)
// ============================================================

export const COLORS = ['R', 'Y', 'G', 'B'];
export const COLOR_NAMES = { R: 'Merah', Y: 'Kuning', G: 'Hijau', B: 'Biru', W: '-' };

export const CARD_LABEL = {
  skip: 'SKIP', rev: 'REVERSE', d2: '+2', wild: 'WILD', d4: '+4',
  d99: '+99', counter: 'COUNTER',
};
export const CARD_ICON = { skip: '⊘', rev: '⇄', d2: '+2', wild: '★', d4: '+4', d99: '+99', counter: '🛡' };
// nilai kartu (untuk statistik akhir ronde)
export const CARD_SCORE = { skip: 20, rev: 20, d2: 20, wild: 50, d4: 50, counter: 40, d99: 90 };

let _id = 0;
function newId() {
  _id = (_id + 1) % 1e9;
  return 'c' + _id.toString(36) + Math.random().toString(36).slice(2, 7);
}

export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function buildDeck(rules) {
  const deck = [];
  const push = (color, kind, val = null) => deck.push({ id: newId(), color, kind, val });
  for (const c of COLORS) {
    push(c, 'num', 0);
    for (let v = 1; v <= 9; v++) { push(c, 'num', v); push(c, 'num', v); }
    for (const k of ['skip', 'rev', 'd2']) { push(c, k); push(c, k); }
  }
  for (let i = 0; i < 4; i++) { push('W', 'wild'); push('W', 'd4'); }
  if (rules.extreme) {
    push('W', 'd99');
    for (let i = 0; i < 4; i++) push('W', 'counter');
  }
  return shuffle(deck);
}

export function cardText(card) {
  return card.kind === 'num' ? String(card.val) : CARD_ICON[card.kind];
}
export function cardScore(card) {
  return card.kind === 'num' ? card.val : CARD_SCORE[card.kind];
}
export function cardName(card) {
  if (card.kind === 'num') return `${COLOR_NAMES[card.color]} ${card.val}`;
  return card.color === 'W' ? CARD_LABEL[card.kind] : `${COLOR_NAMES[card.color]} ${CARD_LABEL[card.kind]}`;
}
export function isWildKind(k) { return k === 'wild' || k === 'd4' || k === 'd99'; }

export function matchesTop(card, st) {
  const top = st.discard[st.discard.length - 1];
  if (!top) return true;
  if (isWildKind(card.kind)) return true;
  if (card.kind === 'num') {
    return card.color === st.activeColor || (top.kind === 'num' && card.val === top.val);
  }
  return card.color === st.activeColor || card.kind === top.kind;
}

// ----- state -----
export function newGame(opts) {
  return {
    rules: Object.assign({ stacking: true, jumpIn: true, sevenZero: true, extreme: true }, opts.rules || {}),
    players: opts.players.map((p, i) => ({
      seat: i, name: p.name, isBot: !!p.isBot, hand: [],
      connected: true, token: p.token || null,
    })),
    deck: [], discard: [], activeColor: null,
    turn: 0, dir: 1, round: 0, phase: 'playing', // phase: playing | roundEnd
    pendingDraw: 0, pendingPlayer: null, stackKind: null, lastAttacker: null,
    awaiting: 'play',       // play | draw-keep | seven
    drawnCard: null,        // id kartu yang baru diambil (boleh dimainkan atau disimpan)
    unoPending: null, unoDeadline: 0,
    winner: null, log: [], events: [],
  };
}

export function startRound(st) {
  st.round++;
  st.deck = buildDeck(st.rules);
  st.discard = [];
  st.pendingDraw = 0; st.pendingPlayer = null; st.stackKind = null; st.lastAttacker = null;
  st.unoPending = null; st.unoDeadline = 0; st.winner = null; st.drawnCard = null;
  st.emptyDraws = 0; st.sigMap = null; st.actionCount = 0;
  for (const p of st.players) p.hand = [];
  st.turn = (st.round - 1) % st.players.length;
  st.dir = 1;
  st.awaiting = 'play';
  for (let i = 0; i < 7; i++) for (const p of st.players) p.hand.push(st.deck.pop());
  // buka kartu atas sampai dapat kartu angka (hindari efek kartu aksi di awal)
  let top;
  do {
    top = st.deck.pop();
    if (top.kind !== 'num') st.deck.unshift(top);
  } while (top.kind !== 'num');
  st.discard.push(top);
  st.activeColor = top.color;
  st.log = [`Ronde ${st.round} dimulai — ${st.players[st.turn].name} jalan duluan`];
  st.events = [{ type: 'roundStart' }];
  return st;
}

function nextSeat(st, from = st.turn) {
  const n = st.players.length;
  return (from + st.dir + n * 4) % n;
}
function advanceTurn(st, from = st.turn, steps = 1) {
  const n = st.players.length;
  st.turn = (from + st.dir * steps + n * 8) % n;
}
function drawCard(st) {
  if (!st.deck.length) {
    const top = st.discard.pop();
    if (st.discard.length) {
      st.deck = shuffle(st.discard);
      st.discard = [top];
    } else if (top) {
      st.discard.push(top);
      return null;
    } else return null;
  }
  return st.deck.pop() || null;
}
function availableCards(st) {
  return st.deck.length + Math.max(0, st.discard.length - 1);
}

// ----- legalitas -----
export function legalMoves(st, seat) {
  const L = {
    canPlay: [], canJump: [], canCounter: [], canStack: [],
    canDraw: false, canKeep: false, canUno: false, canCatch: [],
    mustRespond: false, canChooseSwap: null,
  };
  if (st.phase !== 'playing') return L;
  const now = Date.now();
  if (st.unoPending !== null && st.unoPending !== seat && now < st.unoDeadline) {
    L.canCatch = [st.unoPending];
  }
  if (st.unoPending === seat && now < st.unoDeadline) {
    L.canUno = true; // boleh telat bilang UNO selama jendela waktu terbuka
  }
  const p = st.players[seat];
  const me = seat === st.turn;

  // respons penalti (pending draw)
  if (st.pendingDraw > 0 && st.pendingPlayer === seat) {
    L.mustRespond = true;
    L.canDraw = true; // makan penalti
    for (const c of p.hand) {
      if (st.rules.extreme && c.kind === 'counter') L.canCounter.push(c.id);
      else if (canStackOn(c, st)) L.canStack.push(c.id);
    }
    return L;
  }

  if (me && st.awaiting === 'seven') {
    L.canChooseSwap = st.players.filter((q) => q.seat !== seat).map((q) => q.seat);
    return L;
  }

  if (me && (st.awaiting === 'play' || st.awaiting === 'draw-keep')) {
    if (st.awaiting === 'play') {
      for (const c of p.hand) if (matchesTop(c, st)) L.canPlay.push(c.id);
      L.canDraw = true;
    }
    if (st.drawnCard !== null) { // baru mengambil 1 kartu
      L.canDraw = false;
      L.canKeep = true;
      const dc = p.hand.find((c) => c.id === st.drawnCard);
      L.canPlay = dc && matchesTop(dc, st) ? [dc.id] : [];
    }
  }

  // jump-in: kartu identik dengan kartu atas (bukan wild), di luar giliran
  if (!me && st.awaiting === 'play' && st.pendingDraw === 0 && st.rules.jumpIn) {
    const top = st.discard[st.discard.length - 1];
    if (top && top.color !== 'W') {
      for (const c of p.hand) {
        if (c.color === top.color && c.kind === top.kind && (c.kind !== 'num' || c.val === top.val)) {
          L.canJump.push(c.id);
        }
      }
    }
  }
  return L;
}

export function canStackOn(card, st) {
  if (!st.rules.stacking || st.pendingDraw <= 0) return false;
  if (card.kind === 'd2' || card.kind === 'd4') return st.stackKind !== 'd99';
  if (card.kind === 'd99') return st.stackKind === 'd99';
  return false;
}

// ----- aksi -----
export function applyAction(st, seat, act) {
  st.events = [];
  if (st.phase !== 'playing') return st.events;
  switch (act.t) {
    case 'play': doPlay(st, seat, act.cardId, act.color, act.target); break;
    case 'jump': doJump(st, seat, act.cardId); break;
    case 'counter': doCounter(st, seat, act.cardId); break;
    case 'swap': doSwap(st, seat, act.target); break;
    case 'draw': doDraw(st, seat); break;
    case 'keep': doKeep(st, seat); break;
    case 'uno': doUno(st, seat); break;
    case 'catch': doCatch(st, seat, act.target); break;
  }
  if (st.phase === 'playing') detectCycle(st);
  // pengaman: ronde yang berjalan tidak wajar lama diakhiri (tangan terkecil menang)
  st.actionCount = (st.actionCount || 0) + 1;
  if (st.phase === 'playing' && st.actionCount > st.players.length * 120) {
    declareStalemate(st);
  }
  return st.events;
}

// deteksi macet: keadaan persis sama muncul berulang (siklus ping-pong kartu)
function stateSig(st) {
  return JSON.stringify([
    st.turn, st.dir, st.activeColor, st.pendingDraw, st.pendingPlayer,
    st.stackKind, st.lastAttacker, st.awaiting, st.drawnCard, st.unoPending,
    st.discard.length ? st.discard[st.discard.length - 1].id : null,
    st.players.map((p) => p.hand.map((c) => c.id).sort().join('|')),
    st.deck.map((c) => c.id).join('|'),
    st.discard.map((c) => c.id).join('|'),
  ]);
}
function detectCycle(st) {
  if (!st.sigMap) st.sigMap = new Map();
  if (st.sigMap.size > 3000) st.sigMap.clear();
  const sig = stateSig(st);
  const n = (st.sigMap.get(sig) || 0) + 1;
  st.sigMap.set(sig, n);
  if (n >= 3) declareStalemate(st);
}

function placeCard(st, seat, card) {
  const p = st.players[seat];
  p.hand = p.hand.filter((c) => c.id !== card.id);
  st.discard.push(card);
  st.drawnCard = null;
  if (p.hand.length === 1 && st.unoPending !== seat) {
    st.unoPending = seat;
    st.unoDeadline = Date.now() + 4000;
  } else if (p.hand.length !== 1) {
    st.unoPending = null;
  }
}

function doPlay(st, seat, cardId, chosenColor, swapTarget) {
  const p = st.players[seat];
  const L = legalMoves(st, seat);
  let card = null, viaStack = false;
  if (L.canPlay.includes(cardId)) card = p.hand.find((c) => c.id === cardId);
  else if (L.canStack.includes(cardId)) { card = p.hand.find((c) => c.id === cardId); viaStack = true; }
  if (!card) return st.events;

  st.log.push(`${p.name} memainkan ${cardName(card)}`);
  placeCard(st, seat, card);
  // kartu berwarna menentukan warna aktif (wild menyetel warna pilihannya sendiri)
  if (card.color !== 'W') st.activeColor = card.color;

  if (viaStack) {
    // menumpuk penalti ke pemain berikutnya
    st.pendingDraw += card.kind === 'd2' ? 2 : card.kind === 'd4' ? 4 : 99;
    st.stackKind = card.kind;
    if (card.kind === 'd4' || card.kind === 'd99') st.activeColor = chosenColor || 'R';
    st.lastAttacker = seat;
    st.pendingPlayer = nextSeat(st);
    st.turn = st.pendingPlayer;
    st.events.push({ type: 'stack', from: seat, to: st.pendingPlayer, amount: st.pendingDraw });
    st.log.push(`Penalti jadi ${st.pendingDraw} kartu! ${st.players[st.pendingPlayer].name} kena...`);
    checkWin(st);
    if (st.phase === 'roundEnd') clearPending(st);
    return st.events;
  }

  switch (card.kind) {
    case 'num':
      if (st.rules.sevenZero && card.val === 7) {
        if (!p.hand.length) { checkWin(st); return st.events; } // kartu terakhir
        st.awaiting = 'seven';
        st.events.push({ type: 'seven', seat });
        st.log.push(`${p.name} mainkan 7 — pilih tangan untuk ditukar!`);
        return st.events;
      }
      if (st.rules.sevenZero && card.val === 0) {
        rotateHands(st);
        st.events.push({ type: 'rotate' });
        st.log.push(`Semua tangan diputar!`);
      }
      advanceTurn(st);
      break;
    case 'skip': {
      const skipped = nextSeat(st);
      st.events.push({ type: 'skip', seat: skipped });
      st.log.push(`${st.players[skipped].name} dilewati!`);
      advanceTurn(st, st.turn, 2);
      break;
    }
    case 'rev':
      st.dir *= -1;
      st.events.push({ type: 'reverse', dir: st.dir });
      st.log.push(`Arah putar dibalik!`);
      advanceTurn(st, st.turn, st.players.length === 2 ? 2 : 1);
      break;
    case 'd2':
    case 'd4':
    case 'd99': {
      const amount = card.kind === 'd2' ? 2 : card.kind === 'd4' ? 4 : 99;
      if (card.kind !== 'd2') st.activeColor = chosenColor || 'R';
      st.pendingDraw = amount;
      st.stackKind = card.kind;
      st.lastAttacker = seat;
      st.pendingPlayer = nextSeat(st);
      st.turn = st.pendingPlayer;
      st.events.push({ type: 'stack', from: seat, to: st.pendingPlayer, amount });
      st.log.push(`${st.players[st.pendingPlayer].name} harus mengambil ${amount} kartu!`);
      checkWin(st);
      if (st.phase === 'roundEnd') clearPending(st);
      return st.events;
    }
    case 'wild':
      st.activeColor = chosenColor || 'R';
      st.events.push({ type: 'color', color: st.activeColor, by: seat });
      st.log.push(`Warna jadi ${COLOR_NAMES[st.activeColor]}`);
      advanceTurn(st);
      break;
  }
  st.awaiting = 'play';
  checkWin(st);
  return st.events;
}

function doJump(st, seat, cardId) {
  const L = legalMoves(st, seat);
  if (!L.canJump.includes(cardId)) return st.events;
  const p = st.players[seat];
  const card = p.hand.find((c) => c.id === cardId);
  st.log.push(`${p.name} JUMP-IN dengan ${cardName(card)}!`);
  st.turn = seat;
  st.events.push({ type: 'jump', seat });
  return doPlay(st, seat, cardId, card.color === 'W' ? 'R' : undefined);
}

function doCounter(st, seat, cardId) {
  const L = legalMoves(st, seat);
  if (!L.canCounter.includes(cardId)) return st.events;
  const p = st.players[seat];
  const card = p.hand.find((c) => c.id === cardId);
  const victim = st.lastAttacker;
  if (victim === null || victim === undefined) return st.events;
  placeCard(st, seat, card);
  st.lastAttacker = seat;
  st.pendingPlayer = victim;
  st.turn = victim;
  st.events.push({ type: 'bounce', from: seat, to: victim, amount: st.pendingDraw });
  st.log.push(`🛡 ${p.name} memantulkan ${st.pendingDraw} kartu ke ${st.players[victim].name}!`);
  checkWin(st);
  if (st.phase === 'roundEnd') clearPending(st);
  return st.events;
}

function clearPending(st) {
  st.pendingDraw = 0; st.pendingPlayer = null; st.stackKind = null; st.lastAttacker = null;
}

function doSwap(st, seat, target) {
  if (st.awaiting !== 'seven' || st.turn !== seat) return st.events;
  const q = st.players[target];
  if (!q || target === seat) return st.events;
  const tmp = st.players[seat].hand;
  st.players[seat].hand = q.hand;
  q.hand = tmp;
  st.awaiting = 'play';
  st.events.push({ type: 'swap', a: seat, b: target });
  st.log.push(`${st.players[seat].name} menukar tangan dengan ${q.name}`);
  advanceTurn(st);
  checkWin(st);
  return st.events;
}

function rotateHands(st) {
  const n = st.players.length;
  const hands = st.players.map((p) => p.hand);
  for (let i = 0; i < n; i++) {
    st.players[(i + st.dir + n * 4) % n].hand = hands[i];
  }
}

function doDraw(st, seat) {
  const L = legalMoves(st, seat);
  if (!L.canDraw) return st.events;
  const p = st.players[seat];
  if (st.pendingDraw > 0 && st.pendingPlayer === seat) {
    const n = Math.min(st.pendingDraw, availableCards(st));
    for (let i = 0; i < n; i++) {
      const c = drawCard(st);
      if (c) p.hand.push(c);
    }
    st.log.push(`${p.name} mengambil ${n} kartu penalti!`);
    st.events.push({ type: 'eat', seat, amount: n });
    st.pendingDraw = 0; st.pendingPlayer = null; st.stackKind = null; st.lastAttacker = null;
    st.awaiting = 'play';
    advanceTurn(st); // yang makan penalti kehilangan giliran
  } else {
    const c = drawCard(st);
    if (c) {
      p.hand.push(c);
      st.emptyDraws = 0;
      st.events.push({ type: 'draw', seat });
      st.log.push(`${p.name} mengambil 1 kartu`);
      // kalau kartu hasil ambil tak bisa dimainkan, otomatis lewat
      if (!matchesTop(c, st)) {
        st.drawnCard = null;
        st.awaiting = 'play';
        advanceTurn(st);
      } else {
        st.drawnCard = c.id;
        st.awaiting = 'draw-keep';
      }
    } else {
      // deck & discard habis — hitung putaran kosong
      st.emptyDraws = (st.emptyDraws || 0) + 1;
      st.log.push(`${p.name} tidak bisa mengambil kartu (deck habis)`);
      if (st.emptyDraws >= st.players.length) {
        declareStalemate(st);
        return st.events;
      }
      st.drawnCard = null;
      st.awaiting = 'play';
      advanceTurn(st);
    }
  }
  checkWin(st);
  return st.events;
}

function doKeep(st, seat) {
  const L = legalMoves(st, seat);
  if (!L.canKeep) return st.events;
  st.drawnCard = null;
  st.awaiting = 'play';
  advanceTurn(st);
  return st.events;
}

function doUno(st, seat) {
  if (st.unoPending !== seat || Date.now() >= st.unoDeadline) return st.events;
  st.unoPending = null;
  st.events.push({ type: 'uno', seat });
  st.log.push(`${st.players[seat].name}: UNO!`);
  return st.events;
}

function doCatch(st, seat, target) {
  const L = legalMoves(st, seat);
  if (!L.canCatch.includes(target) || Date.now() >= st.unoDeadline) return st.events;
  const offender = st.players[target];
  const n = Math.min(2, availableCards(st));
  for (let i = 0; i < n; i++) {
    const c = drawCard(st);
    if (c) offender.hand.push(c);
  }
  st.unoPending = null;
  st.events.push({ type: 'caught', seat: target, by: seat, amount: n });
  st.log.push(`>${offender.name} tertangkap lupa bilang UNO — ambil ${n} kartu!`);
  return st.events;
}

export function checkWin(st) {
  const w = st.players.find((p) => p.hand.length === 0);
  if (w) {
    st.phase = 'roundEnd';
    st.winner = w.seat;
    const totals = st.players.map((p) => p.hand.reduce((s, c) => s + cardScore(c), 0));
    st.log.push(`🏆 ${w.name} MENANG ronde ini!`);
    st.events.push({ type: 'roundOver', winner: w.seat, totals });
  }
  return st.winner !== null;
}

// deck habis total & tak ada yang bisa main: tangan terkecil menang
function declareStalemate(st) {
  st.phase = 'roundEnd';
  st.emptyDraws = 0;
  st.sigMap = null;
  let winner = 0, best = Infinity;
  st.players.forEach((p) => {
    const cnt = p.hand.length;
    const score = p.hand.reduce((s, c) => s + cardScore(c), 0);
    if (cnt < best || (cnt === best && score < st.players[winner].hand.reduce((s, c) => s + cardScore(c), 0))) {
      best = cnt; winner = p.seat;
    }
  });
  st.winner = winner;
  const totals = st.players.map((p) => p.hand.reduce((s, c) => s + cardScore(c), 0));
  st.log.push(`⚖️ Deck habis — ${st.players[winner].name} menang dengan tangan terkecil!`);
  st.events.push({ type: 'roundOver', winner, totals, stalemate: true });
}

// ----- view per pemain (sembunyikan kartu lawan) -----
export function viewFor(st, seat) {
  const v = JSON.parse(JSON.stringify(st));
  v.log = v.log.slice(-30);
  // Jangan kirim isi deck ke klien: urutan deck = tahu semua kartu yang akan datang (curang).
  // Klien cuma butuh jumlahnya untuk menampilkan "sisa".
  v.deckCount = Array.isArray(st.deck) ? st.deck.length : 0;
  v.deck = [];
  delete v.sigMap;
  v.players.forEach((p) => {
    // Token identitas hanya boleh diketahui pemiliknya (dikirim lewat pesan 'joined'),
    // bukan disiarkan ke semua orang lewat state permainan.
    delete p.token;
    if (p.seat !== seat) {
      p.handCount = p.hand.length;
      p.hand = [];
    }
  });
  return v;
}

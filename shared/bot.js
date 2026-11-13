// ============================================================
// Bot AI - pilih aksi terbaik dari state & legal moves
// ============================================================
import { legalMoves, cardName } from './uno.js';

function find(hand, id) { return hand.find((c) => c.id === id); }

function bestColor(hand) {
  const count = { R: 0, Y: 0, G: 0, B: 0 };
  for (const c of hand) if (count[c.color] !== undefined) count[c.color]++;
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0][0] || 'R';
}

// prioritas menumpuk penalti
function stackPref(c) { return c.kind === 'd4' ? 2 : c.kind === 'd2' ? 1 : 0; }

// skor daya guna kartu untuk diprioritaskan keluar
function playPref(st, seat, c) {
  const next = st.players[(st.turn + st.dir + st.players.length * 4) % st.players.length];
  const nextLow = next.hand.length <= 2;
  switch (c.kind) {
    case 'd99':
      // senjata pamungkas: hanya tembakkan saat lawan tinggal 1 kartu dari kemenangan
      return next.hand.length <= 1 ? 100 : 5;
    case 'd2': return nextLow ? 90 : 60;
    case 'd4': return nextLow ? 88 : 58;
    case 'skip': return nextLow ? 85 : 55;
    case 'rev': return nextLow ? 70 : 50;
    case 'num': {
      // buang angka besar, utamakan warna yang paling banyak di tangan
      const sameColor = st.players[seat].hand.filter((h) => h.color === c.color).length;
      return 20 + c.val + sameColor * 3;
    }
    case 'wild': return 15;
    default: return 0;
  }
}

export function botAction(st, seat) {
  const L = legalMoves(st, seat);
  const p = st.players[seat];

  // 1. tangkap pemain yang lupa bilang UNO
  if (L.canCatch.length) return { t: 'catch', target: L.canCatch[0] };

  // 2. panggil UNO untuk diri sendiri
  if (L.canUno) return { t: 'uno' };

  // 3. respons penalti: pantulkan / tumpuk / makan
  if (L.mustRespond) {
    if (L.canCounter.length && st.pendingDraw >= 10) {
      // Counter hanya untuk penalti besar (+99) — penalti kecil tidak worth kartu 🛡
      return { t: 'counter', cardId: L.canCounter[0] };
    }
    if (L.canStack.length) {
      const cards = L.canStack.map((id) => find(p.hand, id)).sort((a, b) => stackPref(b) - stackPref(a));
      return { t: 'play', cardId: cards[0].id, color: bestColor(p.hand) };
    }
    if (L.canDraw) return { t: 'draw' };
    return null;
  }

  // 4. selesaikan penukaran tangan (kartu 7)
  if (L.canChooseSwap) {
    let best = L.canChooseSwap[0], min = Infinity;
    for (const s of L.canChooseSwap) {
      const q = st.players[s];
      if (q.hand.length < min) { min = q.hand.length; best = s; }
    }
    return { t: 'swap', target: best };
  }

  // 5. giliran bot: mainkan kartu terbaik
  if (st.turn === seat && st.awaiting === 'play') {
    if (!L.canPlay.length) return { t: 'draw' };
    const cards = L.canPlay.map((id) => find(p.hand, id));
    cards.sort((a, b) => playPref(st, seat, b) - playPref(st, seat, a));
    const pick = cards[0];
    const act = { t: 'play', cardId: pick.id };
    if (pick.kind === 'wild' || pick.kind === 'd4' || pick.kind === 'd99') act.color = bestColor(p.hand);
    return act;
  }

  // 6. habis mengambil kartu: mainkan kalau bisa, kalau tidak simpan
  if (st.turn === seat && st.awaiting === 'draw-keep') {
    if (L.canPlay.length) {
      const pick = find(p.hand, L.canPlay[0]);
      const act = { t: 'play', cardId: pick.id };
      if (pick.kind === 'wild' || pick.kind === 'd4' || pick.kind === 'd99') act.color = bestColor(p.hand);
      return act;
    }
    return { t: 'keep' };
  }

  // 7. jump-in: ganggu kalau kartunya berguna
  if (st.turn !== seat && L.canJump.length) {
    const cards = L.canJump.map((id) => find(p.hand, id));
    const juicy = cards.find((c) => c.kind === 'd99' || c.kind === 'd2' || c.kind === 'd4' || c.kind === 'skip');
    if (juicy) return { t: 'jump', cardId: juicy.id };
    if (p.hand.length <= 3) return { t: 'jump', cardId: cards[0].id };
  }

  return null;
}

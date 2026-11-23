// Online chess server for Chess XB (Vercel serverless function: /api/chess).
// Stores users, friends, challenges and live games in an Upstash Redis database.
// Needs the env vars KV_REST_API_URL + KV_REST_API_TOKEN (added automatically when you
// connect an "Upstash for Redis" database to this project in the Vercel dashboard).
//
// The chess rules below are a copy of engineFactory() from chess/index.html, so the
// server can check every online move. If you change the rules there, copy them here too.
const crypto = require("crypto");

/* ---------------- chess rules (copied from chess/index.html) ---------------- */
function engineFactory() {
  const isW = p => p && p < "a";
  const sideOf = p => (isW(p) ? "w" : "b");
  const N_OFF = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
  const K_OFF = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  const DIAG = [[-1,-1],[-1,1],[1,-1],[1,1]];
  const ORTH = [[-1,0],[1,0],[0,-1],[0,1]];

  function startState() {
    const b = new Array(64).fill(null);
    const back = "rnbqkbnr";
    for (let c = 0; c < 8; c++) { b[c] = back[c]; b[8 + c] = "p"; b[48 + c] = "P"; b[56 + c] = back[c].toUpperCase(); }
    return { b, turn: "w", castle: { K: true, Q: true, k: true, q: true }, ep: -1, half: 0, full: 1 };
  }
  function fromFEN(fen) {
    const [pos, turn, cas, ep, half, full] = fen.split(" ");
    const b = []; for (const ch of pos) { if (ch === "/") continue; if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) b.push(null); else b.push(ch); }
    const sq = ep && ep !== "-" ? (8 - +ep[1]) * 8 + (ep.charCodeAt(0) - 97) : -1;
    return { b, turn, castle: { K: cas.includes("K"), Q: cas.includes("Q"), k: cas.includes("k"), q: cas.includes("q") }, ep: sq, half: +half || 0, full: +full || 1 };
  }
  function attacked(b, sq, by) {
    const r = sq >> 3, c = sq & 7, W = by === "w";
    const pr = W ? r + 1 : r - 1, pawn = W ? "P" : "p";
    if (pr >= 0 && pr < 8) {
      if (c > 0 && b[pr * 8 + c - 1] === pawn) return true;
      if (c < 7 && b[pr * 8 + c + 1] === pawn) return true;
    }
    const kn = W ? "N" : "n", kg = W ? "K" : "k";
    for (const [dr, dc] of N_OFF) { const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === kn) return true; }
    for (const [dr, dc] of K_OFF) { const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === kg) return true; }
    const q = W ? "Q" : "q", rk = W ? "R" : "r", bs = W ? "B" : "b";
    for (const [dr, dc] of ORTH) {
      let rr = r + dr, cc = c + dc;
      while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) { const p = b[rr * 8 + cc]; if (p) { if (p === q || p === rk) return true; break; } rr += dr; cc += dc; }
    }
    for (const [dr, dc] of DIAG) {
      let rr = r + dr, cc = c + dc;
      while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) { const p = b[rr * 8 + cc]; if (p) { if (p === q || p === bs) return true; break; } rr += dr; cc += dc; }
    }
    return false;
  }
  // Value of the cheapest piece of side `by` attacking `sq` (0 if none).
  function minAttacker(b, sq, by) {
    const r = sq >> 3, c = sq & 7, W = by === "w";
    let best = 0; const upd = v => { if (!best || v < best) best = v; };
    const pr = W ? r + 1 : r - 1, pawn = W ? "P" : "p";
    if (pr >= 0 && pr < 8) { if ((c > 0 && b[pr * 8 + c - 1] === pawn) || (c < 7 && b[pr * 8 + c + 1] === pawn)) return 100; }
    const kn = W ? "N" : "n", kg = W ? "K" : "k";
    for (const [dr, dc] of N_OFF) { const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === kn) upd(320); }
    const q = W ? "Q" : "q", rk = W ? "R" : "r", bs = W ? "B" : "b";
    for (const [dirs, pc] of [[DIAG, bs], [ORTH, rk]]) for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) { const p = b[rr * 8 + cc]; if (p) { if (p === pc) upd(pc.toLowerCase() === "b" ? 330 : 500); else if (p === q) upd(900); break; } rr += dr; cc += dc; }
    }
    for (const [dr, dc] of K_OFF) { const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === kg) upd(20000); }
    return best;
  }
  const kingSq = (b, side) => b.indexOf(side === "w" ? "K" : "k");
  function inCheck(s, side = s.turn) { const k = kingSq(s.b, side); return k >= 0 && attacked(s.b, k, side === "w" ? "b" : "w"); }

  function pseudoMoves(s, capturesOnly = false) {
    const { b, turn } = s, W = turn === "w", them = W ? "b" : "w";
    const out = [];
    const add = (from, to) => { if (capturesOnly && !b[to]) return; out.push({ from, to }); };
    for (let sq = 0; sq < 64; sq++) {
      const p = b[sq]; if (!p || sideOf(p) !== turn) continue;
      const r = sq >> 3, c = sq & 7, t = p.toLowerCase();
      if (t === "p") {
        const dir = W ? -1 : 1, start = W ? 6 : 1, last = W ? 0 : 7, r1 = r + dir;
        const push = (to, cap) => {
          if (r1 === last) { for (const pr of "qrbn") out.push({ from: sq, to, promo: pr }); }
          else if (cap || !capturesOnly) out.push({ from: sq, to });
        };
        if (r1 >= 0 && r1 < 8) {
          if (!b[r1 * 8 + c]) {
            if (r1 === last || !capturesOnly) push(r1 * 8 + c, false);
            if (r === start && !b[(r + 2 * dir) * 8 + c] && !capturesOnly) out.push({ from: sq, to: (r + 2 * dir) * 8 + c, flag: "double" });
          }
          for (const dc of [-1, 1]) {
            const cc = c + dc; if (cc < 0 || cc > 7) continue;
            const to = r1 * 8 + cc;
            if (b[to] && sideOf(b[to]) === them) push(to, true);
            else if (to === s.ep) out.push({ from: sq, to, flag: "ep" });
          }
        }
      } else if (t === "n" || t === "k") {
        for (const [dr, dc] of (t === "n" ? N_OFF : K_OFF)) {
          const rr = r + dr, cc = c + dc; if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
          const to = rr * 8 + cc; if (b[to] && sideOf(b[to]) === turn) continue;
          add(sq, to);
        }
        if (t === "k" && !capturesOnly) {
          if (W && sq === 60) {
            if (s.castle.K && !b[61] && !b[62] && b[63] === "R" && !attacked(b, 60, "b") && !attacked(b, 61, "b") && !attacked(b, 62, "b")) out.push({ from: 60, to: 62, flag: "castle" });
            if (s.castle.Q && !b[59] && !b[58] && !b[57] && b[56] === "R" && !attacked(b, 60, "b") && !attacked(b, 59, "b") && !attacked(b, 58, "b")) out.push({ from: 60, to: 58, flag: "castle" });
          } else if (!W && sq === 4) {
            if (s.castle.k && !b[5] && !b[6] && b[7] === "r" && !attacked(b, 4, "w") && !attacked(b, 5, "w") && !attacked(b, 6, "w")) out.push({ from: 4, to: 6, flag: "castle" });
            if (s.castle.q && !b[3] && !b[2] && !b[1] && b[0] === "r" && !attacked(b, 4, "w") && !attacked(b, 3, "w") && !attacked(b, 2, "w")) out.push({ from: 4, to: 2, flag: "castle" });
          }
        }
      } else {
        const dirs = t === "b" ? DIAG : t === "r" ? ORTH : DIAG.concat(ORTH);
        for (const [dr, dc] of dirs) {
          let rr = r + dr, cc = c + dc;
          while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
            const to = rr * 8 + cc, q = b[to];
            if (q) { if (sideOf(q) !== turn) add(sq, to); break; }
            add(sq, to); rr += dr; cc += dc;
          }
        }
      }
    }
    return out;
  }

  function makeMove(s, m) {
    const b = s.b.slice();
    const p = b[m.from], W = isW(p), captured = b[m.to];
    b[m.to] = m.promo ? (W ? m.promo.toUpperCase() : m.promo) : p;
    b[m.from] = null;
    if (m.flag === "ep") b[(m.from & ~7) + (m.to & 7)] = null;
    if (m.flag === "castle") {
      if (m.to === 62) { b[61] = b[63]; b[63] = null; }
      else if (m.to === 58) { b[59] = b[56]; b[56] = null; }
      else if (m.to === 6) { b[5] = b[7]; b[7] = null; }
      else if (m.to === 2) { b[3] = b[0]; b[0] = null; }
    }
    const castle = { ...s.castle };
    if (p === "K") castle.K = castle.Q = false;
    if (p === "k") castle.k = castle.q = false;
    for (const sq of [m.from, m.to]) {
      if (sq === 63) castle.K = false; if (sq === 56) castle.Q = false;
      if (sq === 7) castle.k = false; if (sq === 0) castle.q = false;
    }
    const isPawn = p === "P" || p === "p";
    return {
      b, castle, turn: W ? "b" : "w",
      ep: m.flag === "double" ? (m.from + m.to) >> 1 : -1,
      half: isPawn || captured || m.flag === "ep" ? 0 : s.half + 1,
      full: W ? s.full : s.full + 1,
    };
  }
  function legalMoves(s, capturesOnly = false) {
    const me = s.turn, them = me === "w" ? "b" : "w";
    return pseudoMoves(s, capturesOnly).filter(m => { const n = makeMove(s, m); return !attacked(n.b, kingSq(n.b, me), them); });
  }
  function posKey(s) {
    return s.b.map(p => p || ".").join("") + s.turn + (s.castle.K ? "K" : "") + (s.castle.Q ? "Q" : "") + (s.castle.k ? "k" : "") + (s.castle.q ? "q" : "") + s.ep;
  }
  function insufficient(b) {
    const rest = b.filter(p => p && p !== "K" && p !== "k");
    return rest.length === 0 || (rest.length === 1 && "NBnb".includes(rest[0]));
  }
  const sqName = sq => "abcdefgh"[sq & 7] + (8 - (sq >> 3));
  function toSAN(s, m, legal) {
    const p = s.b[m.from], t = p.toUpperCase();
    let san;
    if (m.flag === "castle") san = (m.to & 7) === 6 ? "O-O" : "O-O-O";
    else {
      const cap = !!s.b[m.to] || m.flag === "ep";
      if (t === "P") san = (cap ? "abcdefgh"[m.from & 7] + "x" : "") + sqName(m.to) + (m.promo ? "=" + m.promo.toUpperCase() : "");
      else {
        const others = (legal || legalMoves(s)).filter(o => o.to === m.to && o.from !== m.from && s.b[o.from] === p);
        let dis = "";
        if (others.length) {
          if (!others.some(o => (o.from & 7) === (m.from & 7))) dis = "abcdefgh"[m.from & 7];
          else if (!others.some(o => (o.from >> 3) === (m.from >> 3))) dis = String(8 - (m.from >> 3));
          else dis = sqName(m.from);
        }
        san = t + dis + (cap ? "x" : "") + sqName(m.to);
      }
    }
    const n = makeMove(s, m);
    if (inCheck(n)) san += legalMoves(n).length ? "+" : "#";
    return san;
  }

  // ---------- evaluation ----------
  const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  const PST = {
    p: [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5, 0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0],
    n: [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30, -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
    b: [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10, -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
    r: [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
    q: [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5, 0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
    k: [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10, 20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20],
    ke: [-50,-40,-30,-20,-20,-30,-40,-50, -30,-20,-10,0,0,-10,-20,-30, -30,-10,20,30,30,20,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,20,30,30,20,-10,-30, -30,-30,0,0,0,0,-30,-30, -50,-30,-30,-30,-30,-30,-30,-50],
  };
  function evaluate(s) {
    const b = s.b; let score = 0, nonPawn = 0, wb = 0, bb = 0;
    for (let i = 0; i < 64; i++) { const p = b[i]; if (p && "qrbnQRBN".includes(p)) nonPawn += VAL[p.toLowerCase()]; }
    const endgame = nonPawn <= 1600;
    for (let i = 0; i < 64; i++) {
      const p = b[i]; if (!p) continue;
      const t = p.toLowerCase(), W = isW(p);
      if (p === "B") wb++; if (p === "b") bb++;
      const idx = W ? i : (7 - (i >> 3)) * 8 + (i & 7);
      const v = VAL[t] + (t === "k" && endgame ? PST.ke : PST[t])[idx];
      score += W ? v : -v;
    }
    if (wb >= 2) score += 30; if (bb >= 2) score -= 30;
    return s.turn === "w" ? score : -score;
  }

  // ---------- search: iterative deepening alpha-beta with a time limit ----------
  const MATE = 100000, TIMEOUT = { t: 1 };
  let deadline = Infinity, nodeCount = 0, canAbort = false;
  function tick() { if (canAbort && (++nodeCount & 511) === 0 && performance.now() > deadline) throw TIMEOUT; }
  function orderMoves(s, moves) {
    for (const m of moves) {
      const v = s.b[m.to];
      m.o = (v ? 10 * VAL[v.toLowerCase()] - VAL[s.b[m.from].toLowerCase()] / 10 + 1000 : 0) + (m.promo === "q" ? 900 : 0);
    }
    return moves.sort((a, c) => c.o - a.o);
  }
  function quiesce(s, alpha, beta, depth) {
    tick();
    const stand = evaluate(s);
    if (stand >= beta) return beta;
    if (alpha < stand) alpha = stand;
    if (depth === 0) return alpha;
    for (const m of orderMoves(s, legalMoves(s, true))) {
      const sc = -quiesce(makeMove(s, m), -beta, -alpha, depth - 1);
      if (sc >= beta) return beta;
      if (sc > alpha) alpha = sc;
    }
    return alpha;
  }
  function negamax(s, depth, alpha, beta, ply, qd) {
    tick();
    const moves = legalMoves(s);
    if (!moves.length) return inCheck(s) ? -MATE + ply : 0;
    if (s.half >= 100 || insufficient(s.b)) return 0;
    if (depth === 0) return qd ? quiesce(s, alpha, beta, qd) : evaluate(s);
    for (const m of orderMoves(s, moves)) {
      const sc = -negamax(makeMove(s, m), depth - 1, -beta, -alpha, ply + 1, qd);
      if (sc >= beta) return beta;
      if (sc > alpha) alpha = sc;
    }
    return alpha;
  }
  // opts: { maxDepth, qd, noise, blunder, timeMs, avoid: [posKeys already played] }
  function search(s, o) {
    let moves = orderMoves(s, legalMoves(s));
    if (o.exclude) moves = moves.filter(m => !o.exclude.some(x => x[0] === m.from && x[1] === m.to && (x[2] || "") === (m.promo || "")));
    if (!moves.length) return null;
    const pack = (m, score, depth) => ({ from: m.from, to: m.to, promo: m.promo, flag: m.flag, score, depth });
    if (o.blunder && Math.random() < o.blunder) return pack(moves[(Math.random() * moves.length) | 0], 0, 0);
    deadline = performance.now() + (o.timeMs || 1000); nodeCount = 0; canAbort = false;
    const avoid = new Set(o.avoid || []), noise = o.noise || 0;
    let best = moves[0], bestScore = 0, done = 0;
    for (let d = 1; d <= (o.maxDepth || 3); d++) {
      let iterBest = null, iterScore = -Infinity;
      try {
        for (const m of moves) {
          const n = makeMove(s, m);
          let sc = avoid.has(posKey(n)) ? 0 : -negamax(n, d - 1, -Infinity, -iterScore + noise, 1, o.qd || 0);
          if (noise) sc += (Math.random() - 0.5) * noise;
          m.s = sc;
          if (sc > iterScore) { iterScore = sc; iterBest = m; }
        }
      } catch (e) {
        if (e !== TIMEOUT) throw e;
        if (iterBest && iterScore > bestScore) { best = iterBest; bestScore = iterScore; }
        break;
      }
      best = iterBest; bestScore = iterScore; done = d;
      canAbort = true; // depth 1 always finishes; deeper ones may be cut off by the clock
      moves.sort((a, c) => c.s - a.s);
      if (Math.abs(bestScore) > MATE - 1000) break;
      if (performance.now() > deadline) break;
    }
    canAbort = false;
    return pack(best, bestScore, done);
  }

  return { attacked, minAttacker, startState, fromFEN, legalMoves, makeMove, inCheck, kingSq, posKey, insufficient, toSAN, sqName, evaluate, search, VAL, MATE, isW, sideOf };
}
const E = engineFactory();

/* ---------------- database (Upstash Redis REST) ---------------- */
const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
async function r(...cmd) {
  const res = await fetch(DB_URL, { method: "POST", headers: { Authorization: `Bearer ${DB_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd.map(String)) });
  const j = await res.json();
  if (j.error) throw new Error("db: " + j.error);
  return j.result;
}
const getJ = async k => { const v = await r("GET", k); return v ? JSON.parse(v) : null; };
const setJ = (k, v, ...opt) => r("SET", k, JSON.stringify(v), ...opt);
const mgetJ = async keys => (keys.length ? (await r("MGET", ...keys)).map(v => (v ? JSON.parse(v) : null)) : []);

/* ---------------- helpers ---------------- */
const fail = (code, msg) => { const e = new Error(msg); e.code = code; e.userMsg = msg; throw e; };
const hash = t => crypto.createHash("sha256").update(String(t)).digest("hex");
const MAX_ELO = 4500, MIN_ELO = 100, START_ELO = 100;
const TC = { bullet: { name: "bullet", base: 60000, inc: 0 }, blitz: { name: "blitz", base: 180000, inc: 2000 }, rapid: { name: "rapid", base: 600000, inc: 0 } };
const pub = u => ({ name: u.name, key: u.key, elo: u.elo, w: u.w, l: u.l, d: u.d, created: u.created, online: Date.now() - (u.seen || 0) < 60000 });
const keyOf = n => String(n || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 16);

// Name filter (bad words / slurs). The list is base64 so it isn't sitting in plain view.
const BAD = JSON.parse(Buffer.from("eyJzdWIiOiBbImZ1Y2siLCAic2hpdCIsICJiaXRjaCIsICJjdW50IiwgIm5pZ2ciLCAiZmFnZ290IiwgInJldGFyZCIsICJ3aG9yZSIsICJzbHV0IiwgImRpY2siLCAicHVzc3kiLCAicGVuaXMiLCAidmFnaW5hIiwgInBvcm4iLCAibmF6aSIsICJoaXRsZXIiLCAiY2hpbmsiLCAid2V0YmFjayIsICJ0cmFubnkiLCAiYmVhbmVyIiwgInR3YXQiLCAid2FuayIsICJiYXN0YXJkIiwgImFzc2hvbGUiLCAiZG91Y2hlIiwgIm1vdGhlcmYiLCAiaml6eiIsICJib29iIiwgInRpdHMiLCAicGVkb3BoaWxlIiwgIm1vbGVzdCIsICJra2siLCAic3VpY2lkZSIsICJraWxseW91cnNlbGYiLCAicmFwaXN0IiwgImRpbGRvIiwgImhvcm55IiwgIm51ZGVzIl0sICJ0b2siOiBbImFzcyIsICJhcnNlIiwgImZhZyIsICJmYWdzIiwgInNleCIsICJzZXh5IiwgImN1bSIsICJ0aXQiLCAiY29vbiIsICJwYWtpIiwgImt5cyIsICJjb2NrIiwgInJhcGUiLCAia2lrZSIsICJzcGljIiwgImdvb2siLCAiZHlrZSIsICJwZWRvIiwgIm5lZ3JvIiwgImhvbW8iLCAibnVkZSIsICJwb3JubyIsICJtaWxmIl19", "base64").toString());
function isBadName(name) {
  const map = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", 9: "g", "@": "a", $: "s", "!": "i", "|": "i" };
  const raw = String(name).toLowerCase(), leet = raw.replace(/[0-9@$!|]/g, c => map[c] || c);
  const squash = t => t.replace(/[^a-z]/g, "").replace(/(.)\1+/g, "$1");
  const whole = squash(leet), wholeRaw = leet.replace(/[^a-z]/g, "");
  if (BAD.sub.some(w => wholeRaw.includes(w) || (squash(w) === w && w.length >= 4 && whole.includes(w)))) return true;
  const toks = [...raw.split(/[^a-z]+/), ...leet.split(/[^a-z]+/)].filter(Boolean);
  return toks.some(t => BAD.tok.includes(t) || BAD.tok.includes(squash(t)));
}

// Replace bad words in a chat message with stars.
function censorText(t) {
  return t.split(/(\s+)/).map(w => (/^\s*$/.test(w) || !isBadName(w.replace(/[^A-Za-z0-9_@$!|]/g, "")) ? w : "*".repeat(Math.min(Math.max(w.length, 3), 8)))).join("");
}
const POLICIES = ["friends", "everyone", "nobody"];
async function blockedEither(a, b) { return (await r("SISMEMBER", "blk:" + a, b)) || (await r("SISMEMBER", "blk:" + b, a)); }
async function canMessage(me, other) {
  if (me.key === other.key) return false;
  if (await blockedEither(me.key, other.key)) return false;
  const pol = other.msgPolicy || "friends";
  if (pol === "nobody") return false;
  if (pol === "friends") {
    if (await r("SISMEMBER", "fr:" + other.key, me.key)) return true;
    // you can always reply in a conversation the other person started
    const om = (await getJ("dmmeta:" + other.key)) || {};
    return !!(om[me.key] && om[me.key].by === other.key);
  }
  return true;
}
const convoKey = (a, b) => "dm:" + [a, b].sort().join("|");

async function auth(b) {
  if (!b.token || String(b.token).length < 16) fail("no_user", "Please make a user first.");
  const key = await r("GET", "dev:" + hash(b.token));
  if (!key) fail("no_user", "Please make a user first.");
  const u = await getJ("u:" + key);
  if (!u) fail("no_user", "Please make a user first.");
  return u;
}
async function touch(u) { u.seen = Date.now(); await setJ("u:" + u.key, u); }

function replay(g) {
  let s = E.startState(); const keys = [E.posKey(s)];
  for (const [f, t, p] of g.moves) {
    const m = E.legalMoves(s).find(x => x.from === f && x.to === t && (x.promo || "") === (p || ""));
    if (!m) break;
    s = E.makeMove(s, m); keys.push(E.posKey(s));
  }
  return { s, keys };
}
const view = g => ({ ...g, serverNow: Date.now() });

async function finish(g, result, reason) {
  g.status = "over"; g.result = result; g.reason = reason; g.endedAt = Date.now();
  if (reason !== "aborted") {
    const [W, B] = await mgetJ(["u:" + g.white, "u:" + g.black]);
    if (W && B) {
      const sw = result === "1-0" ? 1 : result === "0-1" ? 0 : 0.5;
      const ew = 1 / (1 + Math.pow(10, (B.elo - W.elo) / 400)), K = 32;
      const dW = Math.round(K * (sw - ew)), dB = -dW;
      const clamp = x => Math.max(MIN_ELO, Math.min(MAX_ELO, x));
      const nW = clamp(W.elo + dW), nB = clamp(B.elo + dB);
      g.eloChange = { w: nW - W.elo, b: nB - B.elo }; g.eloAfter = { w: nW, b: nB };
      W.elo = nW; B.elo = nB;
      if (sw === 1) { W.w++; B.l++; } else if (sw === 0) { W.l++; B.w++; } else { W.d++; B.d++; }
      await setJ("u:" + W.key, W); await setJ("u:" + B.key, B);
      await r("ZADD", "lb", W.elo, W.key); await r("ZADD", "lb", B.elo, B.key);
    }
  }
  await r("DEL", "active:" + g.white); await r("DEL", "active:" + g.black);
}

/* ---------------- actions ---------------- */
const A = {
  async signup(b, req) {
    const name = String(b.name || "").trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) fail("bad_name", "Use 3–16 letters, numbers or _ (no spaces).");
    if (isBadName(name)) fail("censored", "That name is censored. Try a friendly one!");
    if (!b.token || String(b.token).length < 16) fail("no_user", "Something went wrong. Reload and try again.");
    const dk = "dev:" + hash(b.token);
    if (await r("GET", dk)) fail("one_user", "You already have a user on this device. Only 1 user is allowed.");
    const ip = String((req.headers["x-forwarded-for"] || "").split(",")[0]).trim() || "local";
    const ipk = "ipsign:" + hash(ip), n = await r("INCR", ipk);
    if (n === 1) await r("EXPIRE", ipk, 86400);
    if (n > 3) fail("too_many", "Too many new users from here today. Try again tomorrow.");
    const key = name.toLowerCase(), now = Date.now();
    const u = { name, key, elo: START_ELO, w: 0, l: 0, d: 0, created: now, seen: now };
    if (!(await r("SET", "u:" + key, JSON.stringify(u), "NX"))) fail("taken", "That name is already taken. Try another one!");
    if (!(await r("SET", dk, key, "NX"))) { await r("DEL", "u:" + key); fail("one_user", "You already have a user on this device. Only 1 user is allowed."); }
    await r("ZADD", "lb", START_ELO, key);
    return { me: pub(u) };
  },
  async me(b) { const u = await auth(b); await touch(u); return { me: { ...pub(u), msgPolicy: u.msgPolicy || "friends" }, rank: (await r("ZREVRANK", "lb", u.key)) + 1 }; },
  async setPrefs(b) {
    const u = await auth(b);
    if (POLICIES.includes(b.msgPolicy)) u.msgPolicy = b.msgPolicy;
    await setJ("u:" + u.key, u);
    return { me: { ...pub(u), msgPolicy: u.msgPolicy || "friends" } };
  },
  // Everyone, best to worst, 50 at a time.
  async leaderboard(b) {
    const off = Math.max(0, Math.floor(+b.offset || 0));
    const keys = await r("ZREVRANGE", "lb", off, off + 49);
    const users = (await mgetJ(keys.map(k => "u:" + k))).filter(Boolean).map(pub);
    return { list: users, offset: off, total: await r("ZCARD", "lb") };
  },
  async search(b) {
    const q = keyOf(b.q); if (!q) return { list: [] };
    let cursor = "0", found = [];
    for (let i = 0; i < 10 && found.length < 20; i++) {
      const [next, items] = await r("ZSCAN", "lb", cursor, "MATCH", `*${q}*`, "COUNT", 500);
      for (let k = 0; k < items.length; k += 2) found.push(items[k]);
      cursor = next; if (cursor === "0") break;
    }
    found = found.slice(0, 20);
    const users = (await mgetJ(found.map(k => "u:" + k))).filter(Boolean).map(pub).sort((a, c) => c.elo - a.elo);
    return { list: users };
  },
  async profile(b) {
    const key = keyOf(b.name), u = await getJ("u:" + key);
    if (!u) fail("not_found", "That user doesn't exist.");
    let rel = "none", canMsg = false, blocked = false;
    try {
      const me = await auth(b);
      canMsg = await canMessage(me, u);
      blocked = !!(await r("SISMEMBER", "blk:" + me.key, key));
      if (me.key === key) rel = "self";
      else if (await r("SISMEMBER", "fr:" + me.key, key)) rel = "friends";
      else if (await r("SISMEMBER", "freq:" + key, me.key)) rel = "sent";
      else if (await r("SISMEMBER", "freq:" + me.key, key)) rel = "received";
    } catch (e) {}
    return { user: pub(u), rel, canMsg, blocked, msgPolicy: u.msgPolicy || "friends", rank: (await r("ZREVRANK", "lb", key)) + 1 };
  },
  async friendReq(b) {
    const me = await auth(b), to = keyOf(b.to);
    if (to === me.key) fail("self", "That's you!");
    if (!(await r("EXISTS", "u:" + to))) fail("not_found", "That user doesn't exist.");
    if (await blockedEither(me.key, to)) fail("blocked", "You can't send a request to this user.");
    if (await r("SISMEMBER", "fr:" + me.key, to)) return { rel: "friends" };
    if (await r("SISMEMBER", "freq:" + me.key, to)) { await A.friendAccept({ ...b, from: to }); return { rel: "friends" }; }
    if ((await r("SCARD", "freq:" + to)) >= 100) fail("full", "They have too many friend requests right now.");
    await r("SADD", "freq:" + to, me.key);
    return { rel: "sent" };
  },
  async friendAccept(b) {
    const me = await auth(b), from = keyOf(b.from);
    if (!(await r("SREM", "freq:" + me.key, from))) fail("gone", "That request is gone.");
    await r("SADD", "fr:" + me.key, from); await r("SADD", "fr:" + from, me.key);
    return { rel: "friends" };
  },
  async friendDecline(b) { const me = await auth(b); await r("SREM", "freq:" + me.key, keyOf(b.from)); return {}; },
  async unfriend(b) { const me = await auth(b), k = keyOf(b.name); await r("SREM", "fr:" + me.key, k); await r("SREM", "fr:" + k, me.key); return { rel: "none" }; },
  async friends(b) {
    const me = await auth(b);
    const keys = await r("SMEMBERS", "fr:" + me.key);
    const list = (await mgetJ(keys.map(k => "u:" + k))).filter(Boolean).map(pub).sort((a, c) => c.online - a.online || c.elo - a.elo);
    return { list };
  },
  async challenge(b) {
    const me = await auth(b), to = keyOf(b.to), tc = TC[b.tc];
    if (!tc) fail("bad_tc", "Pick Bullet, Blitz or Rapid.");
    if (!(await r("SISMEMBER", "fr:" + me.key, to))) fail("not_friends", "You can only challenge your friends.");
    if (await blockedEither(me.key, to)) fail("blocked", "You can't challenge this user.");
    if ((await r("SCARD", "chin:" + to)) >= 20) fail("full", "They have too many challenges right now.");
    const id = crypto.randomBytes(8).toString("hex");
    await setJ("ch:" + id, { id, from: me.key, fromName: me.name, fromElo: me.elo, to, tc: tc.name, created: Date.now() }, "EX", 600);
    await r("SADD", "chin:" + to, id);
    return { id };
  },
  async inbox(b) {
    const me = await auth(b); await touch(me);
    const reqKeys = await r("SMEMBERS", "freq:" + me.key);
    const reqUsers = (await mgetJ(reqKeys.map(k => "u:" + k))).filter(Boolean).map(pub);
    const ids = await r("SMEMBERS", "chin:" + me.key);
    const chs = await mgetJ(ids.map(i => "ch:" + i));
    const challenges = [];
    for (let i = 0; i < ids.length; i++) { if (chs[i]) challenges.push(chs[i]); else await r("SREM", "chin:" + me.key, ids[i]); }
    const started = await r("SMEMBERS", "started:" + me.key);
    if (started.length) await r("DEL", "started:" + me.key);
    const active = await r("GET", "active:" + me.key);
    const meta = (await getJ("dmmeta:" + me.key)) || {};
    const unreadMsgs = Object.values(meta).reduce((n, c) => n + (c.unread || 0), 0);
    return { me: { ...pub(me), msgPolicy: me.msgPolicy || "friends" }, friendRequests: reqUsers, challenges, started, active, unreadMsgs };
  },
  // ---- messages ----
  async sendMsg(b) {
    const me = await auth(b), to = keyOf(b.to), other = await getJ("u:" + to);
    if (!other) fail("not_found", "That user doesn't exist.");
    if (!(await canMessage(me, other))) fail("no_msgs", `${other.name} isn't taking messages from you.`);
    let text = String(b.text || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!text) fail("empty", "Write something first.");
    if (!(await r("SET", "rl:" + me.key, "1", "NX", "EX", 2))) fail("slow", "Slow down a little!");
    text = censorText(text);
    const now = Date.now(), msg = { f: me.key, t: text, at: now };
    const ck = convoKey(me.key, to), list = (await getJ(ck)) || [];
    list.push(msg); if (list.length > 100) list.splice(0, list.length - 100);
    await setJ(ck, list, "EX", 2592000);
    const mt = (await getJ("dmmeta:" + to)) || {}, mm = (await getJ("dmmeta:" + me.key)) || {};
    const by = (mm[to] && mm[to].by) || (mt[me.key] && mt[me.key].by) || me.key;   // who started the conversation
    mt[me.key] = { name: me.name, last: now, text, by, unread: ((mt[me.key] && mt[me.key].unread) || 0) + 1 };
    mm[to] = { name: other.name, last: now, text, by, unread: (mm[to] && mm[to].unread) || 0 };
    await setJ("dmmeta:" + to, mt); await setJ("dmmeta:" + me.key, mm);
    return { msg };
  },
  async messages(b) {
    const me = await auth(b), other = keyOf(b.with), u = await getJ("u:" + other);
    if (!u) fail("not_found", "That user doesn't exist.");
    const list = ((await getJ(convoKey(me.key, other))) || []).slice(-60);
    const mm = (await getJ("dmmeta:" + me.key)) || {};
    if (mm[other] && mm[other].unread) { mm[other].unread = 0; await setJ("dmmeta:" + me.key, mm); }
    return { list, other: pub(u), canMsg: await canMessage(me, u) };
  },
  async convos(b) {
    const me = await auth(b), mm = (await getJ("dmmeta:" + me.key)) || {};
    const keys = Object.keys(mm).sort((a, c) => mm[c].last - mm[a].last).slice(0, 50);
    const users = await mgetJ(keys.map(k => "u:" + k));
    return { list: keys.map((k, i) => users[i] && { ...pub(users[i]), last: mm[k].last, text: mm[k].text, unread: mm[k].unread || 0 }).filter(Boolean) };
  },
  async block(b) {
    const me = await auth(b), k = keyOf(b.name);
    if (k === me.key) fail("self", "That's you!");
    await r("SADD", "blk:" + me.key, k);
    await r("SREM", "fr:" + me.key, k); await r("SREM", "fr:" + k, me.key);
    await r("SREM", "freq:" + me.key, k); await r("SREM", "freq:" + k, me.key);
    return { blocked: true };
  },
  async unblock(b) { const me = await auth(b); await r("SREM", "blk:" + me.key, keyOf(b.name)); return { blocked: false };
  },
  async accept(b) {
    const me = await auth(b), ch = await getJ("ch:" + String(b.id));
    if (!ch || ch.to !== me.key) fail("gone", "That challenge has expired.");
    await r("DEL", "ch:" + ch.id); await r("SREM", "chin:" + me.key, ch.id);
    const from = await getJ("u:" + ch.from);
    if (!from) fail("gone", "That player is gone.");
    const tc = TC[ch.tc], swap = Math.random() < 0.5;
    const W = swap ? me : from, B = swap ? from : me, now = Date.now();
    const g = {
      id: crypto.randomBytes(8).toString("hex"), white: W.key, black: B.key, whiteName: W.name, blackName: B.name,
      whiteElo: W.elo, blackElo: B.elo, tc, moves: [], clocks: { w: tc.base, b: tc.base }, lastAt: now, created: now, status: "active",
    };
    await setJ("g:" + g.id, g, "EX", 172800);
    await r("SET", "active:" + W.key, g.id, "EX", 172800); await r("SET", "active:" + B.key, g.id, "EX", 172800);
    await r("SADD", "started:" + ch.from, g.id); await r("EXPIRE", "started:" + ch.from, 900);
    return { game: view(g) };
  },
  async decline(b) {
    const me = await auth(b), ch = await getJ("ch:" + String(b.id));
    if (ch && ch.to === me.key) await r("DEL", "ch:" + ch.id);
    await r("SREM", "chin:" + me.key, String(b.id));
    return {};
  },
  async game(b) {
    const g = await getJ("g:" + String(b.id));
    if (!g) fail("gone", "That game is gone.");
    return { game: view(g) };
  },
  async move(b) {
    const me = await auth(b), g = await getJ("g:" + String(b.id));
    if (!g) fail("gone", "That game is gone.");
    if (g.status !== "active") return { game: view(g) };
    const color = me.key === g.white ? "w" : me.key === g.black ? "b" : null;
    if (!color) fail("not_player", "You're not in this game.");
    const { s, keys } = replay(g);
    if (s.turn !== color || Number(b.ply) !== g.moves.length) return { game: view(g) };
    const m = E.legalMoves(s).find(x => x.from === +b.from && x.to === +b.to && (x.promo || "") === (b.promo || ""));
    if (!m) return { game: view(g) };
    const now = Date.now();
    if (g.moves.length >= 2) {
      g.clocks[color] -= now - g.lastAt;
      if (g.clocks[color] <= 0) { g.clocks[color] = 0; await timeout(g, s, color); await setJ("g:" + g.id, g, "EX", 172800); return { game: view(g) }; }
    }
    if (g.moves.length >= 1) g.clocks[color] += g.tc.inc;
    if (g.drawOffer && g.drawOffer.by !== color) { g.drawOffer = null; g.drawDecl = { by: color, n: ((g.drawDecl && g.drawDecl.n) || 0) + 1 }; }   // moving = saying no
    g.moves.push([m.from, m.to, m.promo || ""]); g.lastAt = now;
    const n = E.makeMove(s, m), k = E.posKey(n);
    if (!E.legalMoves(n).length) await finish(g, E.inCheck(n) ? (color === "w" ? "1-0" : "0-1") : "1/2-1/2", E.inCheck(n) ? "checkmate" : "stalemate");
    else if (n.half >= 100) await finish(g, "1/2-1/2", "fifty");
    else if (E.insufficient(n.b)) await finish(g, "1/2-1/2", "material");
    else if (keys.filter(x => x === k).length >= 2) await finish(g, "1/2-1/2", "repetition");
    await setJ("g:" + g.id, g, "EX", 172800);
    return { game: view(g) };
  },
  async resign(b) {
    const me = await auth(b), g = await getJ("g:" + String(b.id));
    if (!g) fail("gone", "That game is gone.");
    if (g.status === "active") {
      const color = me.key === g.white ? "w" : me.key === g.black ? "b" : null;
      if (!color) fail("not_player", "You're not in this game.");
      await finish(g, g.moves.length < 2 ? "*" : color === "w" ? "0-1" : "1-0", g.moves.length < 2 ? "aborted" : "resign");
      await setJ("g:" + g.id, g, "EX", 172800);
    }
    return { game: view(g) };
  },
  // Draw offers: op "offer" | "accept" | "decline". The other player sees g.drawOffer and answers.
  async draw(b) {
    const me = await auth(b), g = await getJ("g:" + String(b.id));
    if (!g) fail("gone", "That game is gone.");
    if (g.status !== "active") return { game: view(g) };
    const color = me.key === g.white ? "w" : me.key === g.black ? "b" : null;
    if (!color) fail("not_player", "You're not in this game.");
    const op = String(b.op || "");
    const theirs = g.drawOffer && g.drawOffer.by !== color;
    if (op === "offer" && !theirs) {
      if (g.drawOffer) return { game: view(g) };   // already waiting for an answer
      if (g.moves.length < 2) fail("too_early", "Make a move first before offering a draw.");
      const last = (g.drawLast || {})[color];
      if (last != null && g.moves.length - last < 4) fail("too_soon", "You just offered a draw. Try again in a few moves.");
      g.drawLast = { ...(g.drawLast || {}), [color]: g.moves.length };
      g.drawOffer = { by: color, ply: g.moves.length, at: Date.now() };
    } else if ((op === "accept" || op === "offer") && theirs) {
      g.drawOffer = null; await finish(g, "1/2-1/2", "agreement");
    } else if (op === "decline" && theirs) {
      g.drawOffer = null; g.drawDecl = { by: color, n: ((g.drawDecl && g.drawDecl.n) || 0) + 1 };
    } else return { game: view(g) };
    await setJ("g:" + g.id, g, "EX", 172800);
    return { game: view(g) };
  },
  async flag(b) {
    const g = await getJ("g:" + String(b.id));
    if (!g) fail("gone", "That game is gone.");
    if (g.status !== "active") return { game: view(g) };
    const now = Date.now(), { s } = replay(g), turn = s.turn;
    if (g.moves.length < 2) {
      if (now - g.lastAt > 60000) { await finish(g, "*", "aborted"); await setJ("g:" + g.id, g, "EX", 172800); }
    } else if (g.clocks[turn] - (now - g.lastAt) <= 0) {
      g.clocks[turn] = 0; await timeout(g, s, turn); await setJ("g:" + g.id, g, "EX", 172800);
    }
    return { game: view(g) };
  },
};
async function timeout(g, s, loser) {
  const winner = loser === "w" ? "b" : "w";
  const wp = s.b.filter(p => p && E.sideOf(p) === winner && p.toLowerCase() !== "k");
  const cantWin = wp.length === 0 || (wp.length === 1 && "nb".includes(wp[0].toLowerCase()));
  await finish(g, cantWin ? "1/2-1/2" : winner === "w" ? "1-0" : "0-1", "timeout");
}

module.exports = async function handler(req, res) {
  const send = (code, obj) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(obj)); };
  if (req.method !== "POST") return send(405, { ok: false, code: "method", msg: "Use POST." });
  if (!DB_URL || !DB_TOKEN) return send(200, { ok: false, code: "not_configured", msg: "Online play isn't switched on yet." });
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const fn = Object.prototype.hasOwnProperty.call(A, b.a) ? A[b.a] : null;
  if (!fn) return send(400, { ok: false, code: "bad_action", msg: "Unknown action." });
  try { send(200, { ok: true, ...(await fn(b, req)) }); }
  catch (e) {
    if (e.userMsg) send(200, { ok: false, code: e.code, msg: e.userMsg });
    else { console.error(e); send(500, { ok: false, code: "server", msg: "Server error. Try again." }); }
  }
};

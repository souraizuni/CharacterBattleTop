/* =====================================================================
 *  姓名戰鬥陀螺  Chinese Character Battle Top
 *  Battle behavior aligned to the remixed reference.
 * ===================================================================== */
'use strict';

/* ===================== 物理常數 ===================== */
const ARENA_R = 250;
const ARENA_INNER = 246;
const TOP_TARGET = 72;
const TILE = 15;
const MASTER = 300;
const SUBSTEPS = 2;

const LINDAMP = 0.995;
const SPINFRIC = 0.99996;
const REST = 0.62;
const MU = 0.18;
const AV_MAX = 0.72;
const V_MAX = 15;
const AV_DEAD = 0.05;
const VN_HARD = 1.5;
const TOUGH = 4.9;
const THK0 = 0.3;
const THKK = 1.4;
const BOWL = 0.00018;
const INWARD = 0.005;
const IBOOST = 3.4;
const GYRO_CURVE = 0.05;
const K_WOBBLE = 0.46;
const K_IMBDRAIN = 0.016;
const SETTLE_SPIN = 0.12;
const DEBRIS_DAMP = 0.88;
const CRIT_CHANCE = 0.18;
const CRIT_MULT = 2.3;
const VIEW_KY = 0.78;
const VIEW_KZ = 0.92;
const THICK = 9;
const MAXLEAN = 1.45;

const GLYPH_FONT_SIZE = 210;
const GLYPH_FONT = '"BiauKai","DFKai-SB","Noto Serif TC","Microsoft JhengHei",serif';
const TEAM_RED = '#d6433a';
const TEAM_BLUE = '#3f7fd6';
const HALL_GOLD = '#e0b84a';
const TOP_CACHE = new Map();
const SPAWN_DELAY_MS = 400;
const POST_DECISION_RENDER_MS = 1000;
const RESULT_OVERLAY_DELAY_MS = POST_DECISION_RENDER_MS;

/* ===================== 工具 ===================== */
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const rnd = (a, b) => a + Math.random() * (b - a);

function hexA(hex, alpha) {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${alpha})`;
}

function sideColor(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const lum = 0.3 * r + 0.59 * g + 0.11 * b;
  if (lum < 70) return 'rgb(120,112,100)';
  return `rgb(${Math.round(r * 0.48)},${Math.round(g * 0.48)},${Math.round(b * 0.48)})`;
}

/* ===================== 字形解析 ===================== */
function rasterMaster(text, color) {
  const cv = document.createElement('canvas');
  cv.width = MASTER;
  cv.height = MASTER;
  const g = cv.getContext('2d');
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `${GLYPH_FONT_SIZE}px ${GLYPH_FONT}`;
  g.fillText(text, MASTER / 2, MASTER / 2 + GLYPH_FONT_SIZE * 0.04);
  return cv;
}

function cloneTop(baseTop) {
  if (!baseTop) return null;
  return {
    ...baseTop,
    joints: baseTop.joints.map(joint => ({ ...joint }))
  };
}

function buildTop(text, color) {
  const cacheKey = `${text}::${color}`;
  const cached = TOP_CACHE.get(cacheKey);
  if (cached) return cloneTop(cached);

  const master = rasterMaster(text, color);
  const data = master.getContext('2d').getImageData(0, 0, MASTER, MASTER).data;
  const cols = Math.floor(MASTER / TILE);
  const rows = Math.floor(MASTER / TILE);
  const fill = [];
  let samples = 0;

  for (let r = 0; r < rows; r++) {
    fill[r] = [];
    for (let c = 0; c < cols; c++) {
      let n = 0;
      let t = 0;
      for (let yy = 2; yy < TILE; yy += 3) {
        for (let xx = 2; xx < TILE; xx += 3) {
          t++;
          const px = c * TILE + xx;
          const py = r * TILE + yy;
          if (data[(py * MASTER + px) * 4 + 3] > 60) n++;
        }
      }
      samples = t;
      fill[r][c] = n;
    }
  }

  const thresh = samples * 0.18;
  const solid = [];
  for (let r = 0; r < rows; r++) {
    solid[r] = [];
    for (let c = 0; c < cols; c++) solid[r][c] = fill[r][c] > thresh;
  }

  const dist = [];
  const queue = [];
  for (let r = 0; r < rows; r++) {
    dist[r] = [];
    for (let c = 0; c < cols; c++) {
      if (!solid[r][c]) {
        dist[r][c] = 0;
        queue.push([r, c]);
      } else if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) {
        dist[r][c] = 1;
        queue.push([r, c]);
      } else {
        dist[r][c] = Infinity;
      }
    }
  }

  let qh = 0;
  while (qh < queue.length) {
    const [r, c] = queue[qh++];
    const d = dist[r][c];
    for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      if (solid[nr][nc] && dist[nr][nc] > d + 1) {
        dist[nr][nc] = d + 1;
        queue.push([nr, nc]);
      }
    }
  }

  const nodes = [];
  const nodeAt = {};
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!solid[r][c]) continue;
      nodeAt[`${r}_${c}`] = nodes.length;
      nodes.push({
        tr: r,
        tc: c,
        mass: fill[r][c],
        lx: 0,
        ly: 0,
        comp: -1,
        thick: Math.min(6, dist[r][c] || 1)
      });
    }
  }
  if (!nodes.length) return null;

  let comp = 0;
  for (const seed of nodes) {
    if (seed.comp !== -1) continue;
    const stack = [seed];
    seed.comp = comp;
    while (stack.length) {
      const nd = stack.pop();
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const j = nodeAt[`${nd.tr + dr}_${nd.tc + dc}`];
          if (j != null && nodes[j].comp === -1) {
            nodes[j].comp = comp;
            stack.push(nodes[j]);
          }
        }
      }
    }
    comp++;
  }

  let M = 0;
  let cx = 0;
  let cy = 0;
  let mnx = 1e9;
  let mxx = -1e9;
  let mny = 1e9;
  let mxy = -1e9;
  for (const n of nodes) {
    const mx = n.tc * TILE + TILE / 2;
    const my = n.tr * TILE + TILE / 2;
    M += n.mass;
    cx += mx * n.mass;
    cy += my * n.mass;
    mnx = Math.min(mnx, mx);
    mxx = Math.max(mxx, mx);
    mny = Math.min(mny, my);
    mxy = Math.max(mxy, my);
  }
  cx /= M;
  cy /= M;
  const sc = TOP_TARGET / Math.max(mxx - mnx, mxy - mny, 1);
  for (const n of nodes) {
    n.lx = ((n.tc * TILE + TILE / 2) - cx) * sc;
    n.ly = ((n.tr * TILE + TILE / 2) - cy) * sc;
  }
  const tileDisp = TILE * sc;

  const joints = [];
  const jointKeys = new Set();
  const addJoint = (i, j, kind) => {
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    const key = `${a}_${b}`;
    if (jointKeys.has(key)) return;
    jointKeys.add(key);
    joints.push({ a, b, kind, broken: false });
  };

  for (const n of nodes) {
    const i = nodeAt[`${n.tr}_${n.tc}`];
    [[0, 1], [1, 0], [1, 1], [1, -1]].forEach(([dr, dc]) => {
      const j = nodeAt[`${n.tr + dr}_${n.tc + dc}`];
      if (j != null) addJoint(i, j, 'stroke');
    });
  }

  if (comp > 1) {
    const byComp = {};
    for (let k = 0; k < comp; k++) byComp[k] = [];
    nodes.forEach((n, i) => byComp[n.comp].push(i));
    const connected = new Set([0]);
    const remaining = new Set();
    for (let k = 1; k < comp; k++) remaining.add(k);
    while (remaining.size) {
      let best = null;
      let bestDist = 1e18;
      let bridgeComp = null;
      for (const from of remaining) {
        for (const to of connected) {
          const A = byComp[from];
          const B = byComp[to];
          for (let ai = 0; ai < A.length; ai++) {
            for (let bi = 0; bi < B.length; bi++) {
              const dx = nodes[A[ai]].lx - nodes[B[bi]].lx;
              const dy = nodes[A[ai]].ly - nodes[B[bi]].ly;
              const d = dx * dx + dy * dy;
              if (d < bestDist) {
                bestDist = d;
                best = [A[ai], B[bi]];
                bridgeComp = from;
              }
            }
          }
        }
      }
      if (!best) break;
      addJoint(best[0], best[1], 'support');
      connected.add(bridgeComp);
      remaining.delete(bridgeComp);
    }
  }

  const strokeJointIndicesByNode = Array.from({ length: nodes.length }, () => []);
  const supportJointIndicesByNode = Array.from({ length: nodes.length }, () => []);
  joints.forEach((joint, index) => {
    const bucket = joint.kind === 'stroke' ? strokeJointIndicesByNode : supportJointIndicesByNode;
    bucket[joint.a].push(index);
    bucket[joint.b].push(index);
  });

  const adj = {};
  for (let i = 0; i < nodes.length; i++) adj[i] = [];
  for (const joint of joints) {
    if (joint.kind !== 'stroke') continue;
    adj[joint.a].push(joint.b);
    adj[joint.b].push(joint.a);
  }

  let bmnx = 1e9;
  let bmxx = -1e9;
  let bmny = 1e9;
  let bmxy = -1e9;
  for (const n of nodes) {
    bmnx = Math.min(bmnx, n.lx);
    bmxx = Math.max(bmxx, n.lx);
    bmny = Math.min(bmny, n.ly);
    bmxy = Math.max(bmxy, n.ly);
  }
  const gcx = (bmnx + bmxx) / 2;
  const gcy = (bmny + bmxy) / 2;
  let centerNode = 0;
  let cbest = 1e18;
  for (let i = 0; i < nodes.length; i++) {
    const d = (nodes[i].lx - gcx) ** 2 + (nodes[i].ly - gcy) ** 2;
    if (d < cbest) {
      cbest = d;
      centerNode = i;
    }
  }

  const depth = new Array(nodes.length).fill(-1);
  const neckOf = new Array(nodes.length).fill(centerNode);
  const parent = new Array(nodes.length).fill(-1);
  depth[centerNode] = 0;
  const bfs = [centerNode];
  let bh = 0;
  while (bh < bfs.length) {
    const u = bfs[bh++];
    for (const v of adj[u]) {
      if (depth[v] !== -1) continue;
      depth[v] = depth[u] + 1;
      parent[v] = u;
      bfs.push(v);
    }
  }

  const NECK_HOPS = 5;
  for (let i = 0; i < nodes.length; i++) {
    if (depth[i] < 0) {
      neckOf[i] = i;
      continue;
    }
    let best = i;
    let bestThick = nodes[i].thick;
    let u = i;
    for (let h = 0; h < NECK_HOPS && parent[u] >= 0; h++) {
      u = parent[u];
      if (nodes[u].thick < bestThick) {
        bestThick = nodes[u].thick;
        best = u;
      }
    }
    neckOf[i] = best;
  }

  const stats = computeStats(nodes, joints, comp);
  const top = {
    text,
    color,
    master,
    nodes,
    joints,
    adj,
    tileDisp,
    sc,
    comp,
    strokeJointIndicesByNode,
    supportJointIndicesByNode,
    centerNode,
    depth,
    neckOf,
    mcx: cx,
    mcy: cy,
    origMass: M,
    stats,
    fragCount: comp
  };
  TOP_CACHE.set(cacheKey, top);
  return cloneTop(top);
}

function computeStats(nodes, joints, comp) {
  const count = nodes.length;
  let M = 0;
  for (const n of nodes) M += n.mass;
  const weight = Math.round(clamp(M * 0.052, 5, 100));

  let mnx = 1e9;
  let mxx = -1e9;
  let mny = 1e9;
  let mxy = -1e9;
  let gx = 0;
  let gy = 0;
  for (const n of nodes) {
    mnx = Math.min(mnx, n.lx);
    mxx = Math.max(mxx, n.lx);
    mny = Math.min(mny, n.ly);
    mxy = Math.max(mxy, n.ly);
    gx += n.lx * n.mass;
    gy += n.ly * n.mass;
  }
  gx /= M;
  gy /= M;
  const bw = Math.max(1, mxx - mnx);
  const bh = Math.max(1, mxy - mny);
  const offset = Math.hypot(gx, gy) / Math.max(bw, bh);
  const quadrants = [0, 0, 0, 0];
  for (const n of nodes) quadrants[(n.lx >= gx ? 1 : 0) + (n.ly >= gy ? 2 : 0)] += n.mass;
  let qvar = 0;
  quadrants.forEach(v => { qvar += Math.abs(v - M / 4); });
  qvar /= M;
  const balance = Math.round(clamp(1 - (offset * 1.8 + qvar * 1.0), 0, 1) * 100);

  const occupied = new Set();
  for (const n of nodes) occupied.add(`${n.tr}_${n.tc}`);
  let boundary = 0;
  let spiky = 0;
  let flat = 0;
  for (const n of nodes) {
    let exposed = 0;
    if (!occupied.has(`${n.tr - 1}_${n.tc}`)) exposed++;
    if (!occupied.has(`${n.tr + 1}_${n.tc}`)) exposed++;
    if (!occupied.has(`${n.tr}_${n.tc - 1}`)) exposed++;
    if (!occupied.has(`${n.tr}_${n.tc + 1}`)) exposed++;
    if (exposed > 0) {
      boundary++;
      if (exposed >= 2) spiky++;
      else flat++;
    }
  }
  const attack = Math.round(clamp(boundary ? (spiky / boundary) * 1.2 : 0, 0, 1) * 100);
  const defense = Math.round(clamp(boundary ? (flat / boundary) * 1.05 : 0, 0, 1) * 100);

  const connectivity = joints.filter(j => j.kind === 'stroke').length / Math.max(count, 1);
  const durability = Math.round(clamp(connectivity * 0.42 - (comp - 1) * 0.07 + 0.3, 0, 1) * 100);

  return {
    weight,
    balance,
    attack,
    defense,
    durability,
    fragCount: comp,
    atkMul: lerp(0.7, 1.7, attack / 100),
    restMul: lerp(0.8, 1.25, defense / 100),
    bondStrength: lerp(0.9, 1.6, durability / 100),
    spin0: lerp(0.3, 0.42, (weight * 0.4 + balance * 0.6) / 100)
  };
}

/* ===================== 剛體 ===================== */
function makeBody(top, nodeIdxs, angle, isCentral) {
  let m = 0;
  let cmx = 0;
  let cmy = 0;
  let mnx = 1e9;
  let mxx = -1e9;
  let mny = 1e9;
  let mxy = -1e9;

  for (const i of nodeIdxs) {
    const n = top.nodes[i];
    m += n.mass;
    cmx += n.lx * n.mass;
    cmy += n.ly * n.mass;
    mnx = Math.min(mnx, n.lx);
    mxx = Math.max(mxx, n.lx);
    mny = Math.min(mny, n.ly);
    mxy = Math.max(mxy, n.ly);
  }
  cmx /= m;
  cmy /= m;

  const axleX = (mnx + mxx) / 2;
  const axleY = (mny + mxy) / 2;
  const offX = cmx - axleX;
  const offY = cmy - axleY;
  const imb = Math.hypot(offX, offY);

  let Icom = 0;
  for (const i of nodeIdxs) {
    const n = top.nodes[i];
    const rx = n.lx - cmx;
    const ry = n.ly - cmy;
    Icom += n.mass * (rx * rx + ry * ry);
  }
  const I = Math.max(1, (Icom + m * imb * imb) * IBOOST);

  const circles = [];
  let boundR = 0;
  for (const i of nodeIdxs) {
    const n = top.nodes[i];
    const rx = n.lx - axleX;
    const ry = n.ly - axleY;
    const cr = top.tileDisp * 0.6;
    circles.push({ rx, ry, r: cr, node: i });
    boundR = Math.max(boundR, Math.hypot(rx, ry) + cr);
  }

  const body = {
    top,
    nodeIdxs,
    axleLX: axleX,
    axleLY: axleY,
    offX,
    offY,
    imb,
    m,
    invM: 1 / m,
    I,
    invI: 1 / I,
    central: !!isCentral,
    circles,
    boundR,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: angle || 0,
    av: 0,
    side: 0,
    canvas: null,
    sideCanvas: null,
    cvcx: 0,
    cvcy: 0,
    tilt: 0,
    wobblePhase: 0
  };
  buildBodyCanvas(body);
  return body;
}

function buildBodyCanvas(body) {
  const top = body.top;
  const half = top.tileDisp / 2;
  let mnx = 1e9;
  let mxx = -1e9;
  let mny = 1e9;
  let mxy = -1e9;

  for (const i of body.nodeIdxs) {
    const n = top.nodes[i];
    const rx = n.lx - body.axleLX;
    const ry = n.ly - body.axleLY;
    mnx = Math.min(mnx, rx - half);
    mxx = Math.max(mxx, rx + half);
    mny = Math.min(mny, ry - half);
    mxy = Math.max(mxy, ry + half);
  }

  const pad = 2;
  const w = Math.max(1, Math.ceil(mxx - mnx) + pad * 2);
  const h = Math.max(1, Math.ceil(mxy - mny) + pad * 2);
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  body.cvcx = -mnx + pad;
  body.cvcy = -mny + pad;
  const g = cv.getContext('2d');
  if (g && typeof g.drawImage === 'function' && top.master) {
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.save();
    g.translate(body.cvcx - body.axleLX, body.cvcy - body.axleLY);
    paintGlyph(g, top, body.nodeIdxs);
    g.restore();
  }
  body.canvas = cv;

  const scv = document.createElement('canvas');
  scv.width = cv.width;
  scv.height = cv.height;
  const sg = scv.getContext('2d');
  if (sg && typeof sg.drawImage === 'function') {
    sg.drawImage(cv, 0, 0);
    sg.globalCompositeOperation = 'source-in';
    sg.fillStyle = sideColor(top.color);
    sg.fillRect(0, 0, cv.width, cv.height);
  }
  body.sideCanvas = scv;
}

function paintGlyph(ctx, top, nodeIdxs) {
  if (!top.master) return;
  ctx.save();
  ctx.scale(top.sc, top.sc);
  ctx.translate(-top.mcx, -top.mcy);
  ctx.beginPath();
  for (const i of nodeIdxs) {
    const n = top.nodes[i];
    ctx.rect(n.tc * TILE - 0.5, n.tr * TILE - 0.5, TILE + 1, TILE + 1);
  }
  ctx.clip();
  try {
    ctx.drawImage(top.master, 0, 0);
  } catch (err) {
    // ignore font draw timing issues
  }
  ctx.restore();
}

function worldCircles(body) {
  const cos = Math.cos(body.angle);
  const sin = Math.sin(body.angle);
  const out = [];
  for (const c of body.circles) {
    out.push({
      x: body.x + cos * c.rx - sin * c.ry,
      y: body.y + sin * c.rx + cos * c.ry,
      r: c.r,
      node: c.node
    });
  }
  return out;
}

function stepBody(body, cx, cy) {
  const rx0 = body.x - cx;
  const ry0 = body.y - cy;
  const spd = Math.abs(body.av);

  if (body.central) {
    body.vx += -rx0 * BOWL;
    body.vy += -ry0 * BOWL;
    const dist = Math.hypot(rx0, ry0);
    if (dist > 2) {
      const inv = INWARD / dist;
      body.vx += -rx0 * inv;
      body.vy += -ry0 * inv;
    }
  }

  if (body.central && body.imb > 0.3) {
    const cos = Math.cos(body.angle);
    const sin = Math.sin(body.angle);
    const owx = cos * body.offX - sin * body.offY;
    const owy = sin * body.offX + cos * body.offY;
    body.vx += body.av * body.av * owx * K_WOBBLE;
    body.vy += body.av * body.av * owy * K_WOBBLE;
  }

  if (spd > 0.012) {
    const a = GYRO_CURVE * body.av;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const nvx = ca * body.vx - sa * body.vy;
    const nvy = sa * body.vx + ca * body.vy;
    body.vx = nvx;
    body.vy = nvy;
  }

  let damp;
  if (!body.central) damp = DEBRIS_DAMP;
  else if (spd < SETTLE_SPIN) damp = lerp(0.9, LINDAMP, spd / SETTLE_SPIN);
  else damp = LINDAMP;

  body.vx *= damp;
  body.vy *= damp;
  body.vx = clamp(body.vx, -V_MAX, V_MAX);
  body.vy = clamp(body.vy, -V_MAX, V_MAX);
  body.x += body.vx;
  body.y += body.vy;
  body.angle += body.av;
  body.av *= SPINFRIC;
  if (body.central && body.imb > 0.3) body.av *= (1 - K_IMBDRAIN * clamp(body.imb / TOP_TARGET, 0, 0.5));
  if (body.central && spd < SETTLE_SPIN) body.av *= 0.99;
  body.av = clamp(body.av, -AV_MAX, AV_MAX);
  body.tilt = 0;
  body.wobblePhase += spd;

  const dx = body.x - cx;
  const dy = body.y - cy;
  const dist = Math.hypot(dx, dy) || 1e-6;
  const lim = ARENA_INNER - body.boundR * 0.55;
  if (dist > lim) {
    const nx = dx / dist;
    const ny = dy / dist;
    body.x = cx + nx * lim;
    body.y = cy + ny * lim;
    const vn = body.vx * nx + body.vy * ny;
    if (vn > 0) {
      body.vx -= 1.7 * vn * nx;
      body.vy -= 1.7 * vn * ny;
    }
  }
}

/* ===================== 碰撞與斷裂 ===================== */
function collidePair(A, B, fx, stressA, stressB, arena) {
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const rr = A.boundR + B.boundR;
  if (dx * dx + dy * dy > rr * rr) return 0;

  const dl = Math.hypot(dx, dy) || 1;
  const ux0 = dx / dl;
  const uy0 = dy / dl;

  const power = (body, sx, sy) => {
    if (body.imb < 0.3) return { p: 1, crit: false };
    const cos = Math.cos(body.angle);
    const sin = Math.sin(body.angle);
    let ox = cos * body.offX - sin * body.offY;
    let oy = sin * body.offX + cos * body.offY;
    const ol = Math.hypot(ox, oy) || 1;
    ox /= ol;
    oy /= ol;
    const lead = Math.max(0, ox * sx + oy * sy);
    const imbN = clamp(body.imb / TOP_TARGET, 0, 0.6);
    let p = 1 + lead * imbN * 2.0;
    let crit = false;
    if (lead > 0.45 && imbN > 0.12 && Math.random() < CRIT_CHANCE) {
      p *= CRIT_MULT;
      crit = true;
    }
    return { p, crit };
  };

  const pa = power(A, ux0, uy0);
  const pb = power(B, -ux0, -uy0);
  const ca = worldCircles(A);
  const cb = worldCircles(B);
  const gs = A.top.tileDisp * 1.4;
  const grid = {};
  const key = (gx, gy) => `${gx}#${gy}`;

  for (let i = 0; i < cb.length; i++) {
    const p = cb[i];
    const gx = Math.floor(p.x / gs);
    const gy = Math.floor(p.y / gs);
    (grid[key(gx, gy)] || (grid[key(gx, gy)] = [])).push(i);
  }

  let totalJ = 0;
  let hx = 0;
  let hy = 0;
  let hits = 0;

  for (const a of ca) {
    const gx = Math.floor(a.x / gs);
    const gy = Math.floor(a.y / gs);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const cell = grid[key(gx + ox, gy + oy)];
        if (!cell) continue;
        for (const bi of cell) {
          const b = cb[bi];
          let nx = b.x - a.x;
          let ny = b.y - a.y;
          const d = Math.hypot(nx, ny);
          const minD = a.r + b.r;
          if (d >= minD || d < 1e-6) continue;
          const ux = nx / d;
          const uy = ny / d;
          const pen = minD - d;
          const totInv = A.invM + B.invM;
          const corr = pen * 0.6;
          A.x -= ux * corr * (A.invM / totInv);
          A.y -= uy * corr * (A.invM / totInv);
          B.x += ux * corr * (B.invM / totInv);
          B.y += uy * corr * (B.invM / totInv);

          const rAx = a.x - A.x;
          const rAy = a.y - A.y;
          const rBx = b.x - B.x;
          const rBy = b.y - B.y;
          const vAx = A.vx - A.av * rAy;
          const vAy = A.vy + A.av * rAx;
          const vBx = B.vx - B.av * rBy;
          const vBy = B.vy + B.av * rBx;
          const rvx = vBx - vAx;
          const rvy = vBy - vAy;
          const vn = rvx * ux + rvy * uy;
          if (vn >= 0) continue;

          const rAcn = rAx * uy - rAy * ux;
          const rBcn = rBx * uy - rBy * ux;
          const invSum = A.invM + B.invM + rAcn * rAcn * A.invI + rBcn * rBcn * B.invI;
          const e = REST * 0.5 * (A.top.stats.restMul + B.top.stats.restMul);
          let jn = -(1 + e) * vn / invSum;
          jn *= 0.65;
          A.vx -= jn * A.invM * ux;
          A.vy -= jn * A.invM * uy;
          A.av -= rAcn * jn * A.invI;
          B.vx += jn * B.invM * ux;
          B.vy += jn * B.invM * uy;
          B.av += rBcn * jn * B.invI;

          const tx = -uy;
          const ty = ux;
          const vt = rvx * tx + rvy * ty;
          const rAct = rAx * ty - rAy * tx;
          const rBct = rBx * ty - rBy * tx;
          const invSumT = A.invM + B.invM + rAct * rAct * A.invI + rBct * rBct * B.invI;
          let jt = -vt / invSumT;
          jt *= 0.5;
          const lim = MU * Math.abs(jn * 2);
          jt = clamp(jt, -lim, lim);
          A.vx -= jt * A.invM * tx;
          A.vy -= jt * A.invM * ty;
          A.av -= rAct * jt * A.invI;
          B.vx += jt * B.invM * tx;
          B.vy += jt * B.invM * ty;
          B.av += rBct * jt * B.invI;

          const approach = -vn;
          if (approach > VN_HARD) {
            const dA = approach * B.top.stats.atkMul * pb.p;
            const dB = approach * A.top.stats.atkMul * pa.p;
            if (dA > (stressA[a.node] || 0)) stressA[a.node] = dA;
            if (dB > (stressB[b.node] || 0)) stressB[b.node] = dB;
          }
          totalJ += Math.abs(jn) + Math.abs(jt);
          hx += (a.x + b.x) / 2;
          hy += (a.y + b.y) / 2;
          hits++;
        }
      }
    }
  }

  if (hits > 0) {
    hx /= hits;
    hy /= hits;
    const crit = pa.crit || pb.crit;
    if (crit) {
      const atk = pa.crit ? A : B;
      const def = pa.crit ? B : A;
      const sgn = pa.crit ? 1 : -1;
      def.vx += ux0 * sgn * 3.2;
      def.vy += uy0 * sgn * 3.2;
      atk.av *= 0.93;
      addImpact(fx, hx, hy, 8, '#b5302a', true);
      if (arena) {
        arena.shake = Math.max(arena.shake, 9);
        arena.log(`「${atk.top.text}」偏重蓄力，使出強力一擊！`);
      }
    } else if (totalJ > 1.0) {
      addImpact(fx, hx, hy, totalJ, A.top.color, false);
      if (arena) arena.shake = Math.max(arena.shake, Math.min(4, 1 + totalJ * 0.3));
    }
  }

  return totalJ;
}

function applyFracture(top, bodies, stress, fx) {
  const neckStress = {};
  for (const k in stress) {
    const i = +k;
    const s = stress[k];
    if (s <= 0) continue;
    const nk = (top.neckOf && top.neckOf[i] != null) ? top.neckOf[i] : i;
    if (s > (neckStress[nk] || 0)) neckStress[nk] = s;
  }

  const result = [];
  for (const body of bodies) {
    const nodeSet = new Set(body.nodeIdxs);
    let broke = false;
    const bondStrength = top.stats.bondStrength;

    for (const k in neckStress) {
      const nk = +k;
      if (!nodeSet.has(nk)) continue;
      const strength = TOUGH * bondStrength * (THK0 + top.nodes[nk].thick * THKK);
      if (neckStress[k] <= strength) continue;
      const nThick = top.nodes[nk].thick;
      const dnk0 = top.depth[nk];
      const seen = new Set([nk]);
      const stack = [nk];
      while (stack.length) {
        const u = stack.pop();
        const du = top.depth[u];
        for (const jointIndex of top.strokeJointIndicesByNode[u]) {
          const joint = top.joints[jointIndex];
          if (joint.broken || joint.kind !== 'stroke' || !nodeSet.has(joint.a) || !nodeSet.has(joint.b)) continue;
          const other = joint.a === u ? joint.b : (joint.b === u ? joint.a : -1);
          if (other < 0) continue;
          if (top.depth[other] >= 0 && top.depth[other] < du) {
            joint.broken = true;
            broke = true;
          }
        }
        for (const v of top.adj[u]) {
          if (seen.has(v) || !nodeSet.has(v)) continue;
          if (top.depth[v] >= 0 && top.nodes[v].thick <= nThick + 1 && Math.abs(top.depth[v] - dnk0) <= 1) {
            seen.add(v);
            stack.push(v);
          }
        }
      }
    }

    const seenSupport = new Set();
    for (const nodeIndex of body.nodeIdxs) {
      for (const jointIndex of top.supportJointIndicesByNode[nodeIndex]) {
        if (seenSupport.has(jointIndex)) continue;
        seenSupport.add(jointIndex);
        const joint = top.joints[jointIndex];
        if (joint.broken || joint.kind !== 'support' || !nodeSet.has(joint.a) || !nodeSet.has(joint.b)) continue;
        const s = Math.max(stress[joint.a] || 0, stress[joint.b] || 0);
        if (s > TOUGH * bondStrength * 0.5) {
          joint.broken = true;
          broke = true;
        }
      }
    }

    if (!broke) {
      result.push(body);
      continue;
    }

    const idxArr = body.nodeIdxs;
    const pos = {};
    idxArr.forEach((v, k) => { pos[v] = k; });
    const parent = idxArr.map((_, k) => k);
    const find = x => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    const unite = (a, b) => {
      a = find(a);
      b = find(b);
      if (a !== b) parent[a] = b;
    };

    for (const joint of top.joints) {
      if (!joint.broken && nodeSet.has(joint.a) && nodeSet.has(joint.b)) unite(pos[joint.a], pos[joint.b]);
    }

    const groups = {};
    for (let k = 0; k < idxArr.length; k++) {
      const root = find(k);
      (groups[root] || (groups[root] = [])).push(idxArr[k]);
    }
    const gkeys = Object.keys(groups);
    if (gkeys.length <= 1) {
      result.push(body);
      continue;
    }

    for (const gk of gkeys) {
      const gn = groups[gk];
      const isC = gn.indexOf(top.centerNode) >= 0;
      const nb = makeBody(top, gn, body.angle, isC);
      nb.side = body.side;
      const cos = Math.cos(body.angle);
      const sin = Math.sin(body.angle);
      const dlx = nb.axleLX - body.axleLX;
      const dly = nb.axleLY - body.axleLY;
      nb.x = body.x + (cos * dlx - sin * dly);
      nb.y = body.y + (sin * dlx + cos * dly);
      nb.angle = body.angle;
      const rx = nb.x - body.x;
      const ry = nb.y - body.y;
      nb.vx = body.vx - body.av * ry;
      nb.vy = body.vy + body.av * rx;
      if (isC) {
        nb.av = body.av;
      } else {
        nb.av = (Math.random() - 0.5) * 0.05;
        const dd = Math.hypot(rx, ry) || 1;
        nb.vx += rx / dd * 2.0;
        nb.vy += ry / dd * 2.0;
        if (fx) addImpact(fx, nb.x, nb.y, 4, top.color, false);
      }
      result.push(nb);
    }
  }

  return result;
}

function addImpact(fx, x, y, power, color, crit) {
  if (!fx) return;
  fx.push({ t: 'r', x, y, life: 1, decay: crit ? 0.045 : 0.08, c: crit ? '#b5302a' : color, r0: crit ? 12 : 5, r1: crit ? 54 : 24 });
  const n = crit ? 16 : Math.min(11, 3 + (power | 0));
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = rnd(crit ? 2.4 : 1, crit ? 7 : 3.6);
    fx.push({ t: 'd', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, decay: rnd(0.03, 0.07), c: Math.random() < 0.5 ? color : '#1c1a17', r: rnd(1.2, crit ? 3.6 : 2.4) });
  }
  if (crit) fx.push({ t: 'r', x, y, life: 1, decay: 0.035, c: '#b5302a', r0: 4, r1: 78 });
}

/* ===================== 對戰引擎 ===================== */
class Arena {
  constructor(canvas) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.cx = canvas.width / 2;
    this.cy = canvas.height / 2;
    this.bodiesA = [];
    this.bodiesB = [];
    this.effects = [];
    this.shake = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.running = false;
    this.decided = false;
    this.onEnd = null;
    this.log = () => {};
    this.topA = null;
    this.topB = null;
    this.lastA = 0;
    this.lastB = 0;
    this.decisionEndsAt = 0;
    this.onFrame = null;
    this.raf = 0;
  }

  reset() {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.bodiesA = [];
    this.bodiesB = [];
    this.effects = [];
    this.shake = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.running = false;
    this.decided = false;
    this.topA = null;
    this.topB = null;
    this.lastA = 0;
    this.lastB = 0;
    this.decisionEndsAt = 0;
  }

  spawn(topA, topB) {
    this.reset();
    this.topA = topA;
    this.topB = topB;

    const startRadius = 96;
    const A = makeBody(topA, topA.nodes.map((_, i) => i), 0, true);
    const B = makeBody(topB, topB.nodes.map((_, i) => i), 0, true);
    A.side = 0;
    B.side = 1;
    A.x = this.cx - startRadius;
    A.y = this.cy + rnd(-12, 12);
    B.x = this.cx + startRadius;
    B.y = this.cy + rnd(-12, 12);
    A.vy = 1.5;
    B.vy = 1.5;
    A.av = topA.stats.spin0 * 1.5 * (Math.random() < 0.5 ? 1 : -1);
    B.av = topB.stats.spin0 * 1.5 * (Math.random() < 0.5 ? 1 : -1);
    this.bodiesA = [A];
    this.bodiesB = [B];
    this.lastA = topA.origMass;
    this.lastB = topB.origMass;
    this.running = true;
    this._loop();
  }

  pickCentralBody(list, centerNode) {
    if (!list.length) return null;
    for (const body of list) if (body.nodeIdxs.indexOf(centerNode) >= 0) return body;
    let best = list[0];
    for (const body of list) if (body.m > best.m) best = body;
    return best;
  }

  centralBody(side) {
    if (side === 0) return this.pickCentralBody(this.bodiesA, this.topA ? this.topA.centerNode : -1);
    return this.pickCentralBody(this.bodiesB, this.topB ? this.topB.centerNode : -1);
  }

  bodyState(body, top) {
    if (!body) return { dead: true, massRatio: 0, spin: 0, reason: '筆畫潰散逾半' };
    const massRatio = body.m / top.origMass;
    const spin = Math.abs(body.av);
    let dead = false;
    let reason = '';
    if (massRatio < 0.5) {
      dead = true;
      reason = '筆畫潰散逾半';
    } else if (spin < AV_DEAD) {
      dead = true;
      reason = '中心旋轉力耗盡';
    }
    return { dead, massRatio, spin, reason };
  }

  checkVictory(cA, cB) {
    if (this.decided) return true;
    const stateA = this.bodyState(cA, this.topA);
    const stateB = this.bodyState(cB, this.topB);
    if (!(stateA.dead || stateB.dead)) return;
    let winner;
    if (stateA.dead && stateB.dead) {
      if (stateA.massRatio !== stateB.massRatio) winner = stateA.massRatio > stateB.massRatio ? 0 : 1;
      else winner = stateA.spin >= stateB.spin ? 0 : 1;
    } else {
      winner = stateA.dead ? 1 : 0;
    }
    this.decided = true;
    this.decisionEndsAt = Date.now() + POST_DECISION_RENDER_MS;
    this.onEnd && this.onEnd(winner, { A: stateA, B: stateB });
    return true;
  }

  step() {
    if (!this.topA || !this.topB) return;
    if (this.decided) {
      for (const body of this.bodiesA) stepBody(body, this.cx, this.cy);
      for (const body of this.bodiesB) stepBody(body, this.cx, this.cy);
      if (Date.now() >= this.decisionEndsAt) this.running = false;
      return;
    }
    for (let s = 0; s < SUBSTEPS; s++) {
      for (const body of this.bodiesA) stepBody(body, this.cx, this.cy);
      for (const body of this.bodiesB) stepBody(body, this.cx, this.cy);

      const preCA = this.centralBody(0);
      const preCB = this.centralBody(1);
      if (this.checkVictory(preCA, preCB)) return;

      const stressA = {};
      const stressB = {};
      for (const a of this.bodiesA) {
        for (const b of this.bodiesB) collidePair(a, b, this.effects, stressA, stressB, this);
      }
      this.bodiesA = applyFracture(this.topA, this.bodiesA, stressA, this.effects);
      this.bodiesB = applyFracture(this.topB, this.bodiesB, stressB, this.effects);

      const postCA = this.centralBody(0);
      const postCB = this.centralBody(1);
      if (postCA && postCA.m < this.lastA - 0.5) this.log(`「${this.topA.text}」筆畫被撞斷轉飛！`);
      if (postCB && postCB.m < this.lastB - 0.5) this.log(`「${this.topB.text}」筆畫被撞斷轉飛！`);
      this.lastA = postCA ? postCA.m : 0;
      this.lastB = postCB ? postCB.m : 0;
      if (this.checkVictory(postCA, postCB)) return;
    }
  }

  _loop() {
    if (!this.running) return;
    this.step();
    this.render();
    this.onFrame && this.onFrame();
    if (this.running) this.raf = requestAnimationFrame(() => this._loop());
  }

  project(x, y, z) {
    return [x + this.shakeX, this.cy + (y - this.cy) * VIEW_KY - (z || 0) * VIEW_KZ + this.shakeY];
  }

  drawBowl(ctx) {
    ctx.save();
    ctx.translate(this.cx + this.shakeX, this.cy + this.shakeY);
    ctx.scale(1, VIEW_KY);
    ctx.beginPath();
    ctx.arc(0, 0, ARENA_R - 4, 0, Math.PI * 2);
    const grd = ctx.createRadialGradient(0, -40, 20, 0, 0, ARENA_R);
    grd.addColorStop(0, '#4a3826');
    grd.addColorStop(0.7, '#2c2014');
    grd.addColorStop(1, '#1c150d');
    ctx.fillStyle = grd;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.lineWidth = 2;
    for (let rr = 60; rr < ARENA_R; rr += 60) {
      ctx.beginPath();
      ctx.arc(0, 0, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawBody3D(ctx, body) {
    if (!body.canvas) return;
    const a = body.angle;
    const beta = (body.tilt || 0) * MAXLEAN;
    const psi = body.wobblePhase || 0;
    const ux = Math.sin(beta) * Math.cos(psi);
    const uy = Math.sin(beta) * Math.sin(psi);
    const uz = Math.cos(beta);
    let hx = Math.cos(a);
    let hy = Math.sin(a);
    const hd = hx * ux + hy * uy;
    let e1x = hx - hd * ux;
    let e1y = hy - hd * uy;
    let e1z = -hd * uz;
    const el = Math.hypot(e1x, e1y, e1z) || 1;
    e1x /= el;
    e1y /= el;
    e1z /= el;
    const e2x = uy * e1z - uz * e1y;
    const e2y = uz * e1x - ux * e1z;
    const e2z = ux * e1y - uy * e1x;
    const s1x = e1x;
    const s1y = e1y * VIEW_KY - e1z * VIEW_KZ;
    const s2x = e2x;
    const s2y = e2y * VIEW_KY - e2z * VIEW_KZ;
    const uSx = ux * THICK;
    const uSy = (uy * VIEW_KY - uz * VIEW_KZ) * THICK;
    const base = this.project(body.x, body.y, 0);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.save();
    ctx.translate(base[0], base[1] + 3);
    ctx.scale(1, VIEW_KY * 0.55);
    ctx.fillStyle = 'rgba(90,68,42,0.13)';
    ctx.beginPath();
    ctx.arc(0, 0, body.boundR * 0.95, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const layers = Math.max(4, Math.round(THICK * 0.8));
    for (let k = 0; k <= layers; k++) {
      const t = k / layers;
      ctx.setTransform(s1x, s1y, s2x, s2y, base[0] + uSx * t, base[1] + uSy * t);
      ctx.drawImage(body.sideCanvas, -body.cvcx, -body.cvcy);
    }
    ctx.setTransform(s1x, s1y, s2x, s2y, base[0] + uSx, base[1] + uSy);
    ctx.drawImage(body.canvas, -body.cvcx, -body.cvcy);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  render() {
    const ctx = this.g;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.cv.width, this.cv.height);
    this.shakeX = 0;
    this.shakeY = 0;
    if (this.shake > 0.3) {
      this.shakeX = (Math.random() - 0.5) * this.shake;
      this.shakeY = (Math.random() - 0.5) * this.shake;
      this.shake *= 0.86;
    } else {
      this.shake = 0;
    }

    this.drawBowl(ctx);

    const all = this.bodiesA.concat(this.bodiesB).sort((a, b) => a.y - b.y);
    for (const body of all) this.drawBody3D(ctx, body);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.life -= e.decay;
      if (e.life <= 0) {
        this.effects.splice(i, 1);
        continue;
      }
      if (e.t === 'r') {
        const rr = lerp(e.r0, e.r1, 1 - e.life);
        const p = this.project(e.x, e.y, 0);
        ctx.save();
        ctx.translate(p[0], p[1]);
        ctx.scale(1, VIEW_KY);
        ctx.strokeStyle = hexA(e.c, e.life * 0.7);
        ctx.lineWidth = 2 * e.life + 0.4;
        ctx.beginPath();
        ctx.arc(0, 0, rr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      } else {
        e.x += e.vx;
        e.y += e.vy;
        e.vx *= 0.93;
        e.vy *= 0.93;
        const p = this.project(e.x, e.y, 0);
        ctx.fillStyle = hexA(e.c, e.life);
        ctx.beginPath();
        ctx.arc(p[0], p[1], e.r * e.life + 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/* ===================== 名人堂 ===================== */
const Hall = {
  entries: {},
  record(top) {
    if (!top) return null;
    let e = this.entries[top.text];
    if (!e) {
      e = {
        text: top.text,
        stats: {
          weight: top.stats.weight,
          balance: top.stats.balance,
          attack: top.stats.attack,
          defense: top.stats.defense,
          durability: top.stats.durability
        },
        fragCount: top.fragCount,
        plays: 0,
        wins: 0,
        losses: 0,
        first: Date.now()
      };
      this.entries[top.text] = e;
    }
    return e;
  },
  result(text, won) {
    const e = this.entries[text];
    if (!e) return;
    e.plays += 1;
    if (won) e.wins += 1;
    else e.losses += 1;
  },
  clear() {
    this.entries = {};
  }
};

/* ===================== UI 控制 ===================== */
const App = {
  mode: 'name',
  topsA: [],
  topsB: [],
  match: null,
  arena: null,
  roundStartTimer: 0,
  roundEndTimer: 0,
  statusSnapshot: [null, null],

  init() {
    this.arena = new Arena(document.getElementById('arena'));
    this.arena.onFrame = () => this.updateStatus();
    this.bindSetup();
    this.bindBattle();
    this.bindHall();
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => this.refreshPreviews());
    } else {
      this.refreshPreviews();
    }
  },

  show(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  },

  hideBattleOverlays() {
    document.getElementById('round-overlay').classList.add('hidden');
    document.getElementById('match-overlay').classList.add('hidden');
  },

  clearPendingTimers() {
    if (this.roundStartTimer) {
      clearTimeout(this.roundStartTimer);
      this.roundStartTimer = 0;
    }
    if (this.roundEndTimer) {
      clearTimeout(this.roundEndTimer);
      this.roundEndTimer = 0;
    }
  },

  resetStatusSnapshot() {
    this.statusSnapshot = [null, null];
  },

  bindSetup() {
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.mode = btn.dataset.mode;
        const max = this.mode === 'name' ? 3 : 1;
        document.querySelectorAll('.name-input').forEach(inp => {
          inp.maxLength = max;
          if (inp.value.length > max) inp.value = inp.value.slice(0, max);
        });
        this.refreshPreviews();
      });
    });

    document.querySelectorAll('.name-input').forEach(inp => {
      inp.addEventListener('input', () => {
        inp.value = inp.value.replace(/[^㐀-鿿豈-﫿]/g, '');
        this.refreshPreviews();
      });
    });

    document.getElementById('btn-start').addEventListener('click', () => this.startMatch());
    document.getElementById('btn-hall').addEventListener('click', () => {
      this.renderHall();
      this.show('screen-hall');
    });
  },

  getChars(side) {
    const v = document.querySelector(`.name-input[data-side="${side}"]`).value.trim();
    return [...v];
  },

  refreshPreviews() {
    ['A', 'B'].forEach(side => {
      const chars = this.getChars(side).slice(0, this.mode === 'name' ? 3 : 1);
      const color = side === 'A' ? TEAM_RED : TEAM_BLUE;
      const tops = chars.map(ch => buildTop(ch, color));
      if (side === 'A') this.topsA = tops;
      else this.topsB = tops;
      const row = document.querySelector(`.preview-row[data-preview="${side}"]`);
      row.innerHTML = '';
      tops.forEach(top => row.appendChild(this.previewCard(top)));
    });

    const need = this.mode === 'name' ? 3 : 1;
    const ok = this.topsA.length >= need && this.topsB.length >= need && this.topsA.every(Boolean) && this.topsB.every(Boolean);
    document.getElementById('btn-start').disabled = !ok;
  },

  previewCard(top) {
    const card = document.createElement('div');
    card.className = 'preview-card';
    const cv = document.createElement('canvas');
    cv.width = 96;
    cv.height = 96;
    const stat = document.createElement('div');
    stat.className = 'preview-stats';
    if (!top) {
      stat.innerHTML = '<div class="sname">?</div><div>無法渲染</div>';
      drawGlyphPreview(cv, null);
    } else {
      const s = top.stats;
      stat.innerHTML = `<div class="sname">${top.text}</div>` +
        bar('重', s.weight, 'bar-w') +
        bar('穩', s.balance, 'bar-s') +
        bar('攻', s.attack, 'bar-a') +
        bar('防', s.defense, 'bar-d');
      drawGlyphPreview(cv, top);
    }
    card.appendChild(cv);
    card.appendChild(stat);
    return card;
  },

  startMatch() {
    const A = this.topsA;
    const B = this.topsB;
    if (!A.length || !B.length) return;
    if (this.mode === 'name' && (A.length < 3 || B.length < 3)) return;
    this.clearPendingTimers();
    this.match = {
      mode: this.mode,
      names: [this.getChars('A').join(''), this.getChars('B').join('')],
      chars: [A, B],
      rounds: this.mode === 'name' ? 3 : 1,
      round: 0,
      score: [0, 0],
      results: []
    };
    A.forEach(t => Hall.record(t));
    B.forEach(t => Hall.record(t));
    this.hideBattleOverlays();
    this.show('screen-battle');
    this.setupRound();
  },

  setupRound() {
    const m = this.match;
    const ti = m.round;
    const a = m.chars[0][Math.min(ti, m.chars[0].length - 1)];
    const b = m.chars[1][Math.min(ti, m.chars[1].length - 1)];
    const ta = buildTop(a.text, a.color);
    const tb = buildTop(b.text, b.color);
    m.curA = ta;
    m.curB = tb;

    this.hideBattleOverlays();
    this.clearPendingTimers();
    this.arena.reset();
    this.resetStatusSnapshot();
    this.renderRoster();
    this.renderScore();
    this.clearLog();
    this.log(`第 ${m.round + 1} 回合：「${a.text}」對「${b.text}」！`);
    this.updateStatus();
    this.arena.log = html => this.log(html);
    this.arena.onEnd = (winner, states) => this.onRoundEnd(winner, states);
    this.roundStartTimer = setTimeout(() => {
      this.roundStartTimer = 0;
      this.arena.spawn(ta, tb);
    }, SPAWN_DELAY_MS);
  },

  onRoundEnd(winner, states) {
    this.updateStatus();
    const m = this.match;
    m.score[winner]++;
    m.results[m.round] = winner === 0 ? 'A' : 'B';
    const wText = (winner === 0 ? m.curA : m.curB).text;
    const loseState = winner === 0 ? states.B : states.A;
    this.log(`<span class="lg-win">「${wText}」勝出！（對方${loseState.reason}）</span>`);
    Hall.result(m.curA.text, winner === 0);
    Hall.result(m.curB.text, winner === 1);
    this.renderRoster();
    this.renderScore();

    const done = m.round + 1 >= m.rounds;
    this.clearPendingTimers();
    this.roundEndTimer = setTimeout(() => {
      this.roundEndTimer = 0;
      if (done) this.showMatchOverlay();
      else this.showRoundOverlay(winner);
    }, RESULT_OVERLAY_DELAY_MS);
  },

  showRoundOverlay(winner) {
    const m = this.match;
    document.getElementById('round-title').textContent = `本回合 ${(winner === 0 ? m.curA : m.curB).text} 勝`;
    document.getElementById('round-score').innerHTML = this.scoreText();
    document.getElementById('round-overlay').classList.remove('hidden');
  },

  showMatchOverlay() {
    const m = this.match;
    const finalWinner = m.score[0] > m.score[1] ? 0 : 1;
    if (m.mode === 'single') {
      document.getElementById('match-title').textContent = `🏆 ${(finalWinner === 0 ? m.curA : m.curB).text} 勝出`;
    } else {
      document.getElementById('match-title').textContent = `🏆 ${m.names[finalWinner]} 為最強名字`;
    }
    document.getElementById('match-score').innerHTML = this.scoreText();
    document.getElementById('match-overlay').classList.remove('hidden');
  },

  scoreText() {
    const m = this.match;
    return `<span class="sb-a">${m.names[0] || '紅'}</span> &nbsp;` +
      `<span class="sb-num">${m.score[0]} : ${m.score[1]}</span>&nbsp; ` +
      `<span class="sb-b">${m.names[1] || '藍'}</span>`;
  },

  bindBattle() {
    document.getElementById('btn-back-setup').addEventListener('click', () => {
      this.hideBattleOverlays();
      this.clearPendingTimers();
      this.arena.reset();
      this.resetStatusSnapshot();
      this.show('screen-setup');
    });

    document.getElementById('btn-next-round').addEventListener('click', () => {
      this.clearPendingTimers();
      document.getElementById('round-overlay').classList.add('hidden');
      this.match.round++;
      this.setupRound();
    });

    document.getElementById('btn-rematch').addEventListener('click', () => {
      this.clearPendingTimers();
      document.getElementById('match-overlay').classList.add('hidden');
      this.startMatch();
    });

    document.getElementById('btn-home').addEventListener('click', () => {
      this.hideBattleOverlays();
      this.clearPendingTimers();
      this.arena.reset();
      this.resetStatusSnapshot();
      this.show('screen-setup');
    });
  },

  renderRoster() {
    const m = this.match;
    [0, 1].forEach(side => {
      const el = document.querySelector(`.roster[data-roster="${side === 0 ? 'A' : 'B'}"]`);
      el.innerHTML = '';
      m.chars[side].forEach((top, i) => {
        const item = document.createElement('div');
        item.className = 'roster-item';
        let state = '待戰';
        if (i < m.results.length) {
          const won = m.results[i] === (side === 0 ? 'A' : 'B');
          state = won ? '勝' : '敗';
          item.classList.add(won ? 'win' : 'lose');
        } else if (i === m.round) {
          state = '戰鬥中';
          item.classList.add('fighting');
        }
        const cv = document.createElement('canvas');
        cv.width = 48;
        cv.height = 48;
        const liveTop = i === m.round ? (side === 0 ? m.curA : m.curB) : top;
        drawGlyphPreview(cv, liveTop);
        item.appendChild(cv);
        const info = document.createElement('div');
        info.className = 'roster-info';
        info.innerHTML = `<div class="rname" style="color:${side === 0 ? 'var(--red)' : 'var(--blue)'}">${top.text}</div>` +
          `<div class="rstate">${state}</div>`;
        item.appendChild(info);
        el.appendChild(item);
      });
    });
  },

  renderScore() {
    const m = this.match;
    if (m.mode === 'single') {
      document.getElementById('score-board').innerHTML =
        `<span class="sb-name sb-a">${m.curA ? m.curA.text : (m.names[0] || '紅方')}</span>` +
        `<span class="sb-round">單字對戰</span>` +
        `<span class="sb-name sb-b">${m.curB ? m.curB.text : (m.names[1] || '藍方')}</span>`;
      return;
    }
    document.getElementById('score-board').innerHTML =
      `<span class="sb-name sb-a">${m.names[0] || '紅方'}</span>` +
      `<span class="sb-num">${m.score[0]}</span>` +
      `<span class="sb-round">第 ${Math.min(m.round + 1, m.rounds)}/${m.rounds} 回合</span>` +
      `<span class="sb-num">${m.score[1]}</span>` +
      `<span class="sb-name sb-b">${m.names[1] || '藍方'}</span>`;
  },

  updateStatus() {
    const m = this.match;
    if (!m || !document.getElementById('screen-battle').classList.contains('active')) return;
    [0, 1].forEach(side => {
      const body = this.arena.centralBody(side);
      const bodies = side === 0 ? this.arena.bodiesA : this.arena.bodiesB;
      const top = side === 0 ? m.curA : m.curB;
      const el = document.querySelector(`.battle-status[data-status="${side === 0 ? 'A' : 'B'}"]`);
      const canvas = document.getElementById(side === 0 ? 'status-diagram-a' : 'status-diagram-b');
      const comp = body ? Math.round(body.m / body.top.origMass * 100) : 0;
      const snapshot = {
        topText: top ? top.text : '',
        comp,
        body,
        bodiesLength: bodies.length
      };
      const prev = this.statusSnapshot[side];
      if (prev && prev.topText === snapshot.topText && prev.comp === snapshot.comp && prev.body === snapshot.body && prev.bodiesLength === snapshot.bodiesLength) {
        return;
      }
      this.statusSnapshot[side] = snapshot;
      drawStatusDiagram(canvas, top, nodeBodyMap(bodies), body);
      el.innerHTML = `<b style="color:${side === 0 ? 'var(--red)' : 'var(--blue)'}">${top ? top.text : '—'}</b><br>完整度 ${comp}%`;
    });
  },

  log(html) {
    const el = document.getElementById('battle-log');
    const line = document.createElement('div');
    line.innerHTML = html;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  },

  clearLog() {
    document.getElementById('battle-log').innerHTML = '';
  },

  bindHall() {
    document.getElementById('btn-back-from-hall').addEventListener('click', () => this.show('screen-setup'));
    document.getElementById('btn-clear-hall').addEventListener('click', () => {
      if (confirm('確定清除所有上場紀錄？')) {
        Hall.clear();
        this.renderHall();
        document.getElementById('hall-detail').classList.add('hidden');
      }
    });
  },

  renderHall() {
    const list = document.getElementById('hall-list');
    const ents = Object.values(Hall.entries).sort((a, b) => (b.plays - a.plays) || (b.first - a.first));
    if (ents.length === 0) {
      list.innerHTML = '<div class="hall-empty">尚無紀錄，快去對戰吧！</div>';
      return;
    }
    list.innerHTML = '';
    ents.forEach(e => {
      const card = document.createElement('div');
      card.className = 'hall-card';
      const cv = document.createElement('canvas');
      cv.width = 80;
      cv.height = 80;
      const top = buildTop(e.text, HALL_GOLD);
      const total = e.wins + e.losses;
      const wr = total ? Math.round(e.wins / total * 100) : 0;
      const txt = document.createElement('div');
      txt.innerHTML = `<div class="hc-text">${e.text}</div>` +
        `<div class="hc-rec">出場 ${e.plays} · ${e.wins}勝${e.losses}敗<br>` +
        `<span class="hc-wr">勝率 ${wr}%</span></div>`;
      card.appendChild(cv);
      card.appendChild(txt);
      drawGlyphPreview(cv, top);
      card.addEventListener('click', () => this.renderHallDetail(e));
      list.appendChild(card);
    });
  },

  renderHallDetail(e) {
    const d = document.getElementById('hall-detail');
    d.classList.remove('hidden');
    const top = buildTop(e.text, HALL_GOLD);
    const total = e.wins + e.losses;
    const wr = total ? Math.round(e.wins / total * 100) : 0;
    const s = e.stats;
    d.innerHTML = '';
    const cv = document.createElement('canvas');
    cv.width = 140;
    cv.height = 140;
    drawGlyphPreview(cv, top);
    d.appendChild(cv);
    const body = document.createElement('div');
    body.className = 'hd-body';
    body.innerHTML = `<div class="hd-name">${e.text}</div>` +
      statRow('重量', s.weight, '#c98b3c') +
      statRow('穩定', s.balance, '#5a9ed6') +
      statRow('攻擊', s.attack, '#d6433a') +
      statRow('防禦', s.defense, '#6abf5a') +
      statRow('耐久', s.durability, '#b88ad6') +
      `<div class="hd-record">出場 <b>${e.plays}</b> 次　` +
      `<b style="color:var(--green)">${e.wins}</b> 勝 / ` +
      `<b style="color:var(--red)">${e.losses}</b> 敗　` +
      `<span class="hd-wr">勝率 ${wr}%</span><br>` +
      `原始筆畫分離段數：${e.fragCount}</div>`;
    d.appendChild(body);
    d.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
};

/* ===================== 共用繪圖小工具 ===================== */
function bar(label, val, cls) {
  return `<div>${label} ${val}<div class="stat-bar"><i class="${cls}" style="width:${val}%"></i></div></div>`;
}

function statRow(label, val, col) {
  return `<div class="hd-stat-row"><span class="hd-label">${label}</span>` +
    `<span class="hd-track"><i style="width:${val}%;background:${col}"></i></span>` +
    `<span class="hd-val">${val}</span></div>`;
}

function drawTianGrid(g, W, H) {
  g.strokeStyle = 'rgba(214,67,58,.35)';
  g.lineWidth = 1;
  g.strokeRect(2, 2, W - 4, H - 4);
  g.beginPath();
  g.setLineDash([4, 4]);
  g.moveTo(W / 2, 2); g.lineTo(W / 2, H - 2);
  g.moveTo(2, H / 2); g.lineTo(W - 2, H / 2);
  g.moveTo(2, 2); g.lineTo(W - 2, H - 2);
  g.moveTo(W - 2, 2); g.lineTo(2, H - 2);
  g.strokeStyle = 'rgba(214,67,58,.18)';
  g.stroke();
  g.setLineDash([]);
}

function nodeBodyMap(bodies) {
  const map = {};
  for (const body of bodies || []) {
    for (const index of body.nodeIdxs) map[index] = body;
  }
  return map;
}

function drawStatusDiagram(cv, top, nodeBody, main) {
  const g = cv.getContext('2d');
  const W = cv.width;
  const H = cv.height;
  g.clearRect(0, 0, W, H);
  drawTianGrid(g, W, H);
  if (!top) return;

  let minx = 1e9;
  let maxx = -1e9;
  let miny = 1e9;
  let maxy = -1e9;
  for (const n of top.nodes) {
    minx = Math.min(minx, n.lx);
    maxx = Math.max(maxx, n.lx);
    miny = Math.min(miny, n.ly);
    maxy = Math.max(maxy, n.ly);
  }
  const gw = Math.max(1, maxx - minx + top.tileDisp);
  const gh = Math.max(1, maxy - miny + top.tileDisp);
  const scale = Math.min((W * 0.76) / gw, (H * 0.76) / gh);
  const cx = (minx + maxx) / 2;
  const cy = (miny + maxy) / 2;
  const size = top.tileDisp * scale;

  top.nodes.forEach((n, i) => {
    const x = W / 2 + (n.lx - cx) * scale;
    const y = H / 2 + (n.ly - cy) * scale;
    const attached = nodeBody ? nodeBody[i] === main : true;
    if (attached) {
      g.fillStyle = top.color;
      g.fillRect(x - size / 2, y - size / 2, size + 0.5, size + 0.5);
    } else {
      g.fillStyle = 'rgba(150,150,150,.35)';
      g.fillRect(x - size / 2, y - size / 2, size + 0.5, size + 0.5);
      g.strokeStyle = 'rgba(214,67,58,.35)';
      g.lineWidth = 1;
      g.strokeRect(x - size / 2, y - size / 2, size + 0.5, size + 0.5);
    }
  });
}

function drawGlyphPreview(cv, top) {
  const g = cv.getContext('2d');
  const W = cv.width;
  const H = cv.height;
  g.clearRect(0, 0, W, H);
  drawTianGrid(g, W, H);
  if (!top) return;

  let minx = 1e9;
  let maxx = -1e9;
  let miny = 1e9;
  let maxy = -1e9;
  top.nodes.forEach(n => {
    minx = Math.min(minx, n.lx);
    maxx = Math.max(maxx, n.lx);
    miny = Math.min(miny, n.ly);
    maxy = Math.max(maxy, n.ly);
  });
  const gw = (maxx - minx) || 1;
  const gh = (maxy - miny) || 1;
  const scale = Math.min((W - 16) / gw, (H - 16) / gh) * 0.92;
  const cx = (minx + maxx) / 2;
  const cy = (miny + maxy) / 2;
  const t = top.tileDisp * scale;
  top.nodes.forEach((n, i) => {
    const x = W / 2 + (n.lx - cx) * scale;
    const y = H / 2 + (n.ly - cy) * scale;
    const broken = top.joints.some(j => j.broken && (j.a === i || j.b === i));
    g.fillStyle = broken ? 'rgba(150,150,150,.4)' : top.color;
    g.fillRect(x - t / 2, y - t / 2, t + 0.5, t + 0.5);
  });
}

window.addEventListener('DOMContentLoaded', () => App.init());

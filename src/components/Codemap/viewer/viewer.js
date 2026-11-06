// tk-codemap's viewer; viewer.html runs it on the CODEMAP the review posts into its frame.
(() => {
  const $ = (s) => document.querySelector(s);
  const raw = CODEMAP.graph;
  const N = raw.nodes,
    RE = raw.edges,
    TE = raw.tedges || raw.edges,
    NN = N.length;
  let E = TE;
  const REPO = raw.repo || 'repo';
  // top-level folders that hold one project per sub-folder (apps/, libs/, packages/ ...)
  const CONT = new Set(raw.containers || ['apps', 'libs', 'packages']);

  // ---------- theme ----------
  // The review's design tokens as hex; the host resolves them, since a canvas can't read CSS.
  const token = (name, fallback) => (CODEMAP.theme && CODEMAP.theme[name]) || fallback;
  // `a` over `b` at strength `t`, kept as hex so it can be mixed again.
  const blend = (a, b, t) => {
    const p = parseInt(a.slice(1), 16),
      q = parseInt(b.slice(1), 16);
    const channel = (k) => Math.round(((q >> k) & 255) + (((p >> k) & 255) - ((q >> k) & 255)) * t);
    return '#' + [16, 8, 0].map((k) => channel(k).toString(16).padStart(2, '0')).join('');
  };
  const C = {
    canvas: token('--bg-code', '#0b0d11'),
    chrome: token('--bg', '#0f1218'),
    raised: token('--bg-raised', '#151922'),
    sunken: token('--bg-sunken', '#0d1015'),
    hover: token('--bg-hover', '#2b3242'),
    border: token('--border', '#272d3a'),
    borderStrong: token('--border-strong', '#3a4255'),
    text: token('--text', '#e8ebf1'),
    bright: token('--tk-fg-bright', '#ffffff'),
    dim: token('--text-dim', '#9aa4b5'),
    faint: token('--text-faint', '#5d6575'),
    added: token('--added', '#4ade80'),
    modified: token('--modified', '#fbbf24'),
    renamed: token('--renamed', '#a78bfa'),
    deleted: token('--deleted', '#f87171'),
    radius: token('--tk-purple', '#60a5fa'),
    imports: token('--tk-blue', '#5fe0ff'),
    importedBy: token('--tk-orange', '#ffab52'),
    warning: token('--tk-yellow', '#ffcf70'),
    green: token('--tk-green', '#7ddc8f'),
    pink: token('--tk-pink', '#ff5c93'),
  };
  // Pages, folder frames and their rules: the text washed over the canvas, `t` of the way.
  const sheet = (t) => blend(C.text, C.canvas, t);

  // ---------- diff ----------
  // In diff mode every node may carry st (A added, M modified, R renamed, D deleted), op (old path),
  // hk (hunks: [newStart, newLines, oldStart, oldLines]), ad / dl (lines added / removed).
  // Every link carries a state in e[4]: 0 in both, 1 added, 2 removed.
  const DIFF = !!raw.diff;
  const ST = {
    A: { c: C.added, name: 'Added' },
    M: { c: C.modified, name: 'Modified' },
    R: { c: C.renamed, name: 'Renamed' },
    D: { c: C.deleted, name: 'Deleted' },
  };
  const RADIUS = C.radius,
    LINKED = C.faint,
    ADD = C.added,
    DEL = C.deleted;
  const gone = (e) => e[4] === 2; // a link that only existed in the base

  // ---------- file types ----------
  const TYPES = {
    tsx: { name: 'React (TSX)', color: '#52d4ef' },
    ts: { name: 'TypeScript', color: '#3d8ef0' },
    py: { name: 'Python', color: '#5fbf87' },
    sql: { name: 'SQL', color: '#ec8f3e' },
    svg: { name: 'SVG', color: '#f19bc7' },
    img: { name: 'Images', color: '#ffc59a' },
    json: { name: 'JSON', color: '#c2a76d' },
    yml: { name: 'YAML', color: '#e5627a' },
    js: { name: 'JavaScript', color: '#e8d24a' },
    sh: { name: 'Shell', color: '#95a3b5' },
    dts: { name: 'Declarations', color: '#7d97c0' },
    css: { name: 'CSS', color: '#a882f5' },
    code: { name: 'Other code', color: '#9aa7b8' },
  };
  const KIND_LABEL = ['', 'type', 'dynamic', 're-export', 'vi.mock', 'asset URL'];
  const AMBER = C.warning;
  // Colours are mixed per card every frame, so each distinct one is built once.
  const colorMemo = new Map();
  const memoColor = (key, build) => {
    let value = colorMemo.get(key);
    if (value === undefined) {
      if (colorMemo.size > 4096) colorMemo.clear();
      value = build();
      colorMemo.set(key, value);
    }
    return value;
  };
  const mix = (hex, base, t) =>
    memoColor(`m${hex}${base}${t}`, () => {
      const a = parseInt(hex.slice(1), 16),
        b = parseInt(base.slice(1), 16);
      const c = (k) => Math.round(((b >> k) & 255) + (((a >> k) & 255) - ((b >> k) & 255)) * t);
      return `rgb(${c(16)},${c(8)},${c(0)})`;
    });
  const hexA = (hex, a) =>
    memoColor(`a${hex}${a}`, () => {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
    });

  // ---------- geometry ----------
  // Cards stay 200 wide for the filename; the code shape is a compact 120-wide column with a side rail for counts.
  // A code "page" is 1:2 (120 x 240), 160 lines. Longer files show a stack of pages behind the first one.
  // Each file is a floating stack: a dark name pill, its 1:2 code pages (160 lines each), and count pills underneath.
  const MMCOLS = 120,
    MW = 150,
    COLW = MW / MMCOLS,
    PAGE_H = MW * 2,
    PAGE_ROWS = 160,
    ROWH = PAGE_H / PAGE_ROWS;
  const SHEET = 4,
    MAX_SHEETS = 5,
    CW = MW + SHEET * MAX_SHEETS,
    NAME_H = 22,
    HEAD = NAME_H + 7,
    COUNT_H = 14,
    FOOT = 7 + COUNT_H;
  const MPAD = 12,
    GAP = 46,
    ASPECT = 4 / 3;
  const LH = 58,
    FP = 34,
    CG = 80;
  const imgBox = (n) => (n.iw && n.ih ? Math.max(48, Math.min(220, (MW * n.ih) / n.iw)) : MW);
  const hasPic = (n) => n.k === 'img' || n.k === 'svg';
  for (const n of N) {
    const sl = n.p.lastIndexOf('/');
    n.name = n.p.slice(sl + 1);
    n.dir = sl < 0 ? '' : n.p.slice(0, sl);
    if (!TYPES[n.k]) n.k = 'code';
    n.test =
      /\.(test|spec)\.[cm]?[jt]sx?$/.test(n.p) ||
      /^e2e\//.test(n.p) ||
      /(^|\/)(__tests__|__mocks__|tests?|testing|testUtils)\//.test(n.p) ||
      /(^|\/)test_[^/]+\.py$/.test(n.p);
    n.story = /\.stories\.[jt]sx?$/.test(n.p);
    // generated: a header marker found by the scan (@generated, DO NOT EDIT, pgtyped/codegen banners) or a known output path
    n.gen =
      !!n.g ||
      /(^|\/)(generated|__generated__|gql)\//.test(n.p) ||
      /(^|\/)schema\.sql$/.test(n.p) ||
      /\.queries\.ts$/.test(n.p);
    n.r = n.r || 0;
    n.s = n.s || 1;
    n.flip = false;
    if (hasPic(n)) n.box = imgBox(n);
  }
  const rpp = (n) => (n.s <= 2 ? PAGE_ROWS / n.s : PAGE_ROWS); // stored rows per page
  const rowHOf = (n) => PAGE_H / rpp(n); // world height of one stored row
  const linesPerPage = (n) => (n.s <= 2 ? PAGE_ROWS : Math.round(PAGE_ROWS * n.s));
  const pagesOf = (n) => Math.max(1, Math.ceil(n.r / rpp(n) - 1e-6));
  const sheetsOf = (n) => Math.min(MAX_SHEETS, pagesOf(n) - 1);
  const bodyH = (n) =>
    hasPic(n) ? n.box : Math.max(3 * ROWH, Math.min(n.r, rpp(n)) * rowHOf(n)) + sheetsOf(n) * SHEET;
  const H = new Float32Array(NN);
  N.forEach((n, i) => {
    H[i] = HEAD + bodyH(n) + FOOT;
  });

  let outE, inE;
  function rebuildAdj() {
    outE = Array.from({ length: NN }, () => []);
    inE = Array.from({ length: NN }, () => []);
    E.forEach((e, j) => {
      outE[e[0]].push(j);
      inE[e[1]].push(j);
    });
  }

  // ---------- state ----------
  const S = {
    sort: 'name',
    edges: 'focus',
    types: new Set(Object.keys(TYPES)),
    arrange: 'tiers',
    view: '3d',
    tests: false,
    gen: false, // tests and generated code start hidden
    typeEdges: true,
    mockEdges: false,
    isolated: true,
    through: true,
    svgCode: false,
    scope: '',
    deps: false,
    isolate: true,
    hops: 1,
    impact: null,
    show: 'all', // diff mode: 'radius' (changes + what depends on them), 'changes', 'all'
    depth: 1, // diff mode: how many import steps of dependents to show (99 = all)
    highlightChange: true,
  };
  // diff blast radius, over the whole graph regardless of filters:
  // DD = import steps from the nearest changed file (0 = changed, -1 = unaffected), DP = the link it came through,
  // DL = the far end of an added or removed import
  let DD = new Int32Array(NN).fill(-1),
    DP = new Int32Array(NN).fill(-1),
    DL = new Uint8Array(NN),
    blockCol = [];
  let vis = new Uint8Array(NN),
    ids = [],
    activeE = [],
    act = new Uint8Array(0),
    fin = new Int32Array(NN),
    fout = new Int32Array(NN),
    cyc = new Int32Array(NN);
  const X = new Float32Array(NN),
    Y = new Float32Array(NN),
    FX = new Float32Array(NN),
    FY = new Float32Array(NN),
    TX = new Float32Array(NN),
    TY = new Float32Array(NN);
  let frames = [],
    anim = null;
  let sel = -1,
    hov = -1,
    nb = null,
    nbE = null;
  const colorOf = N.map((n) => TYPES[n.k].color);
  let imp = null;
  const cam = { x: 0, y: 0, s: 0.05 };
  let camAnim = null,
    dirty = true,
    frameQueued = false,
    layoutRun = 0,
    firstLayout = true,
    lastThrough = null;

  // ---------- filtering ----------
  function edgeAllowed(k) {
    return k === 4 ? S.mockEdges : k === 1 ? S.typeEdges : true;
  }
  function computeDiffImpact() {
    DD.fill(-1);
    DP.fill(-1);
    DL.fill(0);
    if (!DIFF) return;
    const q = [];
    for (let i = 0; i < NN; i++)
      if (N[i].st) {
        DD[i] = 0;
        q.push(i);
      }
    // walk up the importers; a deleted file's former importers count too
    for (let h = 0; h < q.length; h++) {
      const v = q[h];
      for (const j of inE[v]) {
        const e = E[j];
        if (e[2] === 4 || (gone(e) && N[v].st !== 'D')) continue;
        const u = e[0];
        if (DD[u] < 0) {
          DD[u] = DD[v] + 1;
          DP[u] = j;
          q.push(u);
        }
      }
    }
    for (const e of E) if (e[4]) for (const u of [e[0], e[1]]) if (DD[u] < 0) DL[u] = 1;
  }
  // Off, a diff draws like a plain map: type colours, no fading, rings, status tags or new and removed imports.
  const highlightsChange = () => DIFF && S.highlightChange;
  function refreshBlockColors() {
    blockCol = highlightsChange() ? N.map((n, i) => diffColor(i)) : colorOf;
  }
  function diffColor(i) {
    const n = N[i];
    if (n.st) return ST[n.st].c;
    if (DD[i] > 0) return mix(RADIUS, C.canvas, Math.max(0.4, 1 - (DD[i] - 1) * 0.2));
    if (DL[i]) return LINKED;
    return sheet(0.14);
  }
  // Faded at least this far, a file is outside the change and its blast radius.
  const UNRELATED_FADE = 0.8;
  // How far a file sinks into the background in a diff: changed files not at all, the blast radius more with each step.
  function diffFade(i) {
    if (!highlightsChange() || DD[i] === 0) return 0;
    if (DD[i] > 0) return Math.min(0.6, 0.3 + 0.1 * (DD[i] - 1));
    return DL[i] ? 0.5 : UNRELATED_FADE;
  }
  // A changed file is ringed in its status colour, the blast radius in a fainter blue.
  function diffRing(i) {
    if (!highlightsChange()) return null;
    if (N[i].st) return ST[N[i].st].c;
    return DD[i] > 0 ? hexA(RADIUS, 0.6) : null;
  }
  function recompute(keepView) {
    if (lastThrough !== S.through) {
      E = S.through ? TE : RE;
      rebuildAdj();
      lastThrough = S.through;
      computeDiffImpact();
      refreshBlockColors();
    }
    vis.fill(0);
    // changed files show even when tests or generated code are hidden
    const pass = (n) => S.types.has(n.k) && ((DIFF && n.st) || ((S.tests || !n.test) && (S.gen || !n.gen)));
    const inDiff = (i) =>
      !DIFF || S.show === 'all' || DD[i] === 0 || (S.show === 'radius' && ((DD[i] > 0 && DD[i] <= S.depth) || DL[i]));
    for (let i = 0; i < NN; i++) {
      const n = N[i];
      if (pass(n) && inDiff(i) && (!S.scope || n.p.startsWith(S.scope))) vis[i] = 1;
    }
    if (S.scope && S.deps) {
      const add = [];
      for (let i = 0; i < NN; i++)
        if (vis[i] === 1)
          for (const j of outE[i]) {
            const e = E[j];
            if (edgeAllowed(e[2]) && !vis[e[1]] && pass(N[e[1]])) add.push(e[1]);
          }
      for (const i of add) vis[i] = 2;
    }
    act = new Uint8Array(E.length);
    fin.fill(0);
    fout.fill(0);
    for (let j = 0; j < E.length; j++) {
      const e = E[j];
      if (vis[e[0]] && vis[e[1]] && edgeAllowed(e[2])) {
        act[j] = 1; // removed links stay drawable, but don't count
        if (gone(e)) continue;
        fout[e[0]]++;
        fin[e[1]]++;
      }
    }
    if (!S.isolated) for (let i = 0; i < NN; i++) if (vis[i] && !fin[i] && !fout[i] && !(DIFF && N[i].st)) vis[i] = 0;
    ids = [];
    for (let i = 0; i < NN; i++) if (vis[i]) ids.push(i);
    activeE = [];
    for (let j = 0; j < E.length; j++) if (act[j]) activeE.push(j);
    computeSCC();
    imp = null;
    if (S.impact) {
      if (!vis[S.impact.root]) S.impact = null;
      else {
        const r = bfs(S.impact.root, S.impact.dir);
        imp = { ...S.impact, ...r };
        for (let i = 0; i < NN; i++) if (vis[i] && r.dist[i] < 0) vis[i] = 0;
        ids = ids.filter((i) => vis[i]);
        activeE = activeE.filter((j) => vis[E[j][0]] && vis[E[j][1]]);
      }
    }
    if (sel >= 0 && !vis[sel]) select(-1);
    else if (sel >= 0) computeNeighborhood();
    layout(keepView);
    updateStat();
    updateImpactBar();
  }
  function bfs(root, dir) {
    const dist = new Int32Array(NN).fill(-1),
      par = new Int32Array(NN).fill(-1);
    dist[root] = 0;
    const q = [root];
    for (let h = 0; h < q.length; h++) {
      const v = q[h];
      for (const j of dir === 'up' ? inE[v] : outE[v]) {
        if (!act[j] || gone(E[j])) continue;
        const u = dir === 'up' ? E[j][0] : E[j][1];
        if (dist[u] < 0) {
          dist[u] = dist[v] + 1;
          par[u] = j;
          q.push(u);
        }
      }
    }
    let max = 0;
    for (const v of q) max = Math.max(max, dist[v]);
    return { dist, par, count: q.length - 1, max, order: q };
  }

  function computeSCC() {
    const adj = Array.from({ length: NN }, () => []);
    for (const j of activeE) {
      const e = E[j];
      if (e[2] !== 1 && e[2] !== 5 && !gone(e)) adj[e[0]].push(e[1]);
    }
    const index = new Int32Array(NN).fill(-1),
      low = new Int32Array(NN),
      on = new Uint8Array(NN),
      comp = new Int32Array(NN).fill(-1);
    const stack = [];
    let idx = 0,
      c = 0;
    for (const s0 of ids) {
      if (index[s0] >= 0) continue;
      const cs = [[s0, 0]];
      index[s0] = low[s0] = idx++;
      stack.push(s0);
      on[s0] = 1;
      while (cs.length) {
        const fr = cs[cs.length - 1],
          v = fr[0],
          nbs = adj[v];
        if (fr[1] < nbs.length) {
          const w = nbs[fr[1]++];
          if (index[w] < 0) {
            index[w] = low[w] = idx++;
            stack.push(w);
            on[w] = 1;
            cs.push([w, 0]);
          } else if (on[w]) low[v] = Math.min(low[v], index[w]);
        } else {
          cs.pop();
          if (cs.length) {
            const u = cs[cs.length - 1][0];
            low[u] = Math.min(low[u], low[v]);
          }
          if (low[v] === index[v]) {
            let w;
            do {
              w = stack.pop();
              on[w] = 0;
              comp[w] = c;
            } while (w !== v);
            c++;
          }
        }
      }
    }
    const size = new Int32Array(c);
    for (const i of ids) size[comp[i]]++;
    cyc.fill(0);
    for (const i of ids) cyc[i] = size[comp[i]] > 1 ? size[comp[i]] : 0;
  }

  // ---------- sorting ----------
  const churn = (i) => (N[i].ad || 0) + (N[i].dl || 0) + (N[i].st ? 1 : 0);
  function fileCmp(pathFirst) {
    const by = S.sort;
    const nm = pathFirst
      ? (a, b) => N[a].p.localeCompare(N[b].p)
      : (a, b) => N[a].name.localeCompare(N[b].name) || N[a].p.localeCompare(N[b].p);
    if (by === 'lines') return (a, b) => N[b].l - N[a].l || N[b].b - N[a].b || nm(a, b);
    if (by === 'fin') return (a, b) => fin[b] - fin[a] || nm(a, b);
    if (by === 'fout') return (a, b) => fout[b] - fout[a] || nm(a, b);
    if (by === 'churn') return (a, b) => churn(b) - churn(a) || nm(a, b);
    if (by === 'type') return (a, b) => N[a].k.localeCompare(N[b].k) || nm(a, b);
    return nm;
  }
  function dirCmp() {
    const by = S.sort;
    if (by === 'lines') return (a, b) => b.lines - a.lines;
    if (by === 'fin') return (a, b) => b.fin - a.fin;
    if (by === 'fout') return (a, b) => b.fout - a.fout;
    if (by === 'churn') return (a, b) => b.churn - a.churn || b.lines - a.lines;
    return (a, b) => a.name.localeCompare(b.name);
  }
  function masonry(list, cols, cmp) {
    list.sort(cmp);
    const colH = new Float64Array(cols),
      pos = [];
    for (const i of list) {
      let c = 0;
      for (let k = 1; k < cols; k++) if (colH[k] < colH[c] - 0.5) c = k;
      pos.push(i, c * (CW + GAP), colH[c]);
      colH[c] += H[i] + GAP;
    }
    let h = 0;
    for (const v of colH) h = Math.max(h, v);
    return { pos, w: cols * (CW + GAP) - GAP, h: Math.max(0, h - GAP) };
  }
  const colsFor = (list, aspect) => {
    let a = 0;
    for (const i of list) a += (CW + GAP) * (H[i] + GAP);
    return Math.max(1, Math.min(list.length, Math.round(Math.sqrt(a * aspect) / (CW + GAP))));
  };

  // ---------- packing ----------
  function skyline(items, Wt) {
    const lim = Wt + CG;
    let segs = [{ x: 0, w: lim, y: 0 }];
    const pos = [];
    let W = 0,
      Hh = 0;
    for (const it of items) {
      const need = Math.min(lim, it.w + CG);
      let bi = -1,
        by = Infinity,
        bx = 0;
      for (let i = 0; i < segs.length; i++) {
        const x0 = segs[i].x;
        if (x0 + need > lim + 0.01) break;
        let y = 0,
          k = i,
          covered = 0;
        while (covered < need && k < segs.length) {
          y = Math.max(y, segs[k].y);
          covered = segs[k].x + segs[k].w - x0;
          k++;
        }
        if (covered < need - 0.01) break;
        if (y < by - 0.01) {
          by = y;
          bi = i;
          bx = x0;
        }
      }
      if (bi < 0) {
        bx = 0;
        by = Math.max(...segs.map((s) => s.y));
      }
      pos.push(bx, by);
      W = Math.max(W, bx + it.w);
      Hh = Math.max(Hh, by + it.h);
      const top = by + it.h + CG,
        x1 = bx + need,
        next = [];
      for (const sg of segs) {
        const s0 = sg.x,
          s1 = sg.x + sg.w;
        if (s1 <= bx || s0 >= x1) {
          next.push(sg);
          continue;
        }
        if (s0 < bx) next.push({ x: s0, w: bx - s0, y: sg.y });
        if (s1 > x1) next.push({ x: x1, w: s1 - x1, y: sg.y });
      }
      next.push({ x: bx, w: need, y: top });
      next.sort((a, b) => a.x - b.x);
      segs = [];
      for (const sg of next) {
        const l = segs[segs.length - 1];
        if (l && Math.abs(l.y - sg.y) < 0.01) l.w += sg.w;
        else segs.push(sg);
      }
    }
    return { pos, W, H: Hh };
  }
  function pack(items) {
    if (!items.length) return { W: 0, H: 0 };
    if (items.length === 1) {
      items[0].x = 0;
      items[0].y = 0;
      return { W: items[0].w, H: items[0].h };
    }
    const order = items.slice().sort((a, b) => b.h - a.h || b.w - a.w);
    let area = 0,
      maxW = 0,
      sumW = 0;
    for (const it of items) {
      area += (it.w + CG) * (it.h + CG);
      maxW = Math.max(maxW, it.w);
      sumW += it.w + CG;
    }
    const ideal = Math.sqrt(area * ASPECT),
      cands = new Set([maxW, Math.max(maxW, sumW - CG)]);
    for (let k = 0; k <= 14; k++) cands.add(Math.max(maxW, ideal * (0.6 + k * 0.1)));
    let best = null;
    for (const Wt of cands) {
      const r = skyline(order, Wt);
      const asp = r.W / Math.max(1, r.H);
      const dev = Math.log(asp / ASPECT);
      const score = r.W * r.H * (1 + (dev < 0 ? 1.4 : 0.5) * Math.abs(dev));
      if (!best || score < best.score) best = { score, r };
    }
    order.forEach((it, k) => {
      it.x = best.r.pos[k * 2];
      it.y = best.r.pos[k * 2 + 1];
    });
    return { W: best.r.W, H: best.r.H };
  }

  // tidy rows: the folder's own files first, then sub-folders tallest-first, top-aligned
  function shelf(items, gap, aspect = ASPECT) {
    if (!items.length) return { W: 0, H: 0 };
    const lead = items[0].m ? [items[0]] : [],
      rest = items.filter((it) => !lead.includes(it)).sort((a, b) => b.h - a.h || b.w - a.w),
      order = lead.concat(rest);
    let area = 0,
      maxW = 0,
      sumW = 0;
    for (const it of order) {
      area += (it.w + gap) * (it.h + gap);
      maxW = Math.max(maxW, it.w);
      sumW += it.w + gap;
    }
    const ideal = Math.sqrt(area * aspect),
      cands = new Set([maxW, sumW - gap]);
    for (let k = 0; k <= 20; k++) cands.add(Math.max(maxW, ideal * (0.6 + k * 0.1)));
    let best = null;
    for (const Wt of cands) {
      // rows of columns: a smaller folder stacks under a taller one when it fits the column, so rows stay aligned without big holes
      let x = 0,
        y = 0,
        rowH = 0,
        W = 0,
        cols = [];
      const pos = [];
      for (const it of order) {
        const col = cols.find((c) => it.w <= c.w + 0.5 && c.used + gap + it.h <= rowH + 0.5);
        if (col) {
          pos.push(col.x, y + col.used + gap);
          col.used += gap + it.h;
          continue;
        }
        if (x > 0 && x + it.w > Wt + 0.5) {
          x = 0;
          y += rowH + gap;
          rowH = 0;
          cols = [];
        }
        pos.push(x, y);
        cols.push({ x, w: it.w, used: it.h });
        x += it.w + gap;
        rowH = Math.max(rowH, it.h);
        W = Math.max(W, x - gap);
      }
      const Hh = y + rowH,
        dev = Math.log(W / Math.max(1, Hh) / aspect);
      const score = W * Hh * (1 + (dev < 0 ? 1.4 : 0.6) * Math.abs(dev));
      if (!best || score < best.score) best = { score, pos, W, H: Hh };
    }
    order.forEach((it, k) => {
      it.x = best.pos[k * 2];
      it.y = best.pos[k * 2 + 1];
    });
    return { W: best.W, H: best.H };
  }
  // spacing between areas shrinks for small repos so they don't float apart
  const SP = Math.max(0.3, Math.min(1, Math.sqrt(NN / 4000)));
  const folderGap = (depth) => (depth === 0 ? 1200 : depth === 1 ? 640 : depth === 2 ? 420 : 300) * SP;
  const folderPad = (depth) => (depth <= 1 ? 200 : 130);
  const FLH = 100,
    FOLDER_ASPECT = 2.6; // folders lean wide so the map reads left-to-right

  // ---------- layouts ----------
  function layoutFolders() {
    const root = { name: REPO, path: '', kids: new Map(), files: [] };
    for (const i of ids) {
      const parts = N[i].p.split('/');
      let d = root;
      for (let k = 0; k < parts.length - 1; k++) {
        let c = d.kids.get(parts[k]);
        if (!c) {
          c = {
            name: parts[k],
            path: parts.slice(0, k + 1).join('/'),
            kids: new Map(),
            files: [],
          };
          d.kids.set(parts[k], c);
        }
        d = c;
      }
      d.files.push(i);
    }
    (function compress(d) {
      for (const [k, c] of d.kids) {
        let cc = c;
        while (cc.files.length === 0 && cc.kids.size === 1) {
          const only = cc.kids.values().next().value;
          only.name = cc.name + '/' + only.name;
          cc = only;
        }
        d.kids.set(k, cc);
        compress(cc);
      }
    })(root);
    function agg(d) {
      d.lines = 0;
      d.count = 0;
      d.fin = 0;
      d.fout = 0;
      d.churn = 0;
      for (const i of d.files) {
        d.churn += churn(i);
        d.lines += N[i].l;
        d.count++;
        d.fin += fin[i];
        d.fout += fout[i];
      }
      for (const c of d.kids.values()) {
        agg(c);
        d.lines += c.lines;
        d.count += c.count;
        d.fin += c.fin;
        d.fout += c.fout;
        d.churn += c.churn;
      }
    }
    agg(root);
    const fc = fileCmp(false),
      dc = dirCmp();
    function lay(d, depth) {
      const items = [];
      if (d.files.length) {
        const m = masonry(d.files.slice(), colsFor(d.files, FOLDER_ASPECT), fc);
        items.push({ w: m.w, h: m.h, m });
      }
      const kids = [...d.kids.values()];
      for (const c of kids) lay(c, depth + 1);
      kids.sort(dc);
      for (const c of kids) items.push({ w: c.w, h: c.h, dir: c });
      const r = shelf(items, folderGap(depth), FOLDER_ASPECT),
        fp = depth === 0 ? 0 : folderPad(depth),
        lh = depth === 0 ? 0 : FLH;
      d.items = items;
      d.depth = depth;
      d.fp = fp;
      d.lh = lh;
      d.w = r.W + fp * 2;
      d.h = r.H + fp * 2 + lh;
    }
    lay(root, 0);
    const fr = [];
    function place(d, ox, oy) {
      fr.push({
        x: ox,
        y: oy,
        w: d.w,
        h: d.h,
        name: d.depth === 0 ? REPO : d.label || d.name,
        path: d.path,
        depth: d.unit ? 1 : d.depth,
        count: d.count,
        lines: d.lines,
      });
      for (const it of d.items) {
        const ix = ox + d.fp + it.x,
          iy = oy + d.lh + d.fp + it.y;
        if (it.m) {
          const p = it.m.pos;
          for (let k = 0; k < p.length; k += 3) {
            TX[p[k]] = ix + p[k + 1];
            TY[p[k]] = iy + p[k + 2];
          }
        } else place(it.dir, ix, iy);
      }
    }
    if (S.arrange !== 'tiers') {
      place(root, 0, 0);
      return fr.filter((f) => f.depth > 0);
    } // no frame around the whole repo

    // ---- dependency tiers: areas everyone imports sit on top, the areas built on them line up below
    const units = [];
    const pseudo = (label, files, depth) => {
      const d = { name: label, label, path: label, kids: new Map(), files };
      agg(d);
      lay(d, depth);
      units.push(d);
    };
    if (root.files.length) pseudo('repo root', root.files, 1);
    for (const c of root.kids.values()) {
      if (CONT.has(c.name) && c.kids.size) {
        for (const u of c.kids.values()) {
          u.label = c.name + '/' + u.name;
          units.push(u);
        }
        if (c.files.length) pseudo(c.name, c.files, 2);
      } else units.push(c);
    }
    for (const u of units) u.unit = true;
    const U = units.length,
      uOf = new Int32Array(NN).fill(-1);
    units.forEach((u, k) => {
      (function mark(d) {
        for (const i of d.files) uOf[i] = k;
        for (const c of d.kids.values()) mark(c);
      })(u);
    });
    const W = Array.from({ length: U }, () => new Map()),
      outT = new Float64Array(U),
      inT = new Float64Array(U);
    for (const j of activeE) {
      const [a, b, t] = E[j];
      if (t === 4 || gone(E[j])) continue;
      const ua = uOf[a],
        ub = uOf[b];
      if (ua < 0 || ub < 0 || ua === ub) continue;
      W[ua].set(ub, (W[ua].get(ub) || 0) + 1);
      outT[ua]++;
      inT[ub]++;
    }
    // ignore stray imports: a link between areas counts at 10+ imports, or 3+ that are 3%+ of the importer's outgoing links.
    // When two areas import each other, the much weaker direction (4x+ smaller) is treated as a back-reference, not a dependency.
    // small repos have few links, so any link between areas counts there
    let cross = 0;
    for (const t of outT) cross += t;
    const minW = cross < 300 ? 1 : 3;
    const sig = (u, v, w) => (w >= 10 || (w >= minW && w >= outT[u] * 0.03)) && !((W[v].get(u) || 0) >= w * 4);
    const adj = W.map((m, u) => [...m].filter(([v, w]) => sig(u, v, w)).map(([v]) => v));
    const sigIn = new Int32Array(U);
    for (const l of adj) for (const v of l) sigIn[v]++;
    // collapse cycles, then tier = longest chain of imports down to a foundation
    const idx = new Int32Array(U).fill(-1),
      low = new Int32Array(U),
      on = new Uint8Array(U),
      comp = new Int32Array(U);
    const st = [];
    let n0 = 0,
      nc = 0;
    const strong = (v) => {
      idx[v] = low[v] = n0++;
      st.push(v);
      on[v] = 1;
      for (const w of adj[v]) {
        if (idx[w] < 0) {
          strong(w);
          low[v] = Math.min(low[v], low[w]);
        } else if (on[w]) low[v] = Math.min(low[v], idx[w]);
      }
      if (low[v] === idx[v]) {
        let w;
        do {
          w = st.pop();
          on[w] = 0;
          comp[w] = nc;
        } while (w !== v);
        nc++;
      }
    };
    for (let u = 0; u < U; u++) if (idx[u] < 0) strong(u);
    const cadj = Array.from({ length: nc }, () => new Set());
    adj.forEach((l, u) => {
      for (const v of l) if (comp[u] !== comp[v]) cadj[comp[u]].add(comp[v]);
    });
    const memo = new Int32Array(nc).fill(-1);
    const height = (c) => {
      if (memo[c] >= 0) return memo[c];
      let h = 0;
      for (const d of cadj[c]) h = Math.max(h, height(d) + 1);
      memo[c] = h;
      return h;
    };
    const tier = units.map((u, k) => (!adj[k].length && !sigIn[k] ? -1 : height(comp[k])));
    const maxT = Math.max(0, ...tier);
    const rows = [];
    for (let t = 0; t <= maxT; t++) rows.push(units.map((u, k) => k).filter((k) => tier[k] === t));
    const lone = units.map((u, k) => k).filter((k) => tier[k] < 0);
    const cx = new Float64Array(U),
      GX_ = 1200 * SP,
      GY_ = Math.max(1000, 2400 * SP);
    let y = 0;
    const placeRow = (list, title, sub) => {
      if (!list.length) return;
      let wsum = 0,
        hmax = 0;
      for (const k of list) {
        wsum += units[k].w;
        hmax = Math.max(hmax, units[k].h);
      }
      wsum += GX_ * (list.length - 1);
      let x = -wsum / 2;
      fr.push({
        x,
        y: y - 520,
        w: wsum,
        h: hmax + 520,
        name: title,
        sub,
        depth: 0,
        tier: true,
        count: list.reduce((s, k) => s + units[k].count, 0),
        lines: list.reduce((s, k) => s + units[k].lines, 0),
      });
      for (const k of list) {
        place(units[k], x, y);
        cx[k] = x + units[k].w / 2;
        x += units[k].w + GX_;
      }
      y += hmax + GY_;
    };
    rows.forEach((list, t) => {
      if (t === 0) list.sort((a, b) => inT[b] - inT[a] || units[b].count - units[a].count);
      else {
        // sit each area under the areas it imports from (weighted average x)
        const bc = (k) => {
          let sw = 0,
            sx = 0;
          for (const [v, w] of W[k])
            if (tier[v] >= 0 && tier[v] < t) {
              sw += w;
              sx += w * cx[v];
            }
          return sw ? sx / sw : 0;
        };
        const b = new Map(list.map((k) => [k, bc(k)]));
        list.sort((p, q) => b.get(p) - b.get(q));
      }
      const names = list.map((k) => units[k].label || units[k].name);
      placeRow(
        list,
        t === 0 ? 'Shared foundations' : `Level ${t}`,
        t === 0
          ? 'imported by the levels below'
          : `imports from the levels above · ${names.length} area${names.length > 1 ? 's' : ''}`,
      );
    });
    lone.sort((a, b) => units[b].count - units[a].count);
    placeRow(lone, 'Standalone', 'no imports to or from other areas');
    return fr;
  }

  function layoutImpact() {
    const rows = [];
    for (const i of ids) {
      const d = imp.dist[i];
      if (!rows[d]) rows[d] = [];
      rows[d].push(i);
    }
    let total = 0;
    for (const i of ids) total += (CW + GAP) * (H[i] + GAP);
    const maxCols = Math.max(4, Math.floor(Math.sqrt(total * 2.4) / (CW + GAP)));
    const cmp = fileCmp(true),
      fr = [];
    let y = 0;
    const up = imp.dir === 'up';
    rows.forEach((list, d) => {
      if (!list) return;
      const m = masonry(list, Math.min(list.length, maxCols), cmp),
        w = m.w + FP * 2,
        x0 = -w / 2;
      const title =
        d === 0 ? N[imp.root].name : d === 1 ? (up ? 'Imports it directly' : 'Imported directly') : `${d} steps away`;
      const sub =
        d === 0
          ? up
            ? 'everything below depends on this file'
            : 'everything below is pulled in by this file'
          : up
            ? 'affected by a change'
            : 'needed to build it';
      fr.push({
        x: x0,
        y,
        w,
        h: m.h + LH + FP * 2,
        name: title,
        sub,
        depth: 1,
        band: true,
        count: list.length,
        lines: list.reduce((s, i) => s + N[i].l, 0),
        color: d === 0 ? C.bright : null,
      });
      const p = m.pos;
      for (let k = 0; k < p.length; k += 3) {
        TX[p[k]] = x0 + FP + p[k + 1];
        TY[p[k]] = y + LH + FP + p[k + 2];
      }
      y += m.h + LH + FP * 2 + 260;
    });
    return fr;
  }

  function layout(keepView) {
    for (const i of ids) {
      FX[i] = X[i];
      FY[i] = Y[i];
    }
    const wasVis = layout.wasVis || new Uint8Array(NN);
    frames = imp ? layoutImpact() : layoutFolders();
    frames.sort((a, b) => a.depth - b.depth);
    for (const i of ids)
      if (!wasVis[i] || firstLayout) {
        FX[i] = TX[i];
        FY[i] = TY[i];
      }
    layout.wasVis = vis.slice();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (firstLayout || reduce) {
      for (const i of ids) {
        X[i] = TX[i];
        Y[i] = TY[i];
      }
      anim = null;
    } else anim = { t0: performance.now(), dur: 700 };
    buildNav();
    if (!keepView) firstLayout && DIFF ? fitChange() : fitAll(!firstLayout);
    firstLayout = false;
    layoutRun++;
    invalidate();
  }
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  function bounds() {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const f of frames) {
      x0 = Math.min(x0, f.x);
      y0 = Math.min(y0, f.y);
      x1 = Math.max(x1, f.x + f.w);
      y1 = Math.max(y1, f.y + f.h);
    }
    for (const i of ids) {
      x0 = Math.min(x0, TX[i]);
      y0 = Math.min(y0, TY[i]);
      x1 = Math.max(x1, TX[i] + CW);
      y1 = Math.max(y1, TY[i] + H[i]);
    }
    if (!isFinite(x0)) return { x: 0, y: 0, w: 1000, h: 1000 };
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // ---------- camera ----------
  const cv = $('#cv');
  let ctx = cv.getContext('2d');
  let dpr = 1,
    VW = 0,
    VH = 0;
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    VW = cv.clientWidth;
    VH = cv.clientHeight;
    cv.width = Math.round(VW * dpr);
    cv.height = Math.round(VH * dpr);
    invalidate();
  }
  window.addEventListener('resize', resize);
  // Chromium hands the map back blank after its GPU process restarts.
  cv.addEventListener('contextrestored', () => {
    invalidate();
  });
  const MINS = 0.002,
    MAXS = 8;
  function fitRect(r, animate, pad = 60, maxS = 1.6) {
    let rx = r.x,
      ry = r.y,
      rw = r.w,
      rh = r.h;
    if (is3D()) {
      trig();
      const pts = [
        [r.x, r.y],
        [r.x + r.w, r.y],
        [r.x, r.y + r.h],
        [r.x + r.w, r.y + r.h],
      ].map(([x, y]) => unit(x, y));
      const xs = pts.map((p) => p[0]),
        ys = pts.map((p) => p[1]);
      rx = Math.min(...xs);
      rw = Math.max(...xs) - rx;
      ry = Math.min(...ys) - (r.zPad ?? 300) * T.st;
      rh = Math.max(...ys) - ry;
    }
    const top = $('#bar').getBoundingClientRect().bottom,
      AH = VH - top;
    const s = Math.max(MINS, Math.min(maxS, Math.min((VW - pad * 2) / rw, (AH - pad * 2) / rh)));
    const t = {
      s,
      x: VW / 2 - (rx + rw / 2) * s,
      y: top + AH / 2 - (ry + rh / 2) * s,
    };
    if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches)
      camAnim = { from: { ...cam }, to: t, t0: performance.now(), dur: 560 };
    else {
      Object.assign(cam, t);
      camAnim = null;
    }
    invalidate();
  }
  // A diff opens on what changed and what imports it, with the rest of the repo around them.
  function fitChange() {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const i of ids) {
      if (DD[i] < 0) continue;
      x0 = Math.min(x0, TX[i]);
      y0 = Math.min(y0, TY[i]);
      x1 = Math.max(x1, TX[i] + CW);
      y1 = Math.max(y1, TY[i] + H[i]);
    }
    if (isFinite(x0)) fitRect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, false, 70);
    else fitAll(false);
  }
  function fitAll(animate) {
    const b = bounds();
    if (imp) {
      b.y -= b.h * 0.12 + 60;
      b.h += b.h * 0.12 + 60;
    }
    fitRect(b, animate, 70);
  }
  function zoomAt(px, py, f) {
    const s = Math.max(MINS, Math.min(MAXS, cam.s * f));
    const k = s / cam.s;
    cam.x = px - (px - cam.x) * k;
    cam.y = py - (py - cam.y) * k;
    cam.s = s;
    camAnim = null;
    invalidate();
  }
  const FLY_TO_SCALE = 0.5;
  function flyTo(i) {
    if (i < 0) return;
    fitRect(
      {
        x: TX[i] - 60,
        y: TY[i] - 60,
        w: CW + 120,
        h: H[i] + 120,
        zPad: towerZ(N[i]) + 80,
      },
      true,
      40,
      Math.max(FLY_TO_SCALE, cam.s),
    );
  }

  // ---------- code-shape bitmaps ----------
  let MM = null;
  // Identifier, keyword, string, comment, number, type, punctuation, in the design system's hues.
  const CLS = [
    null,
    C.dim,
    token('--tk-purple', '#c792ea'),
    C.green,
    blend(C.faint, C.canvas, 0.75),
    C.importedBy,
    C.warning,
    C.imports,
  ];
  const CLSA = [0, 0.9, 1, 1, 1, 1, 1, 0.7];
  const PX32 = CLS.map((c, k) => {
    if (!c) return 0;
    const n = parseInt(c.slice(1), 16);
    const a = Math.round(CLSA[k] * 255);
    return ((a << 24) | ((n & 255) << 16) | (((n >> 8) & 255) << 8) | (n >> 16)) >>> 0;
  });
  const hiCache = new Map();
  let hiPx = 0;
  const HI_BUDGET = 18e6;
  const loCache = new Map();
  // Chromium blanks every canvas when its GPU process restarts, so a canvas painted once is painted again then.
  function keepPainted(canvas, paint) {
    paint();
    canvas.addEventListener('contextrestored', () => {
      paint();
      invalidate();
    });
  }
  function decodeInto(i, w, shift) {
    const c = document.createElement('canvas');
    keepPainted(c, () => paintShape(c, i, w, shift));
    return c;
  }
  function paintShape(c, i, w, shift) {
    const n = N[i],
      h = Math.max(1, Math.ceil(Math.max(1, n.r) / (1 << shift)));
    c.width = w;
    c.height = h;
    const g = c.getContext('2d'),
      img = g.createImageData(w, h),
      px = new Uint32Array(img.data.buffer);
    let p = n.o;
    for (let r = 0; r < n.r; r++) {
      const cnt = MM[p++];
      let col = 0;
      const yy = (r >> shift) * w;
      for (let k = 0; k < cnt; k++) {
        const b = MM[p++],
          c2 = b >> 5,
          len = (b & 31) + 1;
        if (c2) {
          const a = col >> shift,
            z = Math.min(w, ((col + len - 1) >> shift) + 1);
          const v = PX32[c2];
          for (let x = a; x < z; x++) px[yy + x] = v;
        }
        col += len;
      }
    }
    g.putImageData(img, 0, 0);
  }
  function hiBitmap(i) {
    let c = hiCache.get(i);
    if (c) {
      hiCache.delete(i);
      hiCache.set(i, c);
      return c;
    }
    c = decodeInto(i, MMCOLS, 0);
    hiCache.set(i, c);
    hiPx += c.width * c.height;
    while (hiPx > HI_BUDGET && hiCache.size > 1) {
      const [k, v] = hiCache.entries().next().value;
      if (k === sel) {
        hiCache.delete(k);
        hiCache.set(k, v);
        continue;
      }
      hiCache.delete(k);
      hiPx -= v.width * v.height;
    }
    return c;
  }
  function loBitmap(i) {
    let c = loCache.get(i);
    if (!c) {
      c = decodeInto(i, MMCOLS >> 2, 2);
      loCache.set(i, c);
    }
    return c;
  }
  let mmBudget = 0,
    mmDeadline = 0;
  // Decoding code shapes is capped per frame by count and by time, so a fast zoom spreads it over frames instead of stalling one.
  const DECODE_MS = 4;
  const mayDecode = () => mmBudget-- > 0 && performance.now() < mmDeadline;
  async function loadMinimaps() {
    try {
      const b64 = CODEMAP.shapes;
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
      if (!('DecompressionStream' in window)) throw new Error('no DecompressionStream');
      const buf = await new Response(
        new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip')),
      ).arrayBuffer();
      MM = new Uint8Array(buf);
      updateStat();
      invalidate();
      if (sel >= 0) renderDetail();
    } catch (e) {
      loadMinimaps.failed = true;
      updateStat();
    }
  }

  // ---------- pictures ----------
  let THUMBS = null,
    SVGS = null;
  const picCache = new Map();
  async function loadPictures() {
    try {
      // SVG sources are inlined; raster images load from the repo on disk, or are embedded for other refs
      SVGS = CODEMAP.svgs;
      THUMBS = {};
      for (const n of N)
        if (n.k === 'img')
          THUMBS[n.p] = {
            w: n.iw || 0,
            h: n.ih || 0,
            d: n.u || null,
          };
      invalidate();
      if (sel >= 0) renderDetail();
    } catch (e) {
      loadPictures.failed = true;
    }
  }
  function svgSrc(t, n) {
    t = t.replace(/currentColor/g, C.text);
    const w = n.iw || 24,
      h = n.ih || 24,
      sc = 512 / Math.max(w, h),
      W = Math.round(w * sc),
      Hh = Math.round(h * sc);
    t = t.replace(/<svg\b([^>]*)>/, (m, attrs) => {
      const hadVB = /viewBox/i.test(attrs);
      attrs = attrs.replace(/\s(width|height)\s*=\s*["'][^"']*["']/g, '');
      return `<svg${attrs}${hadVB ? '' : ` viewBox="0 0 ${w} ${h}"`} width="${W}" height="${Hh}">`;
    });
    if (!/xmlns=/.test(t)) t = t.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(t);
  }
  function picSrc(i) {
    const n = N[i];
    if (n.k === 'img') return THUMBS && THUMBS[n.p] ? THUMBS[n.p].d : null;
    if (n.k === 'svg') return SVGS && SVGS[n.p] ? svgSrc(SVGS[n.p], n) : null;
    return null;
  }
  function picture(i) {
    let im = picCache.get(i);
    if (im) return im.complete && im.naturalWidth ? im : null;
    const src = picSrc(i);
    if (!src) return null;
    im = new Image();
    im.decoding = 'async';
    im.onload = () => {
      invalidate();
    };
    im.src = src;
    picCache.set(i, im);
    return null;
  }
  const codeView = (n) => n.k === 'svg' && S.svgCode !== n.flip;
  let checker = null;
  function checkerPattern() {
    if (checker) return checker;
    const c = document.createElement('canvas');
    c.width = c.height = 12;
    const g = c.getContext('2d');
    g.fillStyle = sheet(0.06);
    g.fillRect(0, 0, 12, 12);
    g.fillStyle = sheet(0.11);
    g.fillRect(0, 0, 6, 6);
    g.fillRect(6, 6, 6, 6);
    checker = ctx.createPattern(c, 'repeat');
    return checker;
  }
  // rows the card shows, and whether the file runs past them
  const isCodeCard = (n) => !hasPic(n) || codeView(n);
  const multiPage = (n) => !hasPic(n) && pagesOf(n) > 1;
  // selected multi-page files spread their pages out in a 4:3 grid on top of the canvas
  const PG_GAP = 14,
    PG_LABEL = 14;
  function spreadRect(i) {
    const n = N[i];
    if (!multiPage(n)) return { x: X[i], y: Y[i], w: CW, h: H[i], cols: 1, P: 1 };
    const P = pagesOf(n),
      cols = Math.max(2, Math.ceil(Math.sqrt(P * 2 * ASPECT))),
      rows = Math.ceil(P / Math.min(cols, P)),
      c = Math.min(cols, P);
    return {
      x: X[i] - MPAD,
      y: Y[i] - MPAD,
      w: Math.max(CW, MPAD * 2 + c * (MW + PG_GAP) - PG_GAP),
      h: MPAD + HEAD + rows * (PAGE_H + PG_LABEL + PG_GAP) - PG_GAP + MPAD,
      cols: c,
      P,
    };
  }
  // ---------- icons ----------
  function rr(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }
  function txt(t, x, y, size, color, weight = 700) {
    ctx.font = `${weight} ${size}px "Geist Mono Variable", ui-monospace, monospace`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t, x, y);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
  // The toolbar's folder glyph, on the design system's 16-unit icon grid.
  const FOLDER_GLYPH = new Path2D('M2.25 3.75h4.25l1.5 1.5h5.75v7H2.25z');
  const isFolder = (f) => !f.tier && !f.band;
  function drawFolderIcon(x, y, size, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 16, size / 16);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    ctx.stroke(FOLDER_GLYPH);
    ctx.restore();
  }
  function drawIcon(n, x, y, S2) {
    const c = TYPES[n.k].color,
      cx = x + S2 / 2,
      cy = y + S2 / 2;
    switch (n.k) {
      case 'tsx': {
        ctx.strokeStyle = c;
        ctx.lineWidth = 1.2;
        for (let a = 0; a < 3; a++) {
          ctx.beginPath();
          ctx.ellipse(cx, cy, S2 * 0.47, S2 * 0.18, (a * Math.PI) / 3, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(cx, cy, S2 * 0.1, 0, 7);
        ctx.fill();
        break;
      }
      case 'ts':
        rr(x, y, S2, S2, 3);
        ctx.fillStyle = c;
        ctx.fill();
        txt('TS', cx + 1.5, cy + 2.5, S2 * 0.45, '#0b1424');
        break;
      case 'js':
        rr(x, y, S2, S2, 3);
        ctx.fillStyle = c;
        ctx.fill();
        txt('JS', cx + 1.5, cy + 2.5, S2 * 0.45, '#1d1a05');
        break;
      case 'dts':
        rr(x + 0.6, y + 0.6, S2 - 1.2, S2 - 1.2, 3);
        ctx.strokeStyle = c;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        txt('d', cx, cy, S2 * 0.6, c);
        break;
      case 'py': {
        rr(x + 1, y + 1, S2 * 0.62, S2 * 0.55, 3);
        ctx.fillStyle = '#3f7cc0';
        ctx.fill();
        rr(x + S2 * 0.38 - 1, y + S2 * 0.45 - 1, S2 * 0.62, S2 * 0.55, 3);
        ctx.fillStyle = '#f5cd46';
        ctx.fill();
        ctx.fillStyle = '#e7eaf0';
        ctx.beginPath();
        ctx.arc(x + S2 * 0.27, y + S2 * 0.25, 1.2, 0, 7);
        ctx.fill();
        ctx.fillStyle = '#3a2f07';
        ctx.beginPath();
        ctx.arc(x + S2 * 0.73, y + S2 * 0.76, 1.2, 0, 7);
        ctx.fill();
        break;
      }
      case 'sql': {
        ctx.strokeStyle = c;
        ctx.fillStyle = hexA(c, 0.25);
        ctx.lineWidth = 1.2;
        const w = S2 * 0.4,
          top = y + 3,
          bot = y + S2 - 3;
        ctx.beginPath();
        ctx.ellipse(cx, bot, w, 2.6, 0, 0, Math.PI);
        ctx.lineTo(cx - w, top);
        ctx.ellipse(cx, top, w, 2.6, 0, Math.PI, 0, true);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(cx, top, w, 2.6, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(cx, (top + bot) / 2, w, 2.6, 0, 0, Math.PI);
        ctx.stroke();
        break;
      }
      case 'json':
        txt('{}', cx, cy + 0.5, S2 * 0.72, c);
        break;
      case 'css':
        txt('#', cx, cy + 0.5, S2 * 0.8, c);
        break;
      case 'sh':
        rr(x, y, S2, S2, 3);
        ctx.fillStyle = sheet(0.08);
        ctx.fill();
        ctx.strokeStyle = c;
        ctx.lineWidth = 0.8;
        ctx.stroke();
        txt('>_', cx, cy + 0.5, S2 * 0.45, c);
        break;
      case 'yml': {
        ctx.strokeStyle = c;
        ctx.lineWidth = 1.6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        [
          [2, 4, 15],
          [6, 9, 15],
          [6, 14, 13],
        ].forEach(([a, yy, b]) => {
          ctx.moveTo(x + (a * S2) / 18, y + (yy * S2) / 18);
          ctx.lineTo(x + (b * S2) / 18, y + (yy * S2) / 18);
        });
        ctx.stroke();
        ctx.lineCap = 'butt';
        break;
      }
      case 'svg': {
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.moveTo(x + 2, y + S2 - 2);
        ctx.lineTo(x + S2 * 0.45, y + 3);
        ctx.lineTo(x + S2 * 0.82, y + S2 - 2);
        ctx.closePath();
        ctx.globalAlpha *= 0.55;
        ctx.fill();
        ctx.globalAlpha /= 0.55;
        ctx.beginPath();
        ctx.arc(x + S2 * 0.68, y + S2 * 0.38, S2 * 0.2, 0, 7);
        ctx.fill();
        break;
      }
      case 'img': {
        rr(x + 0.7, y + 2, S2 - 1.4, S2 - 4, 2.5);
        ctx.strokeStyle = c;
        ctx.lineWidth = 1.3;
        ctx.stroke();
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(x + S2 * 0.68, y + S2 * 0.36, 1.7, 0, 7);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x + 2.5, y + S2 - 4);
        ctx.lineTo(x + S2 * 0.4, y + S2 * 0.45);
        ctx.lineTo(x + S2 * 0.62, y + S2 * 0.7);
        ctx.lineTo(x + S2 * 0.75, y + S2 * 0.58);
        ctx.lineTo(x + S2 - 2.5, y + S2 - 4);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'code': {
        rr(x + 0.6, y + 0.6, S2 - 1.2, S2 - 1.2, 3);
        ctx.strokeStyle = c;
        ctx.lineWidth = 1.1;
        ctx.stroke();
        const ext = n.p.split('.').pop().slice(0, 3).toUpperCase();
        txt(ext, cx, cy + 0.5, S2 * (ext.length > 2 ? 0.32 : 0.42), c);
        break;
      }
    }
    const bx = x + S2 - 1,
      by = y + S2 - 1;
    if (n.test) {
      ctx.fillStyle = C.chrome;
      ctx.beginPath();
      ctx.arc(bx, by, 5, 0, 7);
      ctx.fill();
      ctx.fillStyle = C.green;
      ctx.beginPath();
      ctx.moveTo(bx - 1.3, by - 3.6);
      ctx.lineTo(bx + 1.3, by - 3.6);
      ctx.lineTo(bx + 1.3, by - 1);
      ctx.lineTo(bx + 3.4, by + 3);
      ctx.lineTo(bx - 3.4, by + 3);
      ctx.lineTo(bx - 1.3, by - 1);
      ctx.closePath();
      ctx.fill();
    } else if (n.story) {
      ctx.fillStyle = C.chrome;
      ctx.beginPath();
      ctx.arc(bx, by, 5, 0, 7);
      ctx.fill();
      ctx.fillStyle = C.pink;
      ctx.beginPath();
      ctx.moveTo(bx - 2.6, by - 3.6);
      ctx.lineTo(bx + 2.6, by - 3.6);
      ctx.lineTo(bx + 2.6, by + 3.6);
      ctx.lineTo(bx, by + 1.8);
      ctx.lineTo(bx - 2.6, by + 3.6);
      ctx.closePath();
      ctx.fill();
    } else if (n.gen) {
      ctx.fillStyle = C.chrome;
      ctx.beginPath();
      ctx.arc(bx, by, 5, 0, 7);
      ctx.fill();
      ctx.strokeStyle = C.dim;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(bx, by, 2.6, 0, 7);
      ctx.stroke();
      for (let a = 0; a < 6; a++) {
        const t = (a * Math.PI) / 3;
        ctx.beginPath();
        ctx.moveTo(bx + Math.cos(t) * 2.6, by + Math.sin(t) * 2.6);
        ctx.lineTo(bx + Math.cos(t) * 4.2, by + Math.sin(t) * 4.2);
        ctx.stroke();
      }
    }
  }

  // ---------- text helpers ----------
  const NAME_FONT = '600 11.5px "Geist Mono Variable", ui-monospace, monospace';
  const fmtL = (l) =>
    l >= 1e6
      ? (l / 1e6).toFixed(1) + 'M'
      : l >= 1e4
        ? Math.round(l / 1e3) + 'k'
        : l >= 1e3
          ? (l / 1e3).toFixed(1) + 'k'
          : String(l);
  const fmtB = (b) =>
    b >= 1048576 ? (b / 1048576).toFixed(1) + 'M' : b >= 1024 ? Math.round(b / 1024) + 'K' : b + 'B';
  let truncCache = new Map();
  function truncName(i) {
    // -> [text, width]
    let t = truncCache.get(i);
    if (t !== undefined) return t;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = NAME_FONT;
    const max = CW - 34;
    let s = N[i].name;
    if (ctx.measureText(s).width > max) {
      let lo = 1,
        hi = s.length;
      while (lo < hi) {
        const m = (lo + hi + 1) >> 1;
        if (ctx.measureText(s.slice(0, m) + '…').width <= max) lo = m;
        else hi = m - 1;
      }
      s = s.slice(0, lo) + '…';
    }
    t = [s, ctx.measureText(s).width];
    ctx.restore();
    truncCache.set(i, t);
    return t;
  }
  // Labels and their widths repeat frame after frame, so each is formatted and measured once.
  const numberMemo = new Map();
  const fmtN = (value) => {
    let text = numberMemo.get(value);
    if (text === undefined) numberMemo.set(value, (text = value.toLocaleString()));
    return text;
  };
  let widthMemo = new Map();
  function textWidth(font, text) {
    const key = font + '\n' + text;
    let width = widthMemo.get(key);
    if (width === undefined) {
      if (widthMemo.size > 8192) widthMemo.clear();
      const saved = ctx.font;
      ctx.font = font;
      width = ctx.measureText(text).width;
      ctx.font = saved;
      widthMemo.set(key, width);
    }
    return width;
  }
  const sizeLabel = (n) => (n.k === 'img' ? fmtB(n.b) : fmtL(n.l));
  const toggleRect = (i) => [X[i] + CW - 32, Y[i] + H[i] - COUNT_H, 32, COUNT_H];

  // ---------- drawing ----------
  // How far a card's change gutter, status tag and rings reach past it, before their strokes.
  const CARD_REACH = 26;
  const CARD = C.raised,
    PILL = C.chrome,
    PILL_LINE = C.border,
    BG = C.canvas,
    GRID_DOT = sheet(0.07);
  function drawGrid() {
    if (is3D()) {
      drawGroundGrid();
      return;
    }
    let step = 60;
    while (step * cam.s < 22) step *= 4;
    const g = step * cam.s,
      ox = ((cam.x % g) + g) % g,
      oy = ((cam.y % g) + g) % g;
    ctx.fillStyle = GRID_DOT;
    const r = Math.min(1.6, Math.max(1, g / 30));
    ctx.beginPath();
    for (let x = ox; x < VW; x += g) for (let y = oy; y < VH; y += g) ctx.rect(x - r / 2, y - r / 2, r, r);
    ctx.fill();
  }
  // In 3D the dots lie on the ground the stacks stand on, turned and tilted with it.
  function drawGroundGrid() {
    trig();
    const s = cam.s,
      // A world unit's length on screen along each axis of the ground; the tilt shortens one of them.
      alongX = Math.hypot(T.cy, T.sy * T.ct) * s,
      alongY = Math.hypot(T.sy, T.cy * T.ct) * s;
    // Spaced by the longer axis, as densely as the flat view at the same zoom; the receding rows close up.
    let step = 60;
    while (step * Math.max(alongX, alongY) < 22) step *= 4;
    const corners = [
      [0, 0],
      [VW, 0],
      [0, VH],
      [VW, VH],
    ].map(([x, y]) => unproj(x, y));
    const xs = corners.map((p) => p[0]),
      ys = corners.map((p) => p[1]);
    const x0 = Math.floor(Math.min(...xs) / step) * step,
      y0 = Math.floor(Math.min(...ys) / step) * step,
      x1 = Math.max(...xs),
      y1 = Math.max(...ys);
    const r = Math.min(1.6, Math.max(1, (step * Math.max(alongX, alongY)) / 30)) / s;
    groundT(0);
    ctx.fillStyle = GRID_DOT;
    ctx.beginPath();
    for (let x = x0; x <= x1; x += step) for (let y = y0; y <= y1; y += step) ctx.rect(x - r / 2, y - r / 2, r, r);
    ctx.fill();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  // An import's curve as its ends, two handles and arriving direction, in one shared buffer: x0 y0 h1 h2 x1 y1 ox oy.
  const CURVE = new Float64Array(10);
  function edgeCurve(a, b) {
    const c = CURVE;
    if (imp) {
      const down = Y[b] > Y[a];
      const x0 = X[a] + CW / 2,
        y0 = down ? Y[a] + H[a] : Y[a],
        x1 = X[b] + CW / 2,
        y1 = down ? Y[b] : Y[b] + H[b];
      const dy = Math.max(80, Math.abs(y1 - y0) * 0.45) * (down ? 1 : -1);
      c[0] = c[2] = x0;
      c[1] = y0;
      c[3] = y0 + dy;
      c[4] = c[6] = x1;
      c[5] = y1 - dy;
      c[7] = y1;
      c[8] = 0;
      c[9] = down ? 1 : -1;
      return c;
    }
    const ax = X[a] + CW / 2,
      ay = Y[a] + H[a] / 2,
      bx = X[b] + CW / 2,
      by = Y[b] + H[b] / 2;
    const dx = bx - ax,
      dy = by - ay;
    let x0, y0, x1, y1, ox, oy;
    if (Math.abs(dx) > CW * 0.75) {
      const sx = Math.sign(dx);
      x0 = ax + (sx * CW) / 2;
      y0 = Y[a] + HEAD / 2;
      x1 = bx - (sx * CW) / 2;
      y1 = Y[b] + HEAD / 2;
      ox = sx;
      oy = 0;
    } else if (dy > 0) {
      x0 = ax;
      y0 = Y[a] + H[a];
      x1 = bx;
      y1 = Y[b];
      ox = 0;
      oy = 1;
    } else {
      x0 = ax;
      y0 = Y[a];
      x1 = bx;
      y1 = Y[b] + H[b];
      ox = 0;
      oy = -1;
    }
    const d = Math.min(400, Math.hypot(x1 - x0, y1 - y0) * 0.4 + 20);
    c[0] = x0;
    c[1] = y0;
    c[2] = x0 + ox * d;
    c[3] = y0 + oy * d;
    c[4] = x1 - ox * d;
    c[5] = y1 - oy * d;
    c[6] = x1;
    c[7] = y1;
    c[8] = ox;
    c[9] = oy;
    return c;
  }
  function edgeGeom(a, b) {
    edgeCurve(a, b);
    return curvePath();
  }
  // The curve last worked out, onto the current path.
  function curvePath() {
    const c = CURVE;
    ctx.moveTo(c[0], c[1]);
    ctx.bezierCurveTo(c[2], c[3], c[4], c[5], c[6], c[7]);
    return [c[6], c[7], c[8], c[9]];
  }

  function arrow(x, y, dx, dy, size) {
    const l = Math.hypot(dx, dy) || 1,
      ux = dx / l,
      uy = dy / l;
    ctx.moveTo(x, y);
    ctx.lineTo(x - ux * size - uy * size * 0.55, y - uy * size + ux * size * 0.55);
    ctx.lineTo(x - ux * size + uy * size * 0.55, y - uy * size - ux * size * 0.55);
    ctx.closePath();
  }
  // Handles reach at most this far past an import's two files, so most imports are ruled out before any curve is worked out.
  const EDGE_REACH = 400;
  // A curve stays within its control points, so their box, padded for its stroke and arrowhead, says whether it can show; it leaves them in CURVE.
  function edgeInView(a, b, v) {
    const s = cam.s,
      reach = EDGE_REACH + 12 / s;
    if (
      Math.min(X[a], X[b]) - reach > v[2] ||
      Math.max(X[a], X[b]) + CW + reach < v[0] ||
      Math.min(Y[a], Y[b]) - reach > v[3] ||
      Math.max(Y[a] + H[a], Y[b] + H[b]) + reach < v[1]
    )
      return false;
    const c = edgeCurve(a, b);
    if (!in3D) {
      const pad = 12 / s;
      return !(
        Math.min(c[0], c[2], c[4], c[6]) - pad > v[2] ||
        Math.max(c[0], c[2], c[4], c[6]) + pad < v[0] ||
        Math.min(c[1], c[3], c[5], c[7]) - pad > v[3] ||
        Math.max(c[1], c[3], c[5], c[7]) + pad < v[1]
      );
    }
    // Tilted and turned, the ground in view is no box: the control points are tested where they land on screen.
    let left = Infinity,
      right = -Infinity,
      top = Infinity,
      bottom = -Infinity;
    for (let k = 0; k < 8; k += 2) {
      const x = (c[k] * T.cy - c[k + 1] * T.sy) * s + cam.x,
        y = (c[k] * T.sy + c[k + 1] * T.cy) * T.ct * s + cam.y;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    return !(left - 12 > VW || right + 12 < 0 || top - 12 > VH || bottom + 12 < 0);
  }



  function drawName(i, x, y, cardPx) {
    const n = N[i];
    if (cardPx < 40) {
      ctx.fillStyle = hexA(colorOf[i], 0.85);
      rr(x, y, CW * 0.8, NAME_H, NAME_H / 2);
      ctx.fill();
      return;
    }
    const [t, tw] = truncName(i),
      pw = Math.min(CW, tw + 36),
      dc = highlightsChange() && (n.st || DD[i] > 0) ? blockCol[i] : null;
    rr(x, y, pw, NAME_H, NAME_H / 2);
    ctx.fillStyle = dc ? mix(dc, PILL, 0.16) : PILL;
    ctx.fill();
    ctx.strokeStyle = dc || (i === hov ? C.borderStrong : PILL_LINE);
    ctx.lineWidth = dc ? Math.max(1.4, 1.2 / cam.s) : (1 / cam.s) * Math.min(1, cam.s);
    ctx.stroke();
    if (highlightsChange() && n.st && cardPx > 40) {
      // status tag just right of the pill
      const tx = x + pw + 4 + NAME_H / 2,
        ty = y + NAME_H / 2;
      ctx.fillStyle = ST[n.st].c;
      ctx.beginPath();
      ctx.arc(tx, ty, NAME_H / 2 - 1, 0, 7);
      ctx.fill();
      txt(n.st, tx, ty + 0.5, 11, C.canvas);
    }
    if (highlightsChange() && n.st === 'D' && cardPx > 70) {
      ctx.fillStyle = DEL;
      ctx.fillRect(x + 26, y + NAME_H / 2 - 0.6, tw, 1.2);
    }
    ctx.save();
    ctx.translate(x + 6, y + 3);
    ctx.scale(16 / 18, 16 / 18);
    drawIcon(n, 0, 0, 18);
    ctx.restore();
    if (cardPx > 70) {
      ctx.font = NAME_FONT;
      ctx.fillStyle = C.text;
      ctx.fillText(t, x + 27, y + 15);
    }
  }
  const PILL_FONT = '600 9px "Geist Mono Variable", monospace';
  function countPill(x, y, text, color) {
    const w = textWidth(PILL_FONT, text) + 10;
    ctx.font = PILL_FONT;
    rr(x, y, w, COUNT_H, COUNT_H / 2);
    ctx.fillStyle = mix(color, PILL, 0.17);
    ctx.fill();
    ctx.strokeStyle = mix(color, PILL, 0.55);
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(text, x + 5, y + 10);
    return w;
  }
  function drawCounts(i, x, y, cardPx) {
    if (cardPx <= 60) return;
    const n = N[i],
      cy = y + H[i] - COUNT_H;
    let cx = x;
    if (highlightsChange() && n.st && n.k !== 'img') {
      if (n.ad) cx += countPill(cx, cy, '+' + fmtN(n.ad), ADD) + 4;
      if (n.dl) cx += countPill(cx, cy, '−' + fmtN(n.dl), DEL) + 4;
    }
    if (fout[i]) cx += countPill(cx, cy, '→ ' + fout[i], C.imports) + 4;
    if (fin[i]) cx += countPill(cx, cy, '← ' + fin[i], C.importedBy) + 4;
    if (cyc[i]) cx += countPill(cx, cy, '↻ ' + cyc[i], AMBER) + 4;
    if (n.k === 'img')
      countPill(cx, cy, fmtB(n.b) + (THUMBS && THUMBS[n.p] ? ` · ${THUMBS[n.p].w}×${THUMBS[n.p].h}` : ''), C.dim);
    if (n.k === 'svg') {
      const [tx, ty, tw, th] = toggleRect(i),
        code = codeView(n);
      rr(tx, ty, tw, th, th / 2);
      ctx.fillStyle = i === hov ? C.hover : sheet(0.08);
      ctx.fill();
      ctx.strokeStyle = C.borderStrong;
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.fillStyle = C.text;
      ctx.textAlign = 'center';
      ctx.font = '700 8.5px "Geist Mono Variable", monospace';
      ctx.fillText(code ? 'img' : '</>', tx + tw / 2, ty + 10);
      ctx.textAlign = 'left';
    }
  }
  function linesPill(n, px, py, pw, ph, cardPx) {
    if (cardPx <= 90) return;
    const P = pagesOf(n),
      t = fmtN(n.l) + (n.l === 1 ? ' line' : ' lines') + (P > 1 ? ` · ${P} pp` : '');
    const font = '600 8.5px "Geist Mono Variable", monospace';
    const tw = textWidth(font, t) + 8;
    ctx.font = font;
    const bx = px + pw - tw - 3,
      by = py + ph - 14;
    rr(bx, by, tw, 11, 3);
    ctx.fillStyle = C.sunken;
    ctx.fill();
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 0.6;
    ctx.stroke();
    ctx.fillStyle = P > 1 ? C.text : C.dim;
    ctx.fillText(t, bx + 4, by + 8.2);
  }
  function pageSheet(px, py, pw, ph, back) {
    ctx.fillStyle = back ? sheet(0.08) : sheet(0.06);
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = back ? sheet(0.2) : sheet(0.15);
    ctx.lineWidth = 0.8;
    ctx.strokeRect(px, py, pw, ph);
  }
  function drawRows(i, x0, y0, row0, nrows, s, hi, rh = ROWH) {
    const n = N[i],
      len = nrows * rh;
    if (!MM || n.r <= 0) {
      ctx.fillStyle = sheet(0.09);
      ctx.fillRect(x0, y0, MW * 0.7, len);
      return;
    }
    let bmp = null;
    if (hi) {
      if (hiCache.has(i) || i === sel || mayDecode()) bmp = hiBitmap(i);
    } else {
      if (loCache.has(i) || mayDecode()) bmp = loBitmap(i);
    }
    if (!bmp) {
      ctx.fillStyle = sheet(0.09);
      ctx.fillRect(x0, y0, MW, len);
      invalidate();
      return;
    }
    const sc = hi ? 1 : 4,
      sy = row0 / sc,
      sh = Math.max(1 / sc, Math.min(bmp.height - sy, nrows / sc));
    if (sh <= 0) return;
    ctx.imageSmoothingEnabled = !(hi && rh * s >= 1.5);
    ctx.drawImage(bmp, 0, sy, bmp.width, sh, x0, y0, MW, sh * sc * rh);
    if (rh * s >= 5 && !in3D) {
      const r0 = Math.max(0, Math.floor((-cam.y / s - y0) / rh)),
        r1 = Math.min(nrows, Math.ceil(((VH - cam.y) / s - y0) / rh));
      ctx.fillStyle = sheet(0.06);
      ctx.beginPath();
      for (let r = r0; r < r1; r++) ctx.rect(x0, y0 + r * rh + rh * 0.74, MW, rh * 0.26);
      ctx.fill();
    }
  }
  // changed lines on a page that shows lines l0..l1: a gutter bar left of the page, and a wash over the rows
  // green = added lines, amber = changed lines, red notch = lines removed here
  function drawHunks(n, px, py, ph, l0, l1, rh, cardPx) {
    if (!highlightsChange() || !n.st || n.st === 'D' || cardPx < 16) return;
    const sc = n.s || 1,
      gx = px - 7,
      gw = 4;
    if (n.st === 'A' || !n.hk) {
      ctx.fillStyle = n.st === 'A' ? ADD : ST[n.st].c;
      ctx.fillRect(gx, py, gw, ph);
      return;
    }
    for (const [ns, nl, , ol] of n.hk) {
      if (nl > 0) {
        const a = Math.max(ns, l0),
          b = Math.min(ns + nl - 1, l1);
        if (a > b) continue;
        const yy = py + ((a - l0) / sc) * rh,
          hh = Math.max(1.5, ((b - a + 1) / sc) * rh),
          c = ol > 0 ? ST.M.c : ADD;
        ctx.fillStyle = hexA(c, 0.2);
        ctx.fillRect(px, yy, MW, hh);
        ctx.fillStyle = c;
        ctx.fillRect(gx, yy, gw, hh);
      } else {
        if (ns < l0 - 1 || ns > l1) continue;
        const yy = py + ((ns - l0 + 1) / sc) * rh;
        ctx.fillStyle = DEL;
        ctx.beginPath();
        ctx.moveTo(gx - 3, yy - 3.5);
        ctx.lineTo(gx + gw, yy);
        ctx.lineTo(gx - 3, yy + 3.5);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(px, yy - 0.6, MW, 1.2);
      }
    }
  }
  // card body for code: a stack of sheets behind the first page, plus the line count
  function drawPages(i, x, y, s, hi, cardPx) {
    const n = N[i],
      mx = x,
      my = y + HEAD;
    if (hasPic(n)) {
      // SVG source, clipped to the picture box
      const rows = Math.max(1, Math.min(n.r, Math.floor(n.box / ROWH)));
      pageSheet(mx, my, MW, n.box, false);
      drawRows(i, mx, my, 0, rows, s, hi);
      drawHunks(n, mx, my, n.box, 1, rows, ROWH, cardPx);
      linesPill(n, mx, my, MW, n.box, cardPx);
      return;
    }
    const sheets = sheetsOf(n),
      rh = rowHOf(n),
      ph = Math.max(3 * ROWH, Math.min(n.r, rpp(n)) * rh);
    if (cardPx > 24) for (let k = sheets; k >= 1; k--) pageSheet(mx + k * SHEET, my + k * SHEET, MW, ph, true);
    if (cardPx > 24) pageSheet(mx, my, MW, ph, false);
    drawRows(i, mx, my, 0, Math.min(n.r, rpp(n)), s, hi, rh);
    drawHunks(n, mx, my, ph, 1, linesPerPage(n), rh, cardPx);
    if (sheets && cardPx > 24) {
      // dog-ear on the top page hints at more underneath
      const f = 9;
      ctx.fillStyle = sheet(0.16);
      ctx.beginPath();
      ctx.moveTo(mx + MW - f, my + ph);
      ctx.lineTo(mx + MW, my + ph - f);
      ctx.lineTo(mx + MW, my + ph);
      ctx.closePath();
      ctx.fill();
    }
    linesPill(n, mx, my, MW, ph, cardPx);
  }
  function drawFrames(s, v, fAlpha) {
    // frames
    ctx.globalAlpha = fAlpha;
    for (const f of frames) {
      if (f.x > v[2] || f.y > v[3] || f.x + f.w < v[0] || f.y + f.h < v[1] || f.w * s < 3) continue;
      if (f.tier) {
        const fs = Math.min(150, 26 / s);
        if (fs * s < 8) continue;
        ctx.strokeStyle = sheet(0.1);
        ctx.lineWidth = 1.5 / s;
        ctx.setLineDash([12 / s, 10 / s]);
        ctx.beginPath();
        ctx.moveTo(f.x, f.y + 440);
        ctx.lineTo(f.x + f.w, f.y + 440);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = `700 ${fs}px "Geist Variable", system-ui, sans-serif`;
        ctx.fillStyle = C.dim;
        ctx.fillText(f.name, f.x, f.y + 440 - fs * 0.9);
        const tw = ctx.measureText(f.name).width;
        ctx.font = `400 ${fs * 0.42}px "Geist Mono Variable", monospace`;
        ctx.fillStyle = C.faint;
        ctx.fillText(
          `${f.sub} · ${f.count.toLocaleString()} files · ${fmtL(f.lines)} lines`,
          f.x + tw + fs * 0.5,
          f.y + 440 - fs * 0.9,
        );
        continue;
      }
      ctx.fillStyle = f.color
        ? hexA(f.color, 0.045)
        : f.band
          ? hexA(C.text, 0.035)
          : hexA(C.text, f.depth === 0 ? 0.015 : 0.03);
      ctx.fillRect(f.x, f.y, f.w, f.h);
      ctx.strokeStyle = f.color ? hexA(f.color, 0.45) : f.depth <= 1 ? sheet(0.16) : sheet(0.11);
      ctx.lineWidth = (f.color ? 1.5 : 1) / s;
      ctx.strokeRect(f.x, f.y, f.w, f.h);
      if (22 * s >= 7 && f.w * s > 60) {
        const band = !imp ? FLH : LH,
          fs = Math.min(f.depth <= 1 ? 34 : 26, 17 / s),
          ms = Math.min(16, 11.5 / s),
          ty = f.y + band * 0.62;
        const x0 = f.x + (!imp ? folderPad(f.depth) : FP);
        let lx = x0;
        if (f.color) {
          ctx.fillStyle = f.color;
          ctx.beginPath();
          ctx.arc(lx + fs * 0.3, ty - fs * 0.32, fs * 0.3, 0, 7);
          ctx.fill();
          lx += fs * 0.85;
        } else if (isFolder(f)) {
          drawFolderIcon(lx - fs * 0.15, ty - fs * 0.92, fs * 1.2, C.dim);
          lx += fs * 1.15;
        }
        const nameRoom = f.w - FP * 2 - (lx - x0);
        ctx.font = `600 ${fs}px "Geist Variable", system-ui, sans-serif`;
        ctx.fillStyle = C.text;
        ctx.fillText(f.name, lx, ty, nameRoom);
        const tw = Math.min(ctx.measureText(f.name).width, nameRoom);
        ctx.font = `400 ${ms}px "Geist Mono Variable", monospace`;
        ctx.fillStyle = C.faint;
        const meta = `${f.count.toLocaleString()} files · ${fmtL(f.lines)} lines${f.sub ? ' · ' + f.sub : ''}`;
        if (lx - f.x + tw + fs + ctx.measureText(meta).width < f.w - FP) ctx.fillText(meta, lx + tw + fs * 0.6, ty);
      }
    }
    ctx.globalAlpha = 1;
  }
  function drawFaint(s, v) {
    // faint links for everything sit underneath the files
    const cardPx0 = CW * s,
      focusNode0 = sel >= 0 ? sel : hov;
    if (S.edges === 'all' && activeE.length) {
      ctx.globalCompositeOperation = 'lighter';
      const ea = Math.min(0.07, 0.02 + cardPx0 * 0.0008) * (focusNode0 >= 0 ? 0.45 : 1) * (imp ? 2 : 1);
      ctx.strokeStyle = hexA(C.dim, ea);
      ctx.lineWidth = 1 / s;
      let c = 0;
      ctx.beginPath();
      for (const j of activeE) {
        const e = E[j];
        if (gone(e) || (e[4] && highlightsChange())) continue; // highlighted new and removed links get their own pass below
        const a = e[0],
          b = e[1];
        if (!edgeInView(a, b, v)) continue;
        curvePath();
        if (++c % 300 === 0) {
          ctx.stroke();
          ctx.beginPath();
        }
      }
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
    if (highlightsChange() && S.edges !== 'none') {
      // imports the change adds (green) or removes (red, dashed), drawn under the files
      const a0 = focusNode0 >= 0 ? 0.25 : 0.7;
      for (const [state, color] of [
        [1, ADD],
        [2, DEL],
      ]) {
        ctx.beginPath();
        let any = false;
        for (const j of activeE) {
          const e = E[j];
          if (e[4] !== state) continue;
          if (!edgeInView(e[0], e[1], v)) continue;
          curvePath();
          any = true;
        }
        if (!any) continue;
        ctx.strokeStyle = hexA(color, a0);
        ctx.lineWidth = Math.max(1.4, 1.6 / s);
        ctx.setLineDash(state === 2 ? [8 / s, 6 / s] : []);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }
  // ---------- orthographic 3D: the canvas tilts back and every file rises as a stack of pages ----------
  const V3 = {
      yaw: 0.38,
      tilt: 0.98,
      h: 1,
      anim: null,
      saved: { yaw: 0.38, tilt: 0.98 },
    },
    PAGE_T = 7,
    T = { cy: 1, sy: 0, ct: 1, st: 0 };
  const is3D = () => S.view === '3d';
  let in3D = false,
    order3D = [];
  function trig() {
    T.cy = Math.cos(V3.yaw);
    T.sy = Math.sin(V3.yaw);
    T.ct = Math.cos(V3.tilt);
    T.st = Math.sin(V3.tilt);
  }
  const unit = (x, y, z = 0) => [x * T.cy - y * T.sy, (x * T.sy + y * T.cy) * T.ct - z * T.st];
  function proj(x, y, z = 0) {
    const u = unit(x, y, z);
    return [u[0] * cam.s + cam.x, u[1] * cam.s + cam.y];
  }
  function unproj(px, py, z = 0) {
    const u = (px - cam.x) / cam.s,
      v = (py - cam.y) / cam.s + z * T.st,
      yr = v / T.ct;
    return [u * T.cy + yr * T.sy, -u * T.sy + yr * T.cy];
  }
  function groundT(z = 0) {
    const s = cam.s;
    ctx.setTransform(
      dpr * s * T.cy,
      dpr * s * T.ct * T.sy,
      -dpr * s * T.sy,
      dpr * s * T.ct * T.cy,
      dpr * cam.x,
      dpr * (cam.y - z * T.st * s),
    );
  }
  const towerTop = (n) => (hasPic(n) && !codeView(n) ? n.box : Math.max(3 * ROWH, Math.min(n.r, rpp(n)) * rowHOf(n)));
  const stackZ = (n) => (hasPic(n) ? PAGE_T * 1.5 : Math.max(1, Math.ceil(n.l / PAGE_ROWS)) * PAGE_T); // true page count, even for sampled files
  const towerZ = (n) => stackZ(n) * V3.h;
  let tallest = { ids: null, z: 0 };
  function tallestStack() {
    if (tallest.ids !== ids) {
      let z = 0;
      for (const i of ids) z = Math.max(z, stackZ(N[i]));
      tallest = { ids, z };
    }
    return tallest.z;
  }
  // One tower's corners at a time, written into the same arrays: thousands are projected each frame.
  const TOWER = {
    b: [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ],
    t: [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ],
    zs: 0,
    fx: 0,
    fy: 0,
    fw: MW,
    fh: 0,
  };
  function towerPts(i) {
    const n = N[i],
      fx = X[i],
      fy = Y[i] + HEAD,
      fh = towerTop(n),
      zs = towerZ(n) * T.st * cam.s,
      s = cam.s;
    for (let c = 0; c < 4; c++) {
      const wx = c === 1 || c === 2 ? fx + MW : fx,
        wy = c >= 2 ? fy + fh : fy,
        sx = (wx * T.cy - wy * T.sy) * s + cam.x,
        sy = (wx * T.sy + wy * T.cy) * T.ct * s + cam.y;
      TOWER.b[c][0] = TOWER.t[c][0] = sx;
      TOWER.b[c][1] = sy;
      TOWER.t[c][1] = sy - zs;
    }
    TOWER.zs = zs;
    TOWER.fx = fx;
    TOWER.fy = fy;
    TOWER.fh = fh;
    return TOWER;
  }
  function centerOn(wx, wy) {
    if (is3D()) {
      trig();
      const u = unit(wx, wy);
      cam.x = VW / 2 - u[0] * cam.s;
      cam.y = VH / 2 - u[1] * cam.s;
    } else {
      cam.x = VW / 2 - wx * cam.s;
      cam.y = VH / 2 - wy * cam.s;
    }
    camAnim = null;
    invalidate();
  }
  function quad(p, fill) {
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]);
    for (let k = 1; k < p.length; k++) ctx.lineTo(p[k][0], p[k][1]);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }
  function drawTower(i, s, cardPx, focus, hi) {
    const n = N[i],
      g = towerPts(i),
      { b, t, zs } = g;
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (const p of b) {
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
    const tagged = cardPx > 55,
      side = tagged ? 90 : 40,
      above = tagged ? 50 : 40;
    if (x1 < -side || x0 > VW + side || y1 < -40 || y0 - zs > VH + above) return;
    const col = blockCol[i],
      dim = focus && !focus.has(i),
      fade = focus || cardPx < 7 ? 0 : diffFade(i),
      ring = focus || cardPx < 7 ? null : diffRing(i);
    // Too small for faces, a tower is only its top: its footprint on the ground, shifted by its height, under one transform.
    if (cardPx < 7 && zs < 0.6 && !dim && i !== sel && i !== hov) {
      if (!onGround) {
        groundT(0);
        onGround = true;
      }
      const lift = (towerZ(n) * T.st) / T.ct;
      ctx.fillStyle = mix(col, BG, 0.85);
      ctx.fillRect(g.fx - lift * T.sy, g.fy - lift * T.cy, g.fw, g.fh);
      return;
    }
    onGround = false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (zs >= 0.6) {
      // the two side faces that face the viewer; page edges show as ruled lines once they are 3px apart
      const faces = [
        T.cy > 0 ? [b[3], b[2], t[2], t[3], 0.42] : [b[0], b[1], t[1], t[0], 0.42],
        T.sy > 0 ? [b[1], b[2], t[2], t[1], 0.28] : [b[0], b[3], t[3], t[0], 0.28],
      ];
      const pages = Math.max(1, Math.round(towerZ(n) / PAGE_T)),
        gap = zs / pages;
      for (const [p0, p1, p2, p3, k] of faces) {
        quad([p0, p1, p2, p3], mix(col, BG, dim ? 0.1 : k));
        if (gap >= 3 && !dim) {
          const step = Math.max(1, Math.ceil(pages / 400));
          ctx.strokeStyle = hexA(C.canvas, 0.5);
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let q = step; q < pages; q += step) {
            const d = q * gap;
            ctx.moveTo(p0[0], p0[1] - d);
            ctx.lineTo(p1[0], p1[1] - d);
          }
          ctx.stroke();
        }
      }
    }
    // top face: the first page, drawn in the tilted plane at the top of the stack
    groundT(towerZ(n));
    const { fx, fy, fw, fh } = g;
    if (cardPx < 7) {
      ctx.fillStyle = mix(col, BG, dim ? 0.2 : 0.85);
      ctx.fillRect(fx, fy, fw, fh);
    } else if (hasPic(n) && !codeView(n)) {
      ctx.fillStyle = checkerPattern();
      ctx.fillRect(fx, fy, fw, fh);
      const im = picture(i);
      if (im) {
        const ar = im.naturalWidth / im.naturalHeight;
        let dw = fw,
          dh = fw / ar;
        if (dh > fh) {
          dh = fh;
          dw = fh * ar;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(im, fx + (fw - dw) / 2, fy + (fh - dh) / 2, dw, dh);
      }
    } else {
      pageSheet(fx, fy, fw, fh, false);
      if (n.r > 0) drawRows(i, fx, fy, 0, Math.min(n.r, rpp(n)), s, hi, rowHOf(n));
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (dim) {
      quad(t, hexA(C.canvas, 0.8));
      return;
    }
    if (fade) quad(t, hexA(C.canvas, fade));
    const outline = () => {
      ctx.beginPath();
      t.forEach((p, k) => {
        if (k) ctx.lineTo(p[0], p[1]);
        else ctx.moveTo(p[0], p[1]);
      });
      ctx.closePath();
    };
    if (ring && i !== sel && i !== hov) {
      outline();
      ctx.strokeStyle = ring;
      ctx.lineWidth = N[i].st ? 2 : 1.2;
      ctx.stroke();
    }
    if (i === sel || i === hov) {
      outline();
      ctx.strokeStyle = i === sel ? C.bright : C.dim;
      ctx.lineWidth = i === sel ? 2.5 : 1.5;
      ctx.stroke();
    }
    // a name tag floats above each stack, faint over a file outside the change
    if (cardPx > 55) {
      ctx.globalAlpha = fade >= UNRELATED_FADE ? 0.45 : 1;
      const top = [(t[0][0] + t[1][0]) / 2, Math.min(t[0][1], t[1][1])],
        [name, tw] = truncName(i),
        w = tw + 30,
        x = top[0] - w / 2,
        y = top[1] - 30;
      rr(x, y, w, 20, 10);
      ctx.fillStyle = PILL;
      ctx.fill();
      ctx.strokeStyle = i === sel ? C.bright : PILL_LINE;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.save();
      ctx.translate(x + 5, y + 3);
      ctx.scale(14 / 18, 14 / 18);
      drawIcon(n, 0, 0, 18);
      ctx.restore();
      ctx.font = NAME_FONT;
      ctx.fillStyle = C.text;
      ctx.fillText(name, x + 23, y + 14);
      if (cardPx > 90 && n.k !== 'img') {
        const pg = Math.ceil(n.l / PAGE_ROWS);
        ctx.font = '600 9px "Geist Mono Variable", monospace';
        ctx.fillStyle = C.dim;
        ctx.textAlign = 'center';
        ctx.fillText(`${fmtN(n.l)} lines${pg > 1 ? ' · ' + pg + ' pp' : ''}`, top[0], y - 5);
        ctx.textAlign = 'left';
      }
      ctx.globalAlpha = 1;
    }
  }
  // The ground in view as a world box, reaching past the bottom edge for anything standing `rise` tall.
  function groundView(rise, margin) {
    const pts = [
      [0, 0],
      [VW, 0],
      [0, VH],
      [VW, VH],
    ].flatMap(([x, y]) => [unproj(x, y), unproj(x, y + rise * T.st * cam.s)]);
    const xs = pts.map((p) => p[0]),
      ys = pts.map((p) => p[1]);
    return [Math.min(...xs) - margin, Math.min(...ys) - margin, Math.max(...xs) + margin, Math.max(...ys) + margin];
  }
  let onGround = false;
  // Back to front, re-sorted only when the view turns or the files move.
  const depthKey = new Float64Array(NN);
  let sortedFor = null;
  function sortTowers() {
    if (!anim && sortedFor && sortedFor.ids === ids && sortedFor.yaw === V3.yaw && sortedFor.layout === layoutRun)
      return;
    for (const i of ids) depthKey[i] = (X[i] + MW / 2) * T.sy + (Y[i] + HEAD + PAGE_H / 2) * T.cy;
    order3D = ids.slice().sort((a, b) => depthKey[a] - depthKey[b]);
    sortedFor = { ids, yaw: V3.yaw, layout: layoutRun };
  }
  function draw3D(s, now) {
    in3D = true;
    trig();
    const fAlpha = anim ? Math.min(1, (now - anim.t0) / anim.dur) : 1,
      ground = groundView(0, 50),
      gv = groundView(tallestStack() * V3.h, 400);
    groundT(0);
    drawFrames(s, ground, fAlpha);
    drawFaint(s, ground);
    const focus = sel >= 0 && S.isolate ? nb : null,
      cardPx = CW * s;
    sortTowers();
    onGround = false;
    mmBudget = 160;
    mmDeadline = performance.now() + DECODE_MS;
    const hi = ROWH * s >= 0.9;
    for (const i of order3D) {
      // Off the ground in view, a tower can't reach the screen: skip it before projecting anything.
      if (X[i] > gv[2] || X[i] + CW < gv[0] || Y[i] > gv[3] || Y[i] + H[i] < gv[1]) continue;
      drawTower(i, s, cardPx, focus, hi);
    }
    // the hovered / selected file's links run between the tops of the stacks
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const f = sel >= 0 ? sel : hov;
    if (S.edges !== 'none' && f >= 0 && vis[f]) {
      const topC = (i) => proj(X[i] + MW / 2, Y[i] + HEAD + towerTop(N[i]) / 2, towerZ(N[i]));
      for (const [list, other, color] of [
        [outE[f], 1, C.imports],
        [inE[f], 0, C.importedBy],
      ]) {
        ctx.beginPath();
        const heads = [];
        for (const j of list) {
          if (!act[j]) continue;
          const e = E[j];
          if (!vis[e[0]] || !vis[e[1]]) continue;
          const a = topC(e[0]),
            c = topC(e[1]);
          ctx.moveTo(a[0], a[1]);
          const mx = (a[0] + c[0]) / 2,
            my = Math.min(a[1], c[1]) - Math.hypot(c[0] - a[0], c[1] - a[1]) * 0.18;
          ctx.quadraticCurveTo(mx, my, c[0], c[1]);
          heads.push([c[0], c[1], c[0] - mx, c[1] - my]);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = f === sel ? 1.8 : 1.3;
        ctx.stroke();
        ctx.beginPath();
        for (const h of heads) arrow(h[0], h[1], h[2], h[3], 9);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
    drawFrameLabels(s);
    drawNav();
    showZoom(s);
    in3D = false;
  }
  // The ground point under the pointer moves linearly with height, so a tower is hit where that track crosses its footprint below its top.
  function hit3D(px, py) {
    trig();
    const [gx, gy] = unproj(px, py),
      rise = T.st / T.ct,
      dx = rise * T.sy,
      dy = rise * T.cy;
    for (let k = order3D.length - 1; k >= 0; k--) {
      const i = order3D[k];
      if (!vis[i]) continue;
      const n = N[i],
        y0 = Y[i] + HEAD;
      let lo = 0,
        hi = towerZ(n);
      if (dx === 0) {
        if (gx < X[i] || gx > X[i] + MW) continue;
      } else {
        const a = (X[i] - gx) / dx,
          b = (X[i] + MW - gx) / dx;
        lo = Math.max(lo, Math.min(a, b));
        hi = Math.min(hi, Math.max(a, b));
      }
      if (dy === 0) {
        if (gy < y0 || gy > y0 + towerTop(n)) continue;
      } else {
        const a = (y0 - gy) / dy,
          b = (y0 + towerTop(n) - gy) / dy;
        lo = Math.max(lo, Math.min(a, b));
        hi = Math.min(hi, Math.max(a, b));
      }
      if (lo <= hi) return i;
    }
    return -1;
  }

  function draw() {
    const now = performance.now();
    if (anim) {
      const t = Math.min(1, (now - anim.t0) / anim.dur),
        e = ease(t);
      for (const i of ids) {
        X[i] = FX[i] + (TX[i] - FX[i]) * e;
        Y[i] = FY[i] + (TY[i] - FY[i]) * e;
      }
      if (t >= 1) anim = null;
      invalidate();
    }
    if (camAnim) {
      const t = Math.min(1, (now - camAnim.t0) / camAnim.dur),
        e = ease(t),
        a = camAnim.from,
        b = camAnim.to;
      cam.s = Math.exp(Math.log(a.s) + (Math.log(b.s) - Math.log(a.s)) * e);
      const wa = [(VW / 2 - a.x) / a.s, (VH / 2 - a.y) / a.s],
        wb = [(VW / 2 - b.x) / b.s, (VH / 2 - b.y) / b.s];
      cam.x = VW / 2 - (wa[0] + (wb[0] - wa[0]) * e) * cam.s;
      cam.y = VH / 2 - (wa[1] + (wb[1] - wa[1]) * e) * cam.s;
      if (t >= 1) {
        Object.assign(cam, b);
        camAnim = null;
      }
      invalidate();
    }
    if (V3.anim) {
      // tilt the floor up from (or back down to) the flat view, stacks rising as it goes
      const a = V3.anim,
        t = Math.min(1, (now - a.t0) / a.dur),
        e = ease(t);
      for (const k of ['yaw', 'tilt', 'h']) V3[k] = a.from[k] + (a.to[k] - a.from[k]) * e;
      centerOn(a.c[0], a.c[1]);
      if (t >= 1) {
        V3.anim = null;
        if (a.done) a.done();
      }
      invalidate();
    }
    const s = cam.s;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, VW, VH);
    drawGrid();
    const v = [-cam.x / s, -cam.y / s, (VW - cam.x) / s, (VH - cam.y) / s];
    if (is3D()) {
      draw3D(s, now);
      return;
    }
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * cam.x, dpr * cam.y);
    const fAlpha = anim ? Math.min(1, (now - anim.t0) / anim.dur) : 1;

    drawFrames(s, v, fAlpha);
    drawFaint(s, v);
    const focus = sel >= 0 && S.isolate ? nb : null;
    const cardPx = CW * s;
    if (cardPx < 7) {
      const groups = new Map();
      for (const i of ids) {
        const x = X[i],
          y = Y[i];
        if (x > v[2] || y > v[3] || x + CW < v[0] || y + H[i] < v[1]) continue;
        const key = blockCol[i] + (focus && !focus.has(i) ? '|d' : '');
        let g = groups.get(key);
        if (!g) {
          g = [];
          groups.set(key, g);
        }
        g.push(i);
      }
      for (const [key, list] of groups) {
        const [col, d] = key.split('|');
        ctx.fillStyle = mix(col, BG, d ? 0.16 : 0.8);
        ctx.beginPath();
        for (const i of list) ctx.rect(X[i], Y[i], CW, H[i]);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else {
      mmBudget = 160;
    mmDeadline = performance.now() + DECODE_MS;
      const hi = ROWH * s >= 0.9,
        reach = CARD_REACH + 1.5 / s;
      for (const i of ids) {
        const x = X[i],
          y = Y[i],
          h = H[i];
        if (x - reach > v[2] || y - reach > v[3] || x + CW + reach < v[0] || y + h + reach < v[1]) continue;
        const n = N[i];
        const fade = focus ? (focus.has(i) ? 0 : 0.84) : diffFade(i),
          dim = fade >= UNRELATED_FADE;
        drawName(i, x, y, cardPx);
        if (h * s > 8) {
          if (hasPic(n) && !codeView(n)) {
            const mx = x,
              my = y + HEAD,
              bh = n.box;
            ctx.fillStyle = checkerPattern();
            ctx.fillRect(mx, my, MW, bh);
            const im = picture(i);
            if (im) {
              const ar = im.naturalWidth / im.naturalHeight;
              let dw = MW,
                dh = MW / ar;
              if (dh > bh) {
                dh = bh;
                dw = bh * ar;
              }
              ctx.imageSmoothingEnabled = true;
              ctx.drawImage(im, mx + (MW - dw) / 2, my + (bh - dh) / 2, dw, dh);
            }
            ctx.strokeStyle = sheet(0.15);
            ctx.lineWidth = 0.8;
            ctx.strokeRect(mx, my, MW, bh);
            if (highlightsChange() && n.st && n.st !== 'D') {
              ctx.fillStyle = ST[n.st].c;
              ctx.fillRect(mx - 7, my, 4, bh);
            }
          } else drawPages(i, x, y, s, hi, cardPx);
          if (highlightsChange() && n.st === 'D') {
            // deleted: a red wash and a hatch over the old pages
            const bh = h - HEAD - FOOT;
            ctx.fillStyle = hexA(C.canvas, 0.45);
            ctx.fillRect(x, y + HEAD, CW, bh);
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, y + HEAD, CW, bh);
            ctx.clip();
            ctx.strokeStyle = hexA(C.deleted, 0.35);
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let k = -bh; k < CW; k += 14) {
              ctx.moveTo(x + k, y + HEAD + bh);
              ctx.lineTo(x + k + bh, y + HEAD);
            }
            ctx.stroke();
            ctx.restore();
            ctx.strokeStyle = DEL;
            ctx.lineWidth = Math.max(1, 1 / s);
            ctx.setLineDash([6, 4]);
            ctx.strokeRect(x, y + HEAD, MW, bh);
            ctx.setLineDash([]);
          }
          if (!dim) drawCounts(i, x, y, cardPx);
        }
        if (fade) {
          ctx.fillStyle = hexA(C.canvas, fade);
          if (dim) {
            rr(x, y, cardPx < 40 ? CW * 0.8 : Math.min(CW, truncName(i)[1] + 36), NAME_H, NAME_H / 2);
            ctx.fill();
          }
          ctx.fillRect(x, y + HEAD, CW, h - HEAD - FOOT);
        }
        const ring = focus ? null : diffRing(i);
        if (ring && h * s > 8) {
          rr(x - 4, y + HEAD - 4, CW + 8, h - HEAD - FOOT + 8, 6);
          ctx.strokeStyle = ring;
          ctx.lineWidth = n.st ? Math.max(2, 2 / s) : Math.max(1, 1.2 / s);
          ctx.stroke();
        }
        if (i === sel && !multiPage(n)) {
          rr(x - 6, y - 6, CW + 12, h + 12, 10);
          ctx.strokeStyle = C.bright;
          ctx.lineWidth = Math.max(2, 2.5 / s);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    // hovered / selected links go on top of the files
    const focusNode = sel >= 0 ? sel : hov;
    if (S.edges !== 'none' && focusNode >= 0 && vis[focusNode]) drawFocusEdges(focusNode, s, focusNode === sel, v);
    if ((imp || highlightsChange()) && S.edges !== 'none') drawChain(s, v);

    // the selected file unfolds to its full length, on top of everything, at one row per line
    if (sel >= 0 && vis[sel] && cardPx >= 7) drawSpread(sel, s, cardPx, v);
    else if (sel >= 0 && vis[sel]) {
      ctx.strokeStyle = C.bright;
      ctx.lineWidth = 2.5 / s;
      {
        const r = spreadRect(sel);
        ctx.strokeRect(r.x - 4 / s, r.y - 4 / s, r.w + 8 / s, r.h + 8 / s);
      }
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawFrameLabels(s);
    drawNav();
    showZoom(s);
  }
  const zoomLabel = $('#zl');
  let zoomText = '';
  function showZoom(s) {
    const text = (s * 100 < 10 ? (s * 100).toFixed(1) : Math.round(s * 100)) + '%';
    if (text !== zoomText) zoomLabel.textContent = zoomText = text;
  }
  // The spread's shadow: blur 40 dropped 8, in device pixels as canvas shadows are, reaching about 1.5 blurs out.
  const SHADOW_BLUR = 40,
    SHADOW_DROP = 8,
    SHADOW_REACH = 72;
  const shadowTiles = new Map();
  function liveShadow(g, path) {
    g.shadowColor = 'rgba(0,0,0,.6)';
    g.shadowBlur = SHADOW_BLUR;
    g.shadowOffsetY = SHADOW_DROP;
    g.fillStyle = C.chrome;
    path();
    g.fill();
  }
  // A blurred rounded rect long enough that its edges' falloff settles, per corner radius, sliced in nine.
  function shadowTile(radius) {
    let tile = shadowTiles.get(radius);
    if (tile) return tile;
    if (shadowTiles.size > 32) shadowTiles.clear();
    const core = 2 * (radius + SHADOW_REACH) + 2,
      side = core + 2 * SHADOW_REACH;
    tile = document.createElement('canvas');
    keepPainted(tile, () => {
      tile.width = tile.height = side;
      const g = tile.getContext('2d');
      // The shape sits a tile to the left, so only its shadow lands on the tile.
      g.shadowOffsetX = side;
      liveShadow(g, () => {
        g.beginPath();
        g.roundRect(SHADOW_REACH - side, SHADOW_REACH, core, core, radius);
      });
    });
    shadowTiles.set(radius, tile);
    return tile;
  }
  // Blurring the whole spread every frame was most of its cost: its corners come from the tile, its edges stretch the tile's middle.
  function drawSpreadShadow(x, y, w, h, s) {
    const r = Math.round(10 * s * dpr),
      E = SHADOW_REACH,
      K = 2 * E + r,
      sx = (x * s + cam.x) * dpr,
      sy = (y * s + cam.y) * dpr,
      sw = w * s * dpr,
      sh = h * s * dpr;
    if (sw < 2 * (E + r) || sh < 2 * (E + r)) {
      ctx.save();
      liveShadow(ctx, () => rr(x, y, w, h, 10));
      ctx.restore();
      return;
    }
    const tile = shadowTile(r);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const piece = (tx, ty, tw, th, dx, dy, dw, dh) => ctx.drawImage(tile, tx, ty, tw, th, dx, dy, dw, dh);
    const x0 = sx - E,
      y0 = sy - E,
      x1 = sx + sw - E - r,
      y1 = sy + sh - E - r,
      midW = sw - 2 * (E + r),
      midH = sh - 2 * (E + r);
    piece(0, 0, K, K, x0, y0, K, K);
    piece(K, 0, 2, K, x0 + K, y0, midW, K);
    piece(K + 2, 0, K, K, x1, y0, K, K);
    piece(0, K, K, 2, x0, y0 + K, K, midH);
    piece(K + 2, K, K, 2, x1, y0 + K, K, midH);
    piece(0, K + 2, K, K, x0, y1, K, K);
    piece(K, K + 2, 2, K, x0 + K, y1, midW, K);
    piece(K + 2, K + 2, K, K, x1, y1, K, K);
    ctx.restore();
  }
  function drawSpread(i, s, cardPx, v) {
    const n = N[i];
    if (!multiPage(n)) return;
    const R = spreadRect(i),
      { x, y, w, h, cols, P } = R;
    const halo = (SHADOW_REACH + SHADOW_DROP) / dpr / s;
    if (x - halo > v[2] || y - halo > v[3] || x + w + halo < v[0] || y + h + halo < v[1]) return;
    const lpp = linesPerPage(n),
      per = rpp(n),
      rh = rowHOf(n),
      ox = x + MPAD,
      oy = y + MPAD;
    drawSpreadShadow(x, y, w, h, s);
    rr(x, y, w, h, 10);
    ctx.fillStyle = C.chrome;
    ctx.fill();
    drawName(i, ox, oy, cardPx);
    if (cardPx > 70) {
      const [, tw] = truncName(i);
      ctx.font = '600 10px "Geist Mono Variable", monospace';
      ctx.fillStyle = C.dim;
      ctx.fillText(
        `${n.l.toLocaleString()} lines · ${P} pages${n.s > 2 ? ` of ~${lpp.toLocaleString()} lines (sampled)` : ''}`,
        ox + Math.min(CW, tw + 36) + 10,
        oy + 15,
      );
    }
    for (let p = 0; p < P; p++) {
      const c = p % cols,
        r = Math.floor(p / cols),
        px = ox + c * (MW + PG_GAP),
        py = oy + HEAD + r * (PAGE_H + PG_LABEL + PG_GAP);
      if (px > v[2] || py > v[3] || px + MW < v[0] || py + PAGE_H + PG_LABEL < v[1]) continue;
      const row0 = Math.round(p * per),
        nrows = Math.min(Math.round((p + 1) * per), n.r) - row0;
      pageSheet(px, py, MW, PAGE_H, false);
      drawRows(i, px, py, row0, nrows, s, true, rh);
      drawHunks(n, px, py, Math.max(ROWH, nrows * rh), p * lpp + 1, (p + 1) * lpp, rh, cardPx);
      if (cardPx > 70) {
        ctx.font = '400 8.5px "Geist Mono Variable", monospace';
        ctx.fillStyle = C.faint;
        ctx.fillText(`${p + 1}  ·  L${(p * lpp + 1).toLocaleString()}`, px, py + PAGE_H + 10.5);
      }
    }
    rr(x - 2, y - 2, w + 4, h + 4, 11);
    ctx.strokeStyle = C.bright;
    ctx.lineWidth = Math.max(2, 2.5 / s);
    ctx.stroke();
  }
  function chainOf(i) {
    const out = [];
    let k = i,
      guard = 0;
    while (imp && k >= 0 && k !== imp.root && imp.par[k] >= 0 && guard++ < 200) {
      const j = imp.par[k];
      out.push(j);
      k = imp.dir === 'up' ? E[j][1] : E[j][0];
    }
    return out;
  }
  // diff mode: the import path from a dependent back to the changed file that puts it in the blast radius
  function diffChainOf(i) {
    const out = [];
    let k = i,
      guard = 0;
    while (k >= 0 && DD[k] > 0 && DP[k] >= 0 && guard++ < 200) {
      const j = DP[k];
      out.push(j);
      k = E[j][1];
    }
    return out;
  }
  function drawChain(s, v) {
    const t = hov >= 0 && vis[hov] ? hov : sel >= 0 && vis[sel] ? sel : -1;
    if (t < 0 || (imp && t === imp.root)) return;
    const ch = (imp ? chainOf(t) : diffChainOf(t)).filter(
      (j) => vis[E[j][0]] && vis[E[j][1]] && edgeInView(E[j][0], E[j][1], v),
    );
    if (!ch.length) return;
    ctx.beginPath();
    const heads = [];
    for (const j of ch) heads.push(edgeGeom(E[j][0], E[j][1]));
    ctx.strokeStyle = 'rgba(0,0,0,.6)';
    ctx.lineWidth = 6 / s;
    ctx.stroke();
    ctx.strokeStyle = C.bright;
    ctx.lineWidth = 2.6 / s;
    ctx.stroke();
    ctx.beginPath();
    for (const hd of heads) arrow(hd[0], hd[1], hd[2], hd[3], 11 / s);
    ctx.fillStyle = C.bright;
    ctx.fill();
  }
  function drawFocusEdges(f, s, strong, v) {
    const groups = [];
    if (strong && S.hops === 2 && nbE) groups.push({ list: nbE, color: hexA(C.text, 0.22), w: 1 });
    groups.push({
      list: outE[f].filter((j) => act[j] && vis[E[j][1]]),
      color: strong ? C.imports : hexA(C.imports, 0.7),
      w: strong ? 1.8 : 1.3,
      arrow: true,
    });
    groups.push({
      list: inE[f].filter((j) => act[j] && vis[E[j][0]]),
      color: strong ? C.importedBy : hexA(C.importedBy, 0.7),
      w: strong ? 1.8 : 1.3,
      arrow: true,
    });
    // in diff mode, links the change adds or removes keep their green / red
    if (highlightsChange())
      for (const g of groups.slice()) {
        if (!g.arrow) continue;
        for (const [state, color] of [
          [1, ADD],
          [2, DEL],
        ]) {
          const list = g.list.filter((j) => E[j][4] === state);
          if (list.length) groups.push({ list, color, w: g.w + 0.6, arrow: true, state });
        }
        g.list = g.list.filter((j) => !E[j][4]);
      }
    else for (const g of groups) g.list = g.list.filter((j) => !gone(E[j]));
    for (const g of groups)
      for (const dashed of [false, true]) {
        ctx.beginPath();
        const heads = [];
        for (const j of g.list) {
          const e = E[j];
          if ((g.state === 2 || e[2] === 1) !== dashed || !edgeInView(e[0], e[1], v)) continue;
          heads.push(edgeGeom(e[0], e[1]));
        }
        if (!heads.length) continue;
        ctx.strokeStyle = g.color;
        ctx.lineWidth = g.w / s;
        ctx.setLineDash(dashed ? [5 / s, 4 / s] : []);
        ctx.stroke();
        ctx.setLineDash([]);
        if (g.arrow) {
          ctx.beginPath();
          for (const hd of heads) arrow(hd[0], hd[1], hd[2], hd[3], 9 / s);
          ctx.fillStyle = g.color;
          ctx.fill();
        }
      }
  }
  function drawFrameLabels(s) {
    if (!frames.length || 22 * s >= 7) return;
    const placed = [];
    let n = 0;
    ctx.font = '600 12px "Geist Variable", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const f of frames) {
      if (f.depth === 0 && !f.tier && frames.length > 1) continue;
      const [sx, sy] = is3D() ? proj(f.x, f.y) : [f.x * s + cam.x, f.y * s + cam.y],
        sw = f.w * s,
        sh = f.h * s * (is3D() ? T.ct : 1);
      if (sw < 60 || sh < 30 || sx > VW || sy > VH || sx + sw < 0 || sy + sh < 0) continue;
      const label = f.name.length > 40 ? '…' + f.name.slice(-39) : f.name,
        dot = f.color ? 12 : 0,
        mark = dot || (isFolder(f) ? 14 : 0);
      const tw = f.tier ? ctx.measureText(label).width + 14 : Math.min(ctx.measureText(label).width + 14 + mark, sw - 6),
        lx = f.tier ? Math.max(4, sx - tw - 16) : Math.max(sx + 4, 4),
        ly = f.tier ? (is3D() ? proj(f.x, f.y + 440)[1] : sy + 440 * s) - 10 : Math.max(sy + 4, 4);
      const r = [lx, ly, lx + tw, ly + 20];
      if (placed.some((p) => !(r[2] < p[0] || r[0] > p[2] || r[3] < p[1] || r[1] > p[3]))) continue;
      placed.push(r);
      ctx.fillStyle = hexA(C.chrome, 0.88);
      rr(lx, ly, tw, 20, 5);
      ctx.fill();
      if (dot) {
        ctx.fillStyle = f.color;
        ctx.beginPath();
        ctx.arc(lx + 10, ly + 10, 4, 0, 7);
        ctx.fill();
      } else if (mark) drawFolderIcon(lx + 5, ly + 4.5, 12, C.dim);
      ctx.fillStyle = f.depth <= 1 ? C.text : C.dim;
      ctx.save();
      ctx.beginPath();
      ctx.rect(lx, ly, tw, 20);
      ctx.clip();
      ctx.fillText(label, lx + 7 + mark, ly + 10.5);
      ctx.restore();
      if (++n > 160) break;
    }
    ctx.textBaseline = 'alphabetic';
  }

  // ---------- navigator ----------
  const nav = $('#nav'),
    nctx = nav.getContext('2d');
  const navOff = document.createElement('canvas');
  let navT = null;
  nav.addEventListener('contextrestored', () => {
    invalidate();
  });
  navOff.addEventListener('contextrestored', () => {
    buildNav();
    invalidate();
  });
  function buildNav() {
    const W = 220,
      Hh = 150,
      d = Math.min(2, window.devicePixelRatio || 1);
    nav.width = W * d;
    nav.height = Hh * d;
    navOff.width = W * d;
    navOff.height = Hh * d;
    const b = bounds();
    const s = Math.min((W - 12) / b.w, (Hh - 12) / b.h);
    const ox = (W - b.w * s) / 2 - b.x * s,
      oy = (Hh - b.h * s) / 2 - b.y * s;
    navT = { s, ox, oy, d };
    const g = navOff.getContext('2d');
    g.setTransform(d, 0, 0, d, 0, 0);
    g.fillStyle = C.sunken;
    g.fillRect(0, 0, W, Hh);
    for (const f of frames)
      if (f.depth === 1) {
        g.strokeStyle = f.color ? hexA(f.color, 0.6) : sheet(0.15);
        g.lineWidth = 1;
        g.strokeRect(f.x * s + ox, f.y * s + oy, f.w * s, f.h * s);
      }
    for (const i of ids) {
      g.fillStyle = blockCol[i];
      g.fillRect(TX[i] * s + ox, TY[i] * s + oy, Math.max(0.6, CW * s), Math.max(0.6, H[i] * s));
    }
  }
  function drawNav() {
    if (!navT || nav.offsetParent === null) return;
    const { s, ox, oy, d } = navT;
    nctx.setTransform(1, 0, 0, 1, 0, 0);
    nctx.drawImage(navOff, 0, 0);
    nctx.setTransform(d, 0, 0, d, 0, 0);
    if (sel >= 0 && vis[sel]) {
      nctx.fillStyle = C.bright;
      nctx.fillRect(TX[sel] * s + ox - 1.5, TY[sel] * s + oy - 1.5, 4, 4);
    }
    if (is3D()) {
      const [cx3, cy3] = toWorld(VW / 2, VH / 2);
      nctx.strokeStyle = C.imports;
      nctx.lineWidth = 1.5;
      nctx.beginPath();
      nctx.arc(cx3 * s + ox, cy3 * s + oy, 6, 0, 7);
      nctx.stroke();
      return;
    }
    const x = (-cam.x / cam.s) * s + ox,
      y = (-cam.y / cam.s) * s + oy,
      w = (VW / cam.s) * s,
      h = (VH / cam.s) * s;
    nctx.strokeStyle = C.imports;
    nctx.lineWidth = 1.2;
    nctx.strokeRect(x, y, w, h);
    nctx.fillStyle = hexA(C.imports, 0.07);
    nctx.fillRect(x, y, w, h);
  }
  function navTo(e) {
    const r = nav.getBoundingClientRect(),
      { s, ox, oy } = navT;
    const wx = (e.clientX - r.left - ox) / s,
      wy = (e.clientY - r.top - oy) / s;
    centerOn(wx, wy);
    camAnim = null;
    invalidate();
  }
  let navDrag = false;
  nav.addEventListener('pointerdown', (e) => {
    navDrag = true;
    nav.setPointerCapture(e.pointerId);
    navTo(e);
  });
  nav.addEventListener('pointermove', (e) => {
    if (navDrag) navTo(e);
  });
  nav.addEventListener('pointerup', () => {
    navDrag = false;
  });

  // ---------- input ----------
  function toWorld(px, py) {
    if (is3D()) {
      trig();
      return unproj(px, py);
    }
    return [(px - cam.x) / cam.s, (py - cam.y) / cam.s];
  }
  function hit(px, py) {
    if (is3D()) return hit3D(px, py);
    const [wx, wy] = toWorld(px, py);
    if (sel >= 0 && vis[sel]) {
      const r = spreadRect(sel);
      if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) return sel;
    }
    for (let k = ids.length - 1; k >= 0; k--) {
      const i = ids[k];
      if (wx >= X[i] && wx <= X[i] + CW && wy >= Y[i] && wy <= Y[i] + H[i]) return i;
    }
    return -1;
  }
  function hitFrame(px, py) {
    const [wx, wy] = toWorld(px, py);
    let best = null;
    for (const f of frames)
      if (wx >= f.x && wx <= f.x + f.w && wy >= f.y && wy <= f.y + f.h && (!best || f.depth > best.depth)) best = f;
    return best;
  }
  function hitToggle(i, px, py) {
    if (is3D() || N[i].k !== 'svg' || CW * cam.s <= 60) return false;
    const [wx, wy] = toWorld(px, py);
    const [tx, ty, tw, th] = toggleRect(i);
    return wx >= tx - 4 && wx <= tx + tw + 4 && wy >= ty - 4 && wy <= ty + th + 4;
  }
  const ptrs = new Map();
  let drag = null,
    pinch = null;
  cv.addEventListener('contextmenu', (e) => {
    if (is3D()) e.preventDefault();
  });
  let orbit = null;
  cv.addEventListener('pointerdown', (e) => {
    if (is3D() && (e.altKey || e.button === 2)) {
      cv.setPointerCapture(e.pointerId);
      orbit = { x: e.clientX, y: e.clientY, c: toWorld(VW / 2, VH / 2) };
      hideTip();
      return;
    }
    cv.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinch = {
        d: Math.hypot(a.x - b.x, a.y - b.y),
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
      };
      drag = null;
      return;
    }
    drag = {
      x: e.clientX,
      y: e.clientY,
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
    };
    camAnim = null;
    hideTip();
  });
  cv.addEventListener('pointermove', (e) => {
    if (orbit) {
      V3.yaw += (e.clientX - orbit.x) * 0.006;
      V3.tilt = Math.max(0.25, Math.min(1.35, V3.tilt - (e.clientY - orbit.y) * 0.005));
      orbit.x = e.clientX;
      orbit.y = e.clientY;
      centerOn(orbit.c[0], orbit.c[1]);
      return;
    }
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y),
        mx = (a.x + b.x) / 2,
        my = (a.y + b.y) / 2;
      cam.x += mx - pinch.mx;
      cam.y += my - pinch.my;
      zoomAt(mx, my, d / pinch.d);
      pinch = { d, mx, my };
      return;
    }
    if (drag) {
      const dx = e.clientX - drag.x,
        dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) {
        drag.moved = true;
        cv.classList.add('grab');
      }
      if (drag.moved) {
        cam.x += dx;
        cam.y += dy;
        invalidate();
      }
      drag.x = e.clientX;
      drag.y = e.clientY;
      return;
    }
    if (e.pointerType === 'mouse') hoverAt(e.clientX, e.clientY);
  });
  const endPtr = (e) => {
    if (orbit) {
      orbit = null;
      return;
    }
    ptrs.delete(e.pointerId);
    if (pinch) {
      if (ptrs.size < 2) pinch = null;
      drag = null;
      return;
    }
    if (drag && !drag.moved && e.type === 'pointerup') {
      const i = hit(e.clientX, e.clientY);
      if (i >= 0 && hitToggle(i, e.clientX, e.clientY)) {
        N[i].flip = !N[i].flip;
        invalidate();
      } else select(i);
    }
    drag = null;
    cv.classList.remove('grab');
  };
  cv.addEventListener('pointerup', endPtr);
  cv.addEventListener('pointercancel', endPtr);
  cv.addEventListener('pointerleave', () => {
    if (hov >= 0) {
      hov = -1;
      invalidate();
    }
    hideTip();
  });
  cv.addEventListener('dblclick', (e) => {
    const i = hit(e.clientX, e.clientY);
    if (i >= 0) {
      if (hitToggle(i, e.clientX, e.clientY)) return;
      select(i);
      flyTo(i);
      return;
    }
    const f = hitFrame(e.clientX, e.clientY);
    if (f) fitRect(f, true, 40, 2);
  });
  cv.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 18 : e.deltaMode === 2 ? e.deltaY * VH : e.deltaY;
      const dx = e.deltaMode === 1 ? e.deltaX * 18 : e.deltaX;
      if (e.ctrlKey || e.metaKey) {
        zoomAt(e.clientX, e.clientY, Math.exp(-Math.max(-60, Math.min(60, dy)) * 0.009));
        hoverAt(e.clientX, e.clientY);
        return;
      }
      const mouseWheel = e.deltaMode !== 0 || (dx === 0 && Math.abs(dy) >= 50 && Number.isInteger(dy));
      if (mouseWheel && !e.shiftKey) {
        zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.0022));
        return;
      }
      cam.x -= e.shiftKey && dx === 0 ? dy : dx;
      cam.y -= e.shiftKey && dx === 0 ? 0 : dy;
      camAnim = null;
      invalidate();
      hideTip();
    },
    { passive: false },
  );

  const tip = $('#tip');
  function hoverAt(px, py) {
    const i = hit(px, py);
    if (i !== hov) {
      hov = i;
      invalidate();
    }
    if (i < 0) {
      hideTip();
      return;
    }
    const n = N[i];
    let mt = `${n.k === 'img' ? fmtB(n.b) : n.l.toLocaleString() + ' lines'} · imports ${fout[i]} · imported by ${fin[i]}`;
    if (cyc[i]) mt += ` · in a cycle of ${cyc[i]}`;
    if (imp && imp.dist[i] > 0) mt += ` · ${imp.dist[i]} step${imp.dist[i] > 1 ? 's' : ''} from ${N[imp.root].name}`;
    if (multiPage(n) && i !== sel && !is3D()) mt += ` · ${pagesOf(n)} pages, click to spread them out`;
    if (DIFF) {
      if (n.st)
        mt =
          `${ST[n.st].name}${n.op ? ' from ' + n.op : ''}` +
          (n.st !== 'D' && n.k !== 'img' ? ` (+${n.ad || 0} −${n.dl || 0})` : '') +
          ' · ' +
          mt;
      else if (DD[i] > 0) {
        const ch = diffChainOf(i),
          src = N[E[ch[ch.length - 1]][1]];
        mt = `Affected: imports ${src.name}${DD[i] > 1 ? ` through ${DD[i] - 1} other file${DD[i] > 2 ? 's' : ''}` : ''} · ${mt}`;
      } else if (DL[i]) mt = `A changed file adds or drops an import of this · ${mt}`;
    }
    if (hitToggle(i, px, py)) mt = codeView(n) ? 'Show the picture' : 'Show the SVG source';
    // Rebuilt and measured only when it says something new: both cost a layout.
    if (tipShows.i !== i || tipShows.mt !== mt || tip.hidden) {
      tip.innerHTML = '<div class="nm"></div><div class="dr"></div><div class="mt"></div>';
      tip.querySelector('.nm').textContent = n.name;
      tip.querySelector('.nm').style.color = TYPES[n.k].color;
      tip.querySelector('.dr').textContent = n.dir || '(repo root)';
      tip.querySelector('.mt').textContent = mt;
      tip.hidden = false;
      const r = tip.getBoundingClientRect();
      tipShows = { i, mt, w: r.width, h: r.height };
    }
    let x = px + 16,
      y = py + 16;
    if (x + tipShows.w > VW - 8) x = px - tipShows.w - 12;
    if (y + tipShows.h > VH - 8) y = py - tipShows.h - 12;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  let tipShows = { i: -1, mt: '', w: 0, h: 0 };
  function hideTip() {
    tip.hidden = true;
  }

  // ---------- selection & detail ----------
  function computeNeighborhood() {
    nb = new Set([sel]);
    nbE = null;
    const one = [];
    for (const j of outE[sel])
      if (act[j] && vis[E[j][1]]) {
        nb.add(E[j][1]);
        one.push(E[j][1]);
      }
    for (const j of inE[sel])
      if (act[j] && vis[E[j][0]]) {
        nb.add(E[j][0]);
        one.push(E[j][0]);
      }
    if (S.hops === 2) {
      nbE = [];
      for (const m of one) {
        for (const j of outE[m]) {
          const e = E[j];
          if (act[j] && vis[e[1]] && e[1] !== sel) {
            nb.add(e[1]);
            nbE.push(j);
          }
          if (nbE.length > 6000) break;
        }
        for (const j of inE[m]) {
          const e = E[j];
          if (act[j] && vis[e[0]] && e[0] !== sel) {
            nb.add(e[0]);
            nbE.push(j);
          }
          if (nbE.length > 6000) break;
        }
      }
    }
  }
  function select(i) {
    sel = i;
    invalidate();
    if (i < 0) {
      nb = null;
      nbE = null;
      $('#detail').hidden = true;
      return;
    }
    computeNeighborhood();
    renderDetail();
  }
  const det = $('#detail');
  // The viewer's own buttons and segmented controls wear the design system's classes, at its small size.
  const DESIGN_CLASSES = { zb: 'tk-button', seg: 'tk-toggle-group' };
  function el(tag, cls, text) {
    const x = document.createElement(tag);
    if (cls) x.className = cls;
    if (DESIGN_CLASSES[cls]) {
      x.classList.add(DESIGN_CLASSES[cls]);
      x.dataset.size = 'sm';
    }
    if (text != null) x.textContent = text;
    return x;
  }
  function fileRow(j, other) {
    const e = E[j],
      n = N[other],
      row = el('div', 'li');
    const d = el('span', 'dot');
    d.style.background = colorOf[other];
    row.append(d);
    row.append(el('span', 'nm', n.name));
    const dr = el('span', 'dr');
    dr.textContent = '‎' + (n.dir || '/') + '‎';
    row.append(dr);
    if (e[2]) row.append(el('span', 'kd', KIND_LABEL[e[2]]));
    if (e[4]) {
      const k = el('span', 'kd', e[4] === 1 ? 'new' : 'removed');
      k.style.color = k.style.borderColor = e[4] === 1 ? ADD : DEL;
      row.append(k);
    }
    if (e.length > 3 && e[3] >= 0) {
      const v = el('span', 'kd', 'via ' + N[e[3]].name);
      v.title = 'Imported through ' + N[e[3]].p;
      row.append(v);
    }
    if (!vis[other]) row.style.opacity = 0.45;
    row.title = n.p;
    row.addEventListener('click', () => {
      if (!vis[other]) return;
      select(other);
      flyTo(other);
    });
    return row;
  }
  function listSection(title, color, edgesList, pick) {
    const sec = el('div', 'sec');
    const h = el('h4');
    const i = el('i');
    i.style.background = color;
    h.append(i, document.createTextNode(`${title} · ${edgesList.length}`));
    sec.append(h);
    const lst = el('div', 'lst');
    sec.append(lst);
    const sorted = edgesList.slice().sort((a, b) => N[pick(a)].p.localeCompare(N[pick(b)].p));
    const render = (lim) => {
      lst.textContent = '';
      for (const j of sorted.slice(0, lim)) lst.append(fileRow(j, pick(j)));
      if (sorted.length > lim) {
        const m = el('button', 'more', `Show all ${sorted.length}`);
        m.onclick = () => render(Infinity);
        lst.append(m);
      }
    };
    render(60);
    if (!edgesList.length)
      lst.append(
        el('div', 'note', title === 'Imports' ? 'No internal imports.' : 'Nothing in view imports this file.'),
      );
    return sec;
  }
  function areaOf(p) {
    const s = p.split('/');
    return CONT.has(s[0]) && s.length > 2 ? s[0] + '/' + s[1] : s.length > 1 ? s[0] : '(root)';
  }
  function renderDetail() {
    const i = sel,
      n = N[i];
    det.textContent = '';
    det.hidden = false;
    const head = el('div', 'dh'),
      top = el('div', 'dh-top');
    const ic = document.createElement('canvas');
    ic.width = ic.height = 72;
    ic.style.width = ic.style.height = '28px';
    keepPainted(ic, () => {
      const g = ic.getContext('2d');
      g.scale(72 / 18, 72 / 18);
      const keep = ctx;
      ctx = g;
      try {
        drawIcon(n, 0, 0, 18);
      } finally {
        ctx = keep;
      }
    });
    const tt = el('div');
    tt.style.minWidth = '0';
    tt.append(el('h2', null, n.name), el('div', 'path', n.p));
    const close = el('button', null, '×');
    close.id = 'dclose';
    close.setAttribute('aria-label', 'Close details');
    close.onclick = () => select(-1);
    top.append(ic, tt, close);
    head.append(top);
    const stats = el('div', 'stats');
    const sz = n.b >= 1024 ? (n.b / 1024).toFixed(n.b > 102400 ? 0 : 1) + ' KB' : n.b + ' B';
    const first =
      n.k === 'img'
        ? [THUMBS && THUMBS[n.p] ? `${THUMBS[n.p].w}×${THUMBS[n.p].h}` : '—', 'pixels']
        : [n.l.toLocaleString(), 'lines'];
    [first, [sz, 'size'], [fout[i], 'imports'], [fin[i], 'imported by']].forEach(([a, b]) => {
      const s = el('div', 'stat');
      s.append(el('b', null, String(a)), el('span', null, b));
      stats.append(s);
    });
    head.append(stats);
    const badges = el('div', 'badges');
    if (DIFF && n.st) {
      const b = el('span', 'badge', ST[n.st].name);
      b.style.color = b.style.borderColor = ST[n.st].c;
      badges.append(b);
    }
    badges.append(el('span', 'badge', TYPES[n.k].name));
    if (n.test) badges.append(el('span', 'badge', 'Test'));
    if (n.story) badges.append(el('span', 'badge', 'Storybook'));
    if (n.gen) badges.append(el('span', 'badge', 'Generated'));
    if (cyc[i]) badges.append(el('span', 'badge warn', `Import cycle · ${cyc[i]} files`));
    if (
      !fin[i] &&
      n.st !== 'D' &&
      !n.test &&
      !n.story &&
      /^(ts|tsx|img|svg)$/.test(n.k) &&
      !/(^|\/)(index|main|.*\.config|.*\.d)\.[cm]?[jt]sx?$/.test(n.p) &&
      !/^(e2e|tools|scripts|bin)\//.test(n.p)
    )
      badges.append(el('span', 'badge warn', 'Nothing imports this'));
    head.append(badges);
    const up = bfs(i, 'up'),
      down = bfs(i, 'down');
    const acts = el('div', 'dacts');
    const br = el('button', 'zb', `Blast radius · ${up.count.toLocaleString()}`);
    br.title = 'Everything that depends on this file, directly or through other files';
    br.onclick = () => enterImpact(i, 'up');
    const dp = el('button', 'zb', `Dependencies · ${down.count.toLocaleString()}`);
    dp.title = 'Everything this file pulls in, directly or through other files';
    dp.onclick = () => enterImpact(i, 'down');
    const zb = el('button', 'zb', multiPage(n) && !is3D() ? `Show all ${pagesOf(n)} pages` : 'Zoom to file');
    zb.onclick = () => {
      if (multiPage(n) && !is3D()) {
        const r = spreadRect(i);
        fitRect({ x: r.x - 40, y: r.y - 40, w: r.w + 80, h: r.h + 80 }, true, 30, 3);
      } else flyTo(i);
    };
    if (DIFF && n.st) {
      const sd = el('button', 'zb', 'Show diff');
      sd.title = "Open this file in the review's diff";
      sd.onclick = () => parent.postMessage({ type: 'tk-review:show-file', path: n.p }, '*');
      acts.append(sd);
    }
    acts.append(br, dp, zb);
    head.append(acts);
    const acts2 = el('div', 'dacts');
    const iso = el('button', 'tg');
    iso.setAttribute('aria-pressed', S.isolate);
    iso.append(el('span', 'bx'), document.createTextNode('Dim others'));
    iso.onclick = () => {
      S.isolate = !S.isolate;
      iso.setAttribute('aria-pressed', S.isolate);
      invalidate();
    };
    const hop = el('div', 'seg');
    [1, 2].forEach((hn) => {
      const b = el('button', 'tk-toggle', hn + ' hop' + (hn > 1 ? 's' : ''));
      b.setAttribute('aria-pressed', S.hops === hn);
      b.onclick = () => {
        S.hops = hn;
        computeNeighborhood();
        renderDetail();
        invalidate();
      };
      hop.append(b);
    });
    acts2.append(iso, hop);
    head.append(acts2);
    det.append(head);
    const body = el('div', 'dbody');
    if (DIFF) body.append(changeSection(i));
    if (up.count) {
      const sec = el('div', 'sec');
      sec.append(el('h4', null, `Blast radius by area · ${up.count}`));
      const cnt = {};
      for (const k of up.order.slice(1)) {
        const a = areaOf(N[k].p);
        cnt[a] = (cnt[a] || 0) + 1;
      }
      const pk = el('div', 'pk');
      Object.entries(cnt)
        .sort((a, b) => b[1] - a[1])
        .forEach(([a, c]) => {
          pk.append(el('span', null, `${a} ${c}`));
        });
      sec.append(pk);
      body.append(sec);
    }
    body.append(
      listSection(
        'Imports',
        'var(--out)',
        outE[i].filter((j) => edgeAllowed(E[j][2])),
        (j) => E[j][1],
      ),
    );
    body.append(
      listSection(
        'Imported by',
        'var(--in)',
        inE[i].filter((j) => edgeAllowed(E[j][2])),
        (j) => E[j][0],
      ),
    );
    if (n.x && n.x.length) {
      const sec = el('div', 'sec');
      sec.append(el('h4', null, `Packages · ${n.x.length}`));
      const pk = el('div', 'pk');
      for (const x of n.x) pk.append(el('span', null, x));
      sec.append(pk);
      body.append(sec);
    }
    if (hasPic(n)) {
      const sec = el('div', 'sec');
      sec.append(el('h4', null, 'Picture'));
      const src = picSrc(i);
      if (src) {
        const w = el('div', 'picwrap');
        const im = new Image();
        im.src = src;
        im.alt = n.name;
        w.append(im);
        sec.append(w);
        if (n.k === 'img' && THUMBS[n.p]) sec.append(el('div', 'note', `${THUMBS[n.p].w}×${THUMBS[n.p].h} pixels.`));
      } else sec.append(el('div', 'note', loadPictures.failed ? 'Pictures could not be loaded.' : 'Loading picture…'));
      body.append(sec);
    }
    if (n.k !== 'img') {
      const ms = el('div', 'sec');
      ms.append(el('h4', null, 'Code shape'));
      if (MM && n.r) {
        const w = el('div', 'mmwrap');
        const cc = document.createElement('canvas');
        keepPainted(cc, () => paintShape(cc, i, MMCOLS, 0));
        cc.style.height = cc.height * 2 + 'px';
        w.append(cc);
        ms.append(w);
        if (n.s > 1) ms.append(el('div', 'note', `Sampled: one row per ${n.s} lines, so the whole file fits.`));
      } else
        ms.append(
          el(
            'div',
            'note',
            loadMinimaps.failed ? 'Code shapes could not be loaded in this browser.' : 'Loading code shapes…',
          ),
        );
      body.append(ms);
    }
    det.append(body);
  }

  // what the change did to this file, or how the change reaches it
  function changeSection(i) {
    const n = N[i],
      sec = el('div', 'sec');
    sec.append(el('h4', null, 'Change'));
    const say = (t) => sec.append(el('div', 'note', t));
    if (n.st) {
      const hk = n.hk ? n.hk.length : 0;
      if (n.st === 'D') say(`Deleted. It had ${n.l.toLocaleString()} lines.`);
      else if (n.k === 'img') say(n.st === 'A' ? 'New image.' : `${ST[n.st].name} image.`);
      else
        say(
          (n.st === 'A' ? 'New file' : n.st === 'R' ? 'Renamed' : 'Modified') +
            ` · +${(n.ad || 0).toLocaleString()} −${(n.dl || 0).toLocaleString()} lines` +
            (n.st !== 'A' && hk ? ` in ${hk} place${hk > 1 ? 's' : ''}` : ''),
        );
      if (n.op) {
        const o = el('div', 'path', `from ${n.op}`);
        sec.append(o);
      }
      let deps = 0;
      for (let k = 0; k < NN; k++) if (DD[k] > 0 && diffRoot(k) === i) deps++;
      if (deps)
        say(
          `${deps.toLocaleString()} file${deps > 1 ? 's' : ''} in the blast radius trace${deps > 1 ? '' : 's'} back to this one first.`,
        );
    } else if (DD[i] > 0) {
      say(`Unchanged, but it imports changed code ${DD[i]} step${DD[i] > 1 ? 's' : ''} away:`);
      const lst = el('div', 'lst');
      for (const j of diffChainOf(i)) lst.append(fileRow(j, E[j][1]));
      sec.append(lst);
    } else if (DL[i]) say('Unchanged. A changed file adds or drops an import of it.');
    else say('Unchanged, and nothing it imports changed.');
    return sec;
  }
  function diffRoot(i) {
    const ch = diffChainOf(i);
    return ch.length ? E[ch[ch.length - 1]][1] : i;
  }

  // ---------- blast radius mode ----------
  function enterImpact(root, dir) {
    S.impact = { root, dir };
    recompute(false);
    if (sel >= 0) renderDetail();
  }
  function exitImpact() {
    if (!S.impact) return;
    const r = S.impact.root;
    S.impact = null;
    recompute(false);
    if (r >= 0 && vis[r]) {
      select(r);
      setTimeout(() => flyTo(r), 750);
    }
  }
  function updateImpactBar() {
    const bar = $('#impact');
    if (!imp) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.textContent = '';
    const n = N[imp.root],
      up = imp.dir === 'up';
    const t = el('div', 'ib-t');
    t.append(
      el('b', null, up ? 'Blast radius' : 'Dependencies'),
      document.createTextNode(' of '),
      el('code', null, n.name),
    );
    const cnt = {};
    for (const k of imp.order.slice(1)) {
      const a = areaOf(N[k].p);
      cnt[a] = (cnt[a] || 0) + 1;
    }
    const m = el(
      'div',
      'ib-m',
      `${imp.count.toLocaleString()} file${imp.count === 1 ? '' : 's'} ${up ? 'depend on it' : 'pulled in'} across ${imp.max} step${imp.max === 1 ? '' : 's'}` +
        (Object.keys(cnt).length
          ? ' · ' +
            Object.entries(cnt)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 4)
              .map(([a, c]) => `${a} ${c}`)
              .join(' · ')
          : ''),
    );
    const hint = el('div', 'ib-h', 'Hover a file to trace its path back');
    const sw = el('button', 'zb', up ? 'Show dependencies' : 'Show blast radius');
    sw.onclick = () => enterImpact(imp.root, up ? 'down' : 'up');
    const x = el('button', 'zb', 'Exit');
    x.onclick = exitImpact;
    const txtBox = el('div');
    txtBox.style.minWidth = '0';
    txtBox.append(t, m, hint);
    bar.append(txtBox, sw, x);
  }

  // ---------- search ----------
  const q = $('#q'),
    resBox = $('#results');
  let resIdx = 0,
    resList = [];
  function search(term) {
    const toks = term.toLowerCase().split(/\s+/).filter(Boolean);
    if (!toks.length) return [];
    const out = [];
    for (const i of ids) {
      const p = N[i].p.toLowerCase(),
        nm = N[i].name.toLowerCase();
      let sc = 0,
        ok = true;
      for (const t of toks) {
        if (nm.startsWith(t)) sc += 30;
        else if (nm.includes(t)) sc += 18;
        else if (p.includes(t)) sc += 6;
        else {
          ok = false;
          break;
        }
      }
      if (ok) {
        sc -= nm.length * 0.05 + N[i].p.length * 0.01;
        out.push([sc, i]);
      }
    }
    return out
      .sort((a, b) => b[0] - a[0])
      .slice(0, 14)
      .map((r) => r[1]);
  }
  function renderResults() {
    resBox.textContent = '';
    if (!q.value.trim()) {
      resBox.hidden = true;
      return;
    }
    if (!resList.length) {
      resBox.append(el('div', 'empty', 'No visible file matches. Check the filters.'));
      resBox.hidden = false;
      return;
    }
    resList.forEach((i, k) => {
      const n = N[i],
        r = el('div', 'res' + (k === resIdx ? ' on' : ''));
      r.setAttribute('role', 'option');
      const d = el('span', 'dot');
      d.style.background = colorOf[i];
      r.append(d, el('span', 'nm', n.name));
      const dr = el('span', 'dr');
      dr.textContent = '‎' + (n.dir || '/') + '‎';
      r.append(dr, el('span', 'ln', sizeLabel(n)));
      r.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        pick(i);
      });
      resBox.append(r);
    });
    resBox.hidden = false;
  }
  function pick(i) {
    select(i);
    flyTo(i);
    resBox.hidden = true;
    q.blur();
  }
  q.addEventListener('input', () => {
    resList = search(q.value);
    resIdx = 0;
    renderResults();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      resIdx = Math.min(resList.length - 1, resIdx + 1);
      renderResults();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      resIdx = Math.max(0, resIdx - 1);
      renderResults();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      if (resList[resIdx] != null) pick(resList[resIdx]);
    } else if (e.key === 'Escape') {
      q.value = '';
      resBox.hidden = true;
      q.blur();
    }
  });
  q.addEventListener('blur', () =>
    setTimeout(() => {
      resBox.hidden = true;
    }, 120),
  );
  q.addEventListener('focus', () => {
    if (q.value.trim()) renderResults();
  });
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input,select,textarea') || e.target.closest('.menu')) return;
    if (e.key === '/') {
      e.preventDefault();
      q.focus();
      q.select();
    } else if (e.key === 'Escape') {
      if (sel >= 0) select(-1);
      else exitImpact();
    } else if (e.key === 'f' || e.key === 'F') {
      sel >= 0 ? flyTo(sel) : fitAll(true);
    } else if (e.key === '0') fitAll(true);
    else if (e.key === '=' || e.key === '+') zoomAt(VW / 2, VH / 2, 1.4);
    else if (e.key === '-') zoomAt(VW / 2, VH / 2, 1 / 1.4);
  });

  // ---------- controls ----------
  $('#seg-view').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || V3.anim) return;
    const want = b.dataset.v,
      going3D = want === '3d';
    if ((S.view === '3d') === going3D) return;
    $('#seg-view')
      .querySelectorAll('button')
      .forEach((x) => {
        x.setAttribute('aria-pressed', x === b);
      });
    const c = toWorld(VW / 2, VH / 2);
    camAnim = null;
    const flat = { yaw: 0, tilt: 0, h: 0 },
      tilted = { yaw: V3.saved.yaw, tilt: V3.saved.tilt, h: 1 };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      S.view = want;
      Object.assign(V3, tilted);
      centerOn(c[0], c[1]);
      buildNav();
      invalidate();
      return;
    }
    if (going3D) {
      S.view = '3d';
      Object.assign(V3, flat);
      V3.anim = { from: flat, to: tilted, t0: performance.now(), dur: 900, c };
    } else {
      V3.saved = { yaw: V3.yaw, tilt: V3.tilt };
      V3.anim = {
        from: { yaw: V3.yaw, tilt: V3.tilt, h: 1 },
        to: flat,
        t0: performance.now(),
        dur: 800,
        c,
        done: () => {
          S.view = '2d';
          Object.assign(V3, tilted);
          centerOn(c[0], c[1]);
          buildNav();
        },
      };
    }
    buildNav();
    invalidate();
  });
  $('#zin').onclick = () => zoomAt(VW / 2, VH / 2, 1.5);
  $('#zout').onclick = () => zoomAt(VW / 2, VH / 2, 1 / 1.5);
  $('#zfit').onclick = () => fitAll(true);

  // ---------- toolbar menus ----------
  const CHECK_ICON =
    '<svg class="tk-icon" width="1em" height="1em" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4"/></svg>';
  const menus = [];
  // Picking a radio item closes its menu; other items leave it open for more picks.
  function menuRow(row, popup) {
    if (row.group) {
      const label = el('div', 'tk-list-group-label', row.group);
      label.setAttribute('role', 'presentation');
      return label;
    }
    if (row.separator) {
      const rule = el('div', 'tk-list-separator');
      rule.setAttribute('role', 'separator');
      return rule;
    }
    if (row.note) {
      const note = el('div', 'menu-note');
      note.setAttribute('role', 'presentation');
      note.append(...[row.note].flat());
      return note;
    }
    const checkable = row.checked != null;
    const item = el('button', 'tk-list-item');
    item.type = 'button';
    item.dataset.key = row.key;
    item.setAttribute('role', row.radio ? 'menuitemradio' : checkable ? 'menuitemcheckbox' : 'menuitem');
    if (checkable) item.setAttribute('aria-checked', row.checked);
    if (row.title) item.title = row.title;
    if (row.disabled) {
      item.dataset.disabled = '';
      item.setAttribute('aria-disabled', 'true');
    }
    const indicator = el('span', 'tk-list-indicator');
    if (checkable) indicator.innerHTML = CHECK_ICON;
    const text = el('span', 'tk-list-text');
    if (row.dot) {
      const dot = el('span', 'dot');
      dot.style.background = row.dot;
      text.append(dot);
    }
    text.append(row.text);
    item.append(indicator, text);
    if (row.trailing != null || row.only) {
      const trailing = el('span', 'tk-list-trailing');
      if (row.only) trailing.append(el('span', 'only', 'only'));
      if (row.trailing != null) trailing.append(el('span', 'ct', row.trailing));
      item.append(trailing);
    }
    item.addEventListener('click', (e) => {
      if (row.disabled) return;
      if (row.only && e.target.closest('.only')) row.only();
      else row.pick();
      refreshBar();
      if (row.radio) popup.hidePopover();
    });
    return item;
  }
  const enabledItems = (popup) => [...popup.querySelectorAll('.tk-list-item:not([data-disabled])')];
  function moveFocus(popup, e) {
    if (e.key === 'Tab') {
      popup.hidePopover();
      return;
    }
    const items = enabledItems(popup),
      last = items.length - 1,
      at = items.indexOf(document.activeElement);
    const next = { ArrowDown: at < last ? at + 1 : 0, ArrowUp: at > 0 ? at - 1 : last, Home: 0, End: last }[e.key];
    if (next == null) return;
    e.preventDefault();
    items[next]?.focus();
  }
  // Held to the trigger's nearer edge of the frame, so a menu by the right edge doesn't run off it.
  function placeUnder(popup, trigger) {
    const box = trigger.getBoundingClientRect(),
      gap = 6,
      margin = 8,
      fromRight = box.left + box.width / 2 > innerWidth / 2;
    popup.style.top = `${box.bottom + gap}px`;
    popup.style.left = fromRight ? 'auto' : `${Math.max(margin, box.left)}px`;
    popup.style.right = fromRight ? `${Math.max(margin, innerWidth - box.right)}px` : 'auto';
    popup.style.setProperty('--anchor-width', `${box.width}px`);
    popup.style.setProperty('--available-width', `${innerWidth - margin * 2}px`);
    popup.style.setProperty('--available-height', `${innerHeight - box.bottom - gap - margin}px`);
    popup.style.setProperty('--transform-origin', fromRight ? 'top right' : 'top left');
  }
  // Each menu is rebuilt from S as it opens and after every pick, so it never shows a stale choice.
  function defineMenu(name, rows) {
    const popup = $(`#m-${name}`),
      trigger = $(`#t-${name}`);
    const render = () => {
      const focusedKey = popup.contains(document.activeElement) ? document.activeElement.dataset.key : null;
      popup.textContent = '';
      for (const row of rows()) popup.append(menuRow(row, popup));
      if (focusedKey != null) popup.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus();
    };
    popup.addEventListener('beforetoggle', (e) => {
      if (e.newState !== 'open') {
        delete trigger.dataset.popupOpen;
        return;
      }
      render();
      placeUnder(popup, trigger);
      trigger.dataset.popupOpen = '';
      popup.dataset.startingStyle = '';
    });
    popup.addEventListener('toggle', (e) => {
      if (e.newState !== 'open') return;
      requestAnimationFrame(() => delete popup.dataset.startingStyle);
      const items = enabledItems(popup);
      const chosen = items.find(
        (item) => item.getAttribute('role') === 'menuitemradio' && item.getAttribute('aria-checked') === 'true',
      );
      (chosen || items[0])?.focus();
    });
    popup.addEventListener('keydown', (e) => moveFocus(popup, e));
    popup.addEventListener('pointermove', (e) => {
      const item = e.target.closest('.tk-list-item');
      if (item && !('disabled' in item.dataset) && item !== document.activeElement) item.focus({ preventScroll: true });
    });
    popup.addEventListener('focusin', (e) => e.target.closest('.tk-list-item')?.setAttribute('data-highlighted', ''));
    popup.addEventListener('focusout', (e) => e.target.closest('.tk-list-item')?.removeAttribute('data-highlighted'));
    menus.push({ popup, render });
  }

  // Flags that change only how files draw, not which files show.
  const DRAW_ONLY = new Set(['svgCode']);
  function flip(key) {
    S[key] = !S[key];
    if (DRAW_ONLY.has(key)) invalidate();
    else recompute(true);
    if (sel >= 0 && vis[sel]) renderDetail();
  }

  const changedCount = N.filter((n) => n.st).length;
  // Files importing changed code at each step out, counted over the whole graph whatever the filters hide.
  function radiusReach() {
    const atStep = [0];
    let linked = 0;
    for (let i = 0; i < NN; i++) {
      if (N[i].st) continue;
      if (DD[i] > 0) atStep[DD[i]] = (atStep[DD[i]] || 0) + 1;
      else if (DL[i]) linked++;
    }
    const within = (steps) => atStep.slice(1, steps + 1).reduce((sum, count) => sum + (count || 0), 0);
    return { deepest: atStep.length - 1, linked, within };
  }
  function showLabel(reach) {
    if (S.show === 'all') return 'Everything';
    if (S.show === 'changes') return 'Changed files';
    const steps = Math.min(S.depth, reach.deepest);
    if (steps >= reach.deepest) return 'Blast radius';
    return steps === 1 ? 'Direct importers' : `Importers · ${steps} steps`;
  }
  function radiusNote(reach) {
    const total = reach.within(reach.deepest);
    if (!changedCount) return 'No file changes between these two points.';
    if (!total) return 'Nothing else imports the changed files.';
    return [
      el('b', null, `${total.toLocaleString()} file${total > 1 ? 's' : ''}`),
      ` import changed code, directly or through other files${reach.linked ? ` · ${reach.linked} more linked by new or removed imports` : ''}.`,
    ];
  }
  if (DIFF)
    defineMenu('show', () => {
      const reach = radiusReach(),
        total = reach.within(reach.deepest),
        steps = Math.min(S.depth, reach.deepest);
      const option = (key, text, checked, trailing, pick) => ({ key, text, radio: true, checked, trailing, pick });
      const radius = (depth) => () => {
        S.show = 'radius';
        S.depth = depth;
        recompute(false);
      };
      const rows = [{ note: radiusNote(reach) }, { separator: true }];
      rows.push(
        option('show:changes', 'Changed files only', S.show === 'changes', changedCount.toLocaleString(), () => {
          S.show = 'changes';
          recompute(false);
        }),
      );
      for (const depth of [1, 2, 3])
        if (depth < reach.deepest)
          rows.push(
            option(
              `show:radius:${depth}`,
              depth === 1 ? 'Changed + direct importers' : `Changed + importers ${depth} steps out`,
              S.show === 'radius' && steps === depth,
              `+${reach.within(depth).toLocaleString()}`,
              radius(depth),
            ),
          );
      if (total)
        rows.push(
          option(
            'show:radius:all',
            'Changed + whole blast radius',
            S.show === 'radius' && steps === reach.deepest,
            `+${total.toLocaleString()}`,
            radius(99),
          ),
        );
      rows.push(
        option('show:all', 'Everything', S.show === 'all', NN.toLocaleString(), () => {
          S.show = 'all';
          recompute(false);
        }),
      );
      if (changedCount)
        rows.push(
          { separator: true },
          {
            key: 'highlightChange',
            text: 'Highlight affected files',
            title: 'Colour changed files and what imports them, and fade the rest',
            checked: S.highlightChange,
            pick: () => {
              S.highlightChange = !S.highlightChange;
              refreshBlockColors();
              buildNav();
              invalidate();
            },
          },
        );
      return rows;
    });

  const areaSizes = {};
  for (const n of N) {
    const p = n.p.split('/');
    const a = CONT.has(p[0]) && p.length > 2 ? p[0] + '/' + p[1] + '/' : p.length > 1 ? p[0] + '/' : '';
    if (a) areaSizes[a] = (areaSizes[a] || 0) + 1;
  }
  const areas = Object.entries(areaSizes).sort((a, b) => b[1] - a[1]);
  defineMenu('scope', () => {
    const folder = (area, text, count) => ({
      key: `scope:${area}`,
      text,
      radio: true,
      checked: S.scope === area,
      trailing: count.toLocaleString(),
      pick: () => {
        S.scope = area;
        recompute(false);
      },
    });
    const folders = [folder('', 'Whole repo', NN), ...areas.map(([area, count]) => folder(area, area.slice(0, -1), count))];
    if (!S.scope) return folders;
    const deps = {
      key: 'deps',
      text: 'Include what it imports',
      title: 'Also show files outside the folder that it imports directly',
      checked: S.deps,
      pick: () => {
        S.deps = !S.deps;
        recompute(false);
      },
    };
    return [deps, { separator: true }, ...folders];
  });

  const typeCount = {};
  for (const n of N) typeCount[n.k] = (typeCount[n.k] || 0) + 1;
  const presentTypes = Object.keys(TYPES)
    .filter((k) => typeCount[k])
    .sort((a, b) => typeCount[b] - typeCount[a]);
  const testCount = N.filter((n) => n.test).length,
    genCount = N.filter((n) => n.gen).length,
    genLines = N.reduce((a, n) => a + (n.gen ? n.l : 0), 0);
  // Each type's count among the files the other filters let through.
  function visibleTypeCounts() {
    const counts = {};
    for (const n of N)
      if ((S.tests || !n.test) && (S.gen || !n.gen) && (!S.scope || n.p.startsWith(S.scope)))
        counts[n.k] = (counts[n.k] || 0) + 1;
    return counts;
  }
  defineMenu('filter', () => {
    const counts = visibleTypeCounts();
    const flag = (key, text, trailing, title) => ({ key, text, trailing, title, checked: S[key], pick: () => flip(key) });
    const rows = [{ group: 'Include' }];
    if (genCount)
      rows.push(
        flag(
          'gen',
          'Generated code',
          genCount.toLocaleString(),
          `${genCount} generated files (${fmtL(genLines)} lines): files marked @generated or DO NOT EDIT, codegen output folders and schema dumps`,
        ),
      );
    if (testCount) rows.push(flag('tests', 'Tests', testCount.toLocaleString()));
    rows.push(
      flag('isolated', 'Unconnected files', null, 'Files with no imports to or from anything shown'),
      { separator: true },
      { group: 'File types' },
      ...presentTypes.map((k) => ({
        key: `type:${k}`,
        text: TYPES[k].name,
        dot: TYPES[k].color,
        checked: S.types.has(k),
        trailing: (counts[k] || 0).toLocaleString(),
        pick: () => {
          S.types.has(k) ? S.types.delete(k) : S.types.add(k);
          recompute(true);
        },
        only: () => {
          const already = S.types.size === 1 && S.types.has(k);
          S.types = new Set(already ? Object.keys(TYPES) : [k]);
          recompute(false);
        },
      })),
    );
    if (presentTypes.some((k) => !S.types.has(k)))
      rows.push({
        key: 'types:all',
        text: 'Show every type',
        pick: () => {
          S.types = new Set(Object.keys(TYPES));
          recompute(false);
        },
      });
    return rows;
  });

  defineMenu('links', () => {
    const draw = (value, text, title) => ({
      key: `edges:${value}`,
      text,
      title,
      radio: true,
      checked: S.edges === value,
      pick: () => {
        S.edges = value;
        invalidate();
      },
    });
    const legend = $('#legend').content.cloneNode(true);
    if (!highlightsChange()) legend.querySelector('[data-diff]').remove();
    return [
      { group: 'Draw' },
      draw('focus', 'The selected file’s imports', 'Only the selected or hovered file'),
      draw('all', 'Every import, faintly'),
      draw('none', 'None'),
      { separator: true },
      {
        key: 'through',
        text: 'See through barrels',
        title: 'Point imports at the file that defines the name, not the index.ts that re-exports it',
        checked: S.through,
        pick: () => flip('through'),
      },
      { key: 'typeEdges', text: 'Type-only imports', checked: S.typeEdges, pick: () => flip('typeEdges') },
      { key: 'mockEdges', text: 'vi.mock links', checked: S.mockEdges, pick: () => flip('mockEdges') },
      { separator: true },
      { note: [...legend.children] },
    ];
  });

  const SORTS = [
    ['name', 'Name'],
    ['lines', 'Lines of code'],
    ['churn', 'Lines changed'],
    ['fin', 'Imported by (most)'],
    ['fout', 'Imports (most)'],
    ['type', 'File type'],
  ];
  defineMenu('arrange', () => [
    { group: 'Layout' },
    ...[
      ['tiers', 'Stack by dependency'],
      ['packed', 'Packed'],
    ].map(([value, text]) => ({
      key: `arrange:${value}`,
      text,
      radio: true,
      checked: S.arrange === value,
      disabled: !!S.impact,
      title: S.impact ? 'Leave the blast radius or dependencies view to change the layout' : null,
      pick: () => {
        S.arrange = value;
        recompute(false);
      },
    })),
    { separator: true },
    { group: 'Sort files by' },
    ...SORTS.filter(([value]) => DIFF || value !== 'churn').map(([value, text]) => ({
      key: `sort:${value}`,
      text,
      radio: true,
      checked: S.sort === value,
      pick: () => {
        S.sort = value;
        recompute(true);
        fitAll(true);
      },
    })),
    { separator: true },
    {
      key: 'svgCode',
      text: 'SVGs as code',
      title: 'Show SVG source instead of the picture',
      checked: S.svgCode,
      pick: () => flip('svgCode'),
    },
  ]);

  const bar = $('#bar');
  // Labels drop to icons before the bar wraps onto a second row.
  function fitBar() {
    const wraps = () => bar.lastElementChild.offsetTop > bar.firstElementChild.offsetTop;
    bar.classList.remove('compact');
    bar.classList.toggle('compact', wraps());
    document.documentElement.style.setProperty('--bar-h', `${bar.offsetHeight}px`);
  }
  new ResizeObserver(fitBar).observe(bar);
  function refreshBar() {
    if (DIFF) $('#t-show .bar-value').textContent = showLabel(radiusReach());
    const folder = S.scope.slice(0, -1),
      folderValue = $('#t-scope .bar-value');
    folderValue.textContent = folder;
    folderValue.hidden = !folder;
    $('#t-scope').setAttribute('aria-label', folder ? `Folder: ${folder}` : 'Folder');
    const hiddenTypes = presentTypes.filter((k) => !S.types.has(k)).length;
    const badge = $('#t-filter .bar-badge');
    badge.hidden = !hiddenTypes;
    badge.textContent = hiddenTypes;
    badge.title = `${hiddenTypes} file type${hiddenTypes === 1 ? '' : 's'} hidden`;
    fitBar();
    for (const menu of menus) if (menu.popup.matches(':popover-open')) menu.render();
  }
  function updateStat() {
    let lines = 0;
    for (const i of ids) lines += N[i].l;
    const st = $('#stat');
    st.textContent = '';
    st.append(
      el('div', null, `${ids.length.toLocaleString()} files · ${fmtL(lines)} lines`),
      el(
        'div',
        null,
        `${activeE.length.toLocaleString()} imports${MM ? '' : loadMinimaps.failed ? ' · no code shapes' : ' · loading code…'}`,
      ),
    );
  }
  setTimeout(() => {
    const h = $('#hint');
    if (h) h.style.opacity = '0';
    setTimeout(() => h && h.remove(), 700);
  }, 9000);

  // A frame is asked for only when something changed, so an idle map costs nothing.
  function invalidate() {
    dirty = true;
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(frame);
  }
  function frame() {
    frameQueued = false;
    if (!dirty) return;
    dirty = false;
    draw();
  }
  resize();
  E = S.through ? TE : RE;
  rebuildAdj();
  lastThrough = S.through;
  computeDiffImpact();
  refreshBlockColors();
  if (DIFF) {
    let aff = 0;
    for (let i = 0; i < NN; i++) if (DD[i] > 0) aff++;
    // show the whole blast radius when it is small enough to read, else start with direct importers
    S.depth = aff <= 400 ? 99 : 1;
    if (!changedCount) S.show = 'all';
    $('#t-show').hidden = false;
  }
  recompute(false);
  refreshBar();
  invalidate();
  loadMinimaps();
  loadPictures();
  if (document.fonts && document.fonts.ready)
    document.fonts.ready.then(() => {
      truncCache = new Map();
      widthMemo = new Map();
      invalidate();
    });
  // A file chosen in the review's file list is found here; one filtered out of view can't be.
  addEventListener('message', (event) => {
    if (event.source !== parent || !event.data || event.data.type !== 'tk-review:focus-file') return;
    const i = N.findIndex((n) => n.p === event.data.path);
    if (i < 0 || !vis[i]) return;
    select(i);
    flyTo(i);
  });
})();

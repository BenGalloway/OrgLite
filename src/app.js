'use strict';
/* =====================================================================
   OrgLite — pure core (parser, index, refile). Exposed as window.OrgLite
   so the same logic can be ported 1:1 into the Tauri/Rust shell.
   ===================================================================== */
const now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const KW_SET = ['TODO','NEXT','STRT','PROJ','WAIT','WAITING','HOLD','IDEA','DONE','CANCELLED','KILL','NO'];

const HEAD_RE = /^(\s*)(\*+)\s+(.*)$/; // leading whitespace allowed (org semantics)
const TAG_RE  = /^(.*?)\s+(:[A-Za-z0-9_@#%]+(?::[A-Za-z0-9_@#%]+)*:)\s*$/;
const KW_RE   = new RegExp('^('+KW_SET.join('|')+')\\s+(.+)$');
const PRIO_RE = /^\[#([ABC])\]\s+(.+)$/;
const PROP_RE = /^:([A-Za-z0-9_]+):\s*(.*)$/;
const LINK_RE = /\[\[([^\[\]]+?)\](\[([^\[\]]*)\])?\]/g;
const CB_RE   = /^\[([ X-])\]\s*(.*)$/;

/** Parse org-flavored text into a heading tree + link & checkbox index.
    Line-oriented single pass; fast paths by first char so 100k lines stay quick. */
function parseOrg(content){
  const t0 = now();
  const lines = content.split('\n');
  const n = lines.length;
  const root = {level:0,title:'',children:[],startLine:-1,endLine:n-1};
  const stack = [root];
  const headings = [];
  const links = [];
  const listItems = [];
  let inBlock = false, inProps = false, curProps = null, curHead = null;

  for (let i = 0; i < n; i++){
    const line = lines[i];
    const c = line.charCodeAt(0);

    if (c === 35){ // '#'
      const t = line.trim();
      if (inBlock){ if (/^#\+END_/i.test(t)) inBlock = false; continue; }
      if (/^#\+BEGIN_/i.test(t)){ inBlock = true; }
      continue;
    }
    if (inBlock) continue;

    if (c === 42 || c === 32 || c === 9){ // '*' or indented (headings may be indented)
      const m = HEAD_RE.exec(line);
      if (m){
        const level = m[2].length;
        let title = m[3];
        let tags = [];
        const tm = TAG_RE.exec(title);
        if (tm){ title = tm[1]; tags = tm[2].slice(1,-1).split(':'); }
        let todo = null;
        const km = KW_RE.exec(title);
        if (km){ todo = km[1]; title = km[2]; }
        let priority = null;
        const pm2 = PRIO_RE.exec(title);
        if (pm2){ priority = pm2[1]; title = pm2[2]; }
        while (stack.length > 1 && stack[stack.length-1].level >= level) stack.pop();
        const parent = stack[stack.length-1];
        const h = {id:null, level, title, tags, todo, priority, props:{}, children:[], parent,
                   startLine:i, endLine:i, key:null};
        parent.children.push(h); headings.push(h); stack.push(h);
        curHead = h; inProps = false; curProps = null;
        continue;
      }
    }

    if (curHead && (c === 58 || c === 32 || c === 9)){ // ':' or indented (drawers can be indented)
      const t = line.trimStart();
      if (t.charCodeAt(0) === 58){
        if (inProps){
          if (/^:END:\s*$/.test(t)){ inProps = false; curHead.props = curProps || {}; curProps = null; }
          else { const pm = PROP_RE.exec(t); if (pm) (curProps || (curProps = {}))[pm[1]] = pm[2]; }
          continue;
        }
        if (/^:PROPERTIES:\s*$/.test(t)){ inProps = true; curProps = {}; continue; }
        if (/^(SCHEDULED|DEADLINE|CLOSED):/.test(t)) continue;
      }
    }

    if (line.includes('[[')){ // links can appear anywhere
      LINK_RE.lastIndex = 0;
      let lm;
      while ((lm = LINK_RE.exec(line)) !== null){
        links.push({line:i, target:lm[1], desc:(lm[3] || lm[1]), h:curHead});
      }
    }
    if (curHead && line.includes('[')){ // checkbox list items
      const lm = /^(\s*)([-+*]|\d+[.)])\s+(\[[ X-]\]\s+)?(.*)$/.exec(line);
      if (lm && lm[3]){
        const cb = lm[3].trim();
        if (/^\[[ X-]\]$/.test(cb)) listItems.push({line:i, checked: cb === '[X]', h:curHead});
      }
    }
  }
  // close out endLine for each heading (last line of its subtree)
  const open = [];
  for (let k = 0; k < headings.length; k++){
    const h = headings[k];
    while (open.length && open[open.length-1].level >= h.level) open.pop().endLine = h.startLine - 1;
    open.push(h);
  }
  while (open.length) open.pop().endLine = n - 1;
  // stable keys for fold-state carry-over
  for (const h of headings) h.key = h.props.ID || (h.level + ':' + (h.todo||'') + ':' + (h.priority||'') + ':' + h.title.toLowerCase());
  // line -> deepest heading containing it
  const lineHead = new Array(n).fill(null);
  for (const h of headings){
    for (let i = h.startLine; i <= h.endLine; i++) lineHead[i] = h;
  }

  return {root, headings, links, listItems, lines, n, parseMs: now() - t0, lineHead};
}

/** Build the global link/id index across files (org-roam's SQLite equivalent). */
function buildIndex(files){
  const t0 = now();
  const idIndex = new Map();   // id (lower) -> {file, h}
  const linkIndex = new Map(); // target (lower) -> [{file, line, desc, h}]
  const fileStems = new Map(); // stem (lower) -> file
  for (const f of files){
    const stem = f.name.replace(/\.org$/i,'').toLowerCase();
    fileStems.set(stem, f);
    for (const h of f.parsed.headings){
      if (h.props.ID) idIndex.set(h.props.ID.toLowerCase(), {file:f, h});
    }
    for (const l of f.parsed.links){
      const key = l.target.replace(/^id:/i,'').toLowerCase();
      if (!linkIndex.has(key)) linkIndex.set(key, []);
      linkIndex.get(key).push({file:f, line:l.line, desc:l.desc, h:l.h});
    }
  }
  return {idIndex, linkIndex, fileStems, ms: now() - t0};
}

/** Resolve a link target to a heading: [[id:X]], [[file stem]], [[title slug]]. */
function resolveTarget(target, index){
  const key = target.replace(/^id:/i,'').trim().toLowerCase();
  if (index.idIndex.has(key)) return index.idIndex.get(key);
  const stem = key.replace(/\.org$/,'');
  if (index.fileStems.has(stem)){
    const f = index.fileStems.get(stem);
    return {file:f, h: f.parsed.headings[0] || null};
  }
  for (const f of index.fileStems.values()){
    for (const h of f.parsed.headings){
      const slug = h.title.toLowerCase().replace(/\s+/g,'-');
      if (slug === key || h.title.toLowerCase() === key) return {file:f, h};
    }
  }
  return null;
}

/** Pure refile: move a subtree between two file texts.
    Returns new contents + insert position. Levels re-based onto target. */
function refileTexts(srcContent, srcH, destContent, destH, mode){
  const sl = srcContent.split('\n');
  const sub = sl.slice(srcH.startLine, srcH.endLine + 1);
  const srcLevel = srcH.level;
  const targetLevel = mode === 'child'
    ? (destH ? destH.level + 1 : 1)
    : (destH ? destH.level : 1);
  const delta = targetLevel - srcLevel;
  const sub2 = sub.map(l => {
    const m = /^(\s*)(\*+)/.exec(l);
    if (!m) return l;
    // heading lines normalize to column 0 (like org's refile); body keeps indentation
    const cnt = Math.max(1, m[2].length + delta);
    return '*'.repeat(cnt) + l.slice(m[0].length);
  });
  const insertAt = destH ? destH.endLine + 1 : 0;
  sl.splice(srcH.startLine, srcH.endLine - srcH.startLine + 1);
  const dl = destContent.split('\n');
  dl.splice(insertAt, 0, ...sub2);
  return {src: sl.join('\n'), dest: dl.join('\n'), insertAt, delta};
}

/** Deterministic 100,000-line stress file. */
function genStressContent(){
  const L = [];
  L.push('#+TITLE: Stress Test — 100,000 lines');
  L.push('#+FILETAGS: :bench:');
  L.push('');
  const tags = [':work:',':home:',':research:',':notes:'];
  const names = ['alpha','beta','gamma','delta'];
  for (let t = 1; t <= 1000; t++){
    L.push('* Area ' + t + tags[t % 4] + (t % 7 === 0 ? ':urgent:' : ''));
    for (let s = 1; s <= 99; s++){
      const lvl = 2 + (s % 2);
      let title = 'Task ' + t + '.' + s + ' ' + names[s % 4];
      if (s % 10 === 0) title = 'TODO ' + title;
      if (s % 37 === 0) title = 'Задача ' + t + '.' + s + ' — ' + title;
      if (s % 53 === 0) title = '任務 ' + t + '.' + s + ' ' + title;
      L.push('*'.repeat(lvl) + ' ' + title);
      if (s % 25 === 0) L.push('  SCHEDULED: <2026-08-24 Mon>');
      if (s % 30 === 0){
        L.push('  :PROPERTIES:'); L.push('  :ID: task-' + t + '-' + s); L.push('  :END:');
      }
      if (s % 40 === 0) L.push('  - [ ] subtask with [[id:note-big-picture][link to big picture]]');
      if (s === 50) L.push('  See also [[id:note-tauri][Tauri]] and [[org-in-2026]].');
    }
  }
  return L.join('\n');
}

/* =====================================================================
   Demo knowledge base (org-roam-flavored samples, cross-linked)
   ===================================================================== */
function seedFiles(){
  return [
    {name:'notes.org', content:
      '#+TITLE: Notes\n\n* Welcome\nWrite org-flavored notes here.\n- [ ] a task to try checkbox toggling\n- [ ] refile this file\'s heading into another file\n'}
  ];
}
/* =====================================================================
   UI layer
   ===================================================================== */
const $ = id => document.getElementById(id);
const state = {
  files: [],            // {name, content, parsed}
  current: 0,
  folds: {},            // "file::key" -> 0 open | 1 children-only | 2 folded
  sel: null,            // {fileIdx, key}
  index: null,
  rows: [],
  rendered: {i0:0, i1:0},
  dirty: false,
  fsaHandle: null,
  cur: {vi:0, col:0, mode:'normal'}, // cursor: visible row index, column, mode
  prevCurVi: null,             // last row that carried the block caret (cleared on move)
  visRows: [],          // [{no, h, foldMark, hidden}]
  rowCache: [],         // segs per painted row (for column mapping)
  il: null,             // active insert-mode element
  bufActive: true,
  undo: [],             // {label, items:[{f, prev}]}
  searchQ: '',
  gg: false,
  pan: null,
};
const ROWH = 26, BUFFER = 30;

const storage = () => { try { return window.localStorage; } catch(e){ return null; } };
function setDirty(d){
  state.dirty = d;
  const el = $('stSaved');
  if (el){ el.textContent = d ? '● unsaved changes' : '💾 saved'; el.classList.toggle('dirty', d); }
}
/* localStorage = crash recovery for unsaved changes. The embedded store in the
   HTML file itself is the source of truth; on successful save we clear this. */
function persist(){
  const s = storage(); if (!s) return;
  try {
    const small = state.files.filter(f => f.content.length < 400000);
    s.setItem('orglite.v2', JSON.stringify({
      files: small.map(f => ({name: f.name, content: f.content})),
      savedAt: Date.now()
    }));
  } catch(e){ /* quota — skip silently */ }
  setDirty(true);
}
function clearPersisted(){
  const s = storage(); if (!s) return;
  try { s.removeItem('orglite.v2'); s.removeItem('orglite.files.v1'); } catch(e){}
}
function loadPersisted(){
  const s = storage(); if (!s) return null;
  try {
    const raw = s.getItem('orglite.v2');
    if (!raw) return null;
    const o = JSON.parse(raw);
    return (o && Array.isArray(o.files)) ? o : null;
  } catch(e){ return null; }
}

function toast(msg, opts){
  opts = opts || {};
  const host = $('toastHost');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = '<span>' + esc(msg) + '</span>';
  if (opts.action){
    const b = document.createElement('button');
    b.className = 'act';
    b.textContent = opts.action.label;
    b.onclick = () => { opts.action.fn(); el.remove(); };
    el.appendChild(b);
  }
  host.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, opts.ms || 3800);
}

function reparseAll(){
  for (const f of state.files) f.parsed = parseOrg(f.content);
  state.index = buildIndex(state.files);
}
function currentFile(){ return state.files[state.current]; }

/* ---------- undo ---------- */
function pushUndo(label, items, focusFile){
  state.undo.push({label, items: items.map(x => ({f: x.f, prev: x.prev})), focusFile: focusFile || null});
  if (state.undo.length > 100) state.undo.shift();
  updateUndoBtn();
}
function doUndo(){
  const u = state.undo.pop();
  if (!u){ toast('Nothing to undo'); return; }
  for (const it of u.items) it.f.content = it.prev;
  reparseAll();
  if (u.focusFile && state.files.includes(u.focusFile)) openFile(state.files.indexOf(u.focusFile));
  renderAll();
  const f = currentFile();
  if (state.sel && state.sel.fileIdx === state.current){
    const h = findHeading(f, state.sel.key);
    if (h) selectHeading(f, h);
  }
  toast('Undid: ' + u.label);
  persist();
  updateUndoBtn();
}
function updateUndoBtn(){
  const b = $('btnUndo');
  if (b){ b.disabled = state.undo.length === 0; b.title = state.undo.length ? 'Undo (' + state.undo.length + ')' : 'Nothing to undo'; }
}

/* ---------- pane markup rendering ---------- */
function renderInline(text){
  let t = esc(text);
  t = t.replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
  t = t.replace(/\/([^\/\n]+)\//g, '<i>$1</i>');
  t = t.replace(/_([^_\n]+)_/g, '<u>$1</u>');
  t = t.replace(/=([^=\n]+)=/g, '<code>$1</code>');
  t = t.replace(/~([^~\n]+)~/g, '<code class="verb">$1</code>');
  t = t.replace(/\[\[([^\[\]]+?)\]\[([^\[\]]*)\]\]|\[\[([^\[\]]+)\]\]/g,
    (m, t1, d1, t2) => {
      const target = t1 || t2, desc = d1 || t2 || '';
      return '<a class="xlink" data-target="' + esc(target) + '">' + esc(desc || target) + '</a>';
    });
  return t;
}
function bindLinks(root){
  root.querySelectorAll('a.xlink').forEach(a => {
    a.onclick = e => { e.preventDefault(); e.stopPropagation(); openTarget(a.dataset.target); };
  });
}

/* ---------- fold state ---------- */
function getFold(f, h){ return state.folds[f.name + '::' + h.key] || 0; }
function setFold(f, h, v){ state.folds[f.name + '::' + h.key] = v; }

/* =====================================================================
   RENDERED BUFFER — one buffer that is both editor and viewer.
   Rows are the visible lines (headings + body, folds applied), rendered
   org-modern style with raw text preserved in segment maps for precise
   column <-> pixel mapping.
   ===================================================================== */
let _cw = null;
function charWidth(){
  if (_cw) return _cw;
  try {
    const s = document.createElement('span');
    s.style.cssText = 'font-family:ui-monospace,Consolas,Menlo,monospace;font-size:13px;visibility:hidden;position:absolute;white-space:pre';
    s.textContent = '0'.repeat(40);
    document.body.appendChild(s);
    _cw = s.getBoundingClientRect().width / 40;
    s.remove();
  } catch(e){ _cw = 0; }
  return _cw || 7.8;
}

/* segment: {html, raw, w} — w = visual width in px (raw.length * charW) */
function mkSeg(raw, cls){
  return {html: '<span class="mk ' + cls + '" style="width:' + (raw.length * charWidth()).toFixed(1) + 'px">' + esc(raw) + '</span>',
          raw: raw, w: raw.length * charWidth()};
}
function findClose(raw, start, ch){
  for (let i = start; i < raw.length; i++){
    if (raw[i] === '\\'){ i++; continue; }
    // closing marker: same char, not doubled, preceded by non-whitespace
    // (org: '*bold* and' is valid; '*foo *' is not)
    if (raw[i] === ch && raw[i+1] !== ch && i > 0 && raw[i-1] !== ' ' && raw[i-1] !== '\t') return i;
  }
  return -1;
}
/* Scan raw text into segments; hidden markers become .mk spans, styled
   content stays visible. Raw characters are preserved 1:1 across segments. */
function scanPretty(raw){
  const segs = [];
  const W = charWidth();
  const text = t => { if (t) segs.push({html: esc(t), raw: t, w: t.length * W}); };
  let i = 0, n = raw.length, buf = '';
  const flush = () => { text(buf); buf = ''; };
  while (i < n){
    const c = raw[i], next = raw[i+1];
    if (c === '\\'){ buf += (i + 1 < n) ? raw[i+1] : ''; i += 2; continue; }
    // bold *x*
    if (c === '*' && next && next !== '*' && next !== ' '){
      const j = findClose(raw, i+1, '*');
      if (j > i + 1){
        flush();
        segs.push(mkSeg('*', 'mb'));
        const inner = scanPretty(raw.slice(i+1, j));
        segs.push({html:'<b>', raw:'', w:0});
        for (const s of inner) segs.push(s);
        segs.push({html:'</b>', raw:'', w:0});
        segs.push(mkSeg('*', 'mb'));
        i = j + 1; continue;
      }
    }
    // italic /x/
    if (c === '/' && next && next !== '/' && next !== ' '){
      const j = findClose(raw, i+1, '/');
      if (j > i + 1){
        flush();
        segs.push(mkSeg('/', 'mi'));
        const inner = scanPretty(raw.slice(i+1, j));
        segs.push({html:'<i>', raw:'', w:0});
        for (const s of inner) segs.push(s);
        segs.push({html:'</i>', raw:'', w:0});
        segs.push(mkSeg('/', 'mi'));
        i = j + 1; continue;
      }
    }
    // underline _x_
    if (c === '_' && next && next !== '_' && next !== ' '){
      const j = findClose(raw, i+1, '_');
      if (j > i + 1){
        flush();
        segs.push(mkSeg('_', 'mu'));
        const inner = scanPretty(raw.slice(i+1, j));
        segs.push({html:'<u>', raw:'', w:0});
        for (const s of inner) segs.push(s);
        segs.push({html:'</u>', raw:'', w:0});
        segs.push(mkSeg('_', 'mu'));
        i = j + 1; continue;
      }
    }
    // code =x=
    if (c === '=' && next && next !== '=' && next !== ' '){
      const j = findClose(raw, i+1, '=');
      if (j > i + 1){
        flush();
        segs.push(mkSeg('=', 'mc'));
        const inner = raw.slice(i+1, j);
        segs.push({html:'<code>' + esc(inner) + '</code>', raw: inner, w: inner.length * W});
        segs.push(mkSeg('=', 'mc'));
        i = j + 1; continue;
      }
    }
    // verbatim ~x~
    if (c === '~' && next && next !== '~'){
      const j = findClose(raw, i+1, '~');
      if (j > i + 1){
        flush();
        segs.push(mkSeg('~', 'mv'));
        const inner = raw.slice(i+1, j);
        segs.push({html:'<code class="verb">' + esc(inner) + '</code>', raw: inner, w: inner.length * W});
        segs.push(mkSeg('~', 'mv'));
        i = j + 1; continue;
      }
    }
    // link [[target][desc]] or [[target]]
    if (c === '[' && raw.startsWith('[[', i)){
      const close = raw.indexOf(']]', i + 2);
      if (close !== -1){
        const inner = raw.slice(i + 2, close);
        const br = inner.indexOf('][');
        const target = br === -1 ? inner : inner.slice(0, br);
        const desc = br === -1 ? '' : inner.slice(br + 2);
        flush();
        segs.push(mkSeg('[[', 'lb'));
        if (desc){
          segs.push(mkSeg(target + '][', 'lt'));
          const dsegs = scanPretty(desc);
          const descHtml = dsegs.map(s => s.html).join('');
          segs.push({html:'<a class="xlink" data-target="' + esc(target) + '">' + (descHtml || esc(desc)) + '</a>',
                     raw: desc, w: desc.length * W});
        } else {
          segs.push({html:'<a class="xlink" data-target="' + esc(target) + '">' + esc(target) + '</a>',
                     raw: target, w: target.length * W});
        }
        segs.push(mkSeg(']]', 'rb'));
        i = close + 2; continue;
      }
    }
    // timestamp <2026-08-24 Mon>
    const tm = /^<(\d{4}-\d{2}-\d{2}[^>]*)>/.exec(raw.slice(i));
    if (tm){
      flush();
      segs.push({html:'<span class="ts">' + esc(tm[1]) + '</span>', raw: tm[1], w: tm[1].length * W});
      i += tm[0].length; continue;
    }
    buf += c; i++;
  }
  flush();
  return segs;
}

/* Stateless per-line fontification, used for LIVE editing: re-renders the
   pretty view of the line being typed without waiting for a full reparse. */
function linePrettyHtml(raw){
  const W = charWidth();
  const hm = /^(\s*)(\*+)(\s+)(.*)$/.exec(raw);
  if (hm){
    const leadWs = hm[1], stars = hm[2], rest = hm[3] + hm[4];
    const segs = [];
    if (leadWs) segs.push({html: esc(leadWs), raw: leadWs, w: leadWs.length * W});
    segs.push(mkSeg(stars, 'stars l' + Math.min(stars.length, 6)));
    let tail = rest;
    const kwm = KW_SET.map(k => ({k, m: new RegExp('^(\\s*)' + escRe(k) + '(\\s+)').exec(rest)})).find(x => x.m);
    if (kwm){
      const kw = kwm.k;
      const pre = kwm.m[1];  // leading whitespace (captured, NOT swallowed)
      const spTxt = kwm.m[2]; // space after the keyword
      if (pre) segs.push({html: esc(pre), raw: pre, w: pre.length * W});
      segs.push({html: '<span class="kw ' + kw + '">' + esc(kw) + '</span>', raw: kw, w: kw.length * W});
      if (spTxt) segs.push({html: esc(spTxt), raw: spTxt, w: spTxt.length * W});
      tail = rest.slice(kwm.m.index + kwm.m[0].length);
    }
    const prm = /^(\[#([ABC])\])(\s+)/.exec(tail);
    if (prm){
      segs.push({html:'<span class="prio ' + prm[2] + '">' + esc(prm[1]) + '</span>', raw: prm[1], w: prm[1].length * W});
      segs.push({html: esc(prm[3]), raw: prm[3], w: prm[3].length * W});
      tail = tail.slice(prm[0].length);
    }
    const tm = /^(.*?)(\s+)(:[A-Za-z0-9_@#%]+(?::[A-Za-z0-9_@#%]+)*:)(\s*)$/.exec(tail);
    let titlePart = tail, tagSep = '', tagPart = '', tagTrail = '';
    if (tm){ titlePart = tm[1]; tagSep = tm[2]; tagPart = tm[3]; tagTrail = tm[4] || ''; }
    for (const s of scanPretty(titlePart)) segs.push(s);
    if (tagPart){
      segs.push({html: esc(tagSep), raw: tagSep, w: tagSep.length * W});
      segs.push({html: '<span class="tagpill">' + esc(tagPart) + '</span>', raw: tagPart, w: tagPart.length * W});
    }
    if (tagTrail) segs.push({html: esc(tagTrail), raw: tagTrail, w: tagTrail.length * W});
    return segs.map(s => s.html).join('');
  }
  return bodySegs(raw).map(s => s.html).join('');
}

function headingSegs(h, raw){
  const segs = [];
  const W = charWidth();
  const leadM = /^(\s*)/.exec(raw);
  const leadWs = leadM ? leadM[1] : '';
  if (leadWs) segs.push({html: esc(leadWs), raw: leadWs, w: leadWs.length * W});
  const stars = '*'.repeat(h.level);
  segs.push(mkSeg(stars, 'stars l' + Math.min(h.level, 6)));
  let rest = raw.slice(leadWs.length + stars.length);
  // leading whitespace
  const ws = /^(\s+)/.exec(rest);
  if (ws){ segs.push({html: esc(ws[1]), raw: ws[1], w: ws[1].length * W}); rest = rest.slice(ws[1].length); }
  // TODO keyword
  if (h.todo){
    const km = new RegExp('^(' + escRe(h.todo) + ')(\\s+)').exec(rest);
    if (km){
      segs.push({html:'<span class="kw ' + h.todo + '">' + esc(h.todo) + '</span>', raw: h.todo, w: h.todo.length * W});
      const sp = km[2];
      segs.push({html: esc(sp), raw: sp, w: sp.length * W});
      rest = rest.slice(km[0].length);
    }
  }
  // priority cookie
  if (h.priority){
    const pm = new RegExp('^(\\[#' + escRe(h.priority) + '\\])(\\s+)').exec(rest);
    if (pm){
      segs.push({html:'<span class="prio ' + h.priority + '">[#' + esc(h.priority) + ']</span>', raw: pm[1], w: pm[1].length * W});
      segs.push({html: esc(pm[2]), raw: pm[2], w: pm[2].length * W});
      rest = rest.slice(pm[0].length);
    }
  }
  // tags at end
  let titlePart = rest;
  if (h.tags && h.tags.length){
    const ttm = /^(.*?)(\s+)(:[A-Za-z0-9_@#%]+(?::[A-Za-z0-9_@#%]+)*:)(\s*)$/.exec(rest);
    if (ttm){
      titlePart = ttm[1];
      segs.push(...scanPretty(titlePart));
      segs.push({html: esc(ttm[2]), raw: ttm[2], w: ttm[2].length * W});
      segs.push({html:'<span class="tagpill">' + esc(ttm[3]) + '</span>', raw: ttm[3], w: ttm[3].length * W});
      if (ttm[4]) segs.push({html: esc(ttm[4]), raw: ttm[4], w: ttm[4].length * W});
    } else {
      segs.push(...scanPretty(titlePart));
    }
  } else {
    segs.push(...scanPretty(titlePart));
  }
  return segs;
}

function bodySegs(raw){
  const W = charWidth();
  const cm = /^(\s*)([-+*]|\d+[.)])(\s+)(\[[ X-]\])(\s+)(.*)$/.exec(raw);
  if (cm){
    const segs = [];
    const lead = cm[1], bullet = cm[2], sp1 = cm[3], cb = cm[4], sp2 = cm[5], rest = cm[6];
    if (lead) segs.push({html: esc(lead), raw: lead, w: lead.length * W});
    if (/^[-+*]$/.test(bullet)) segs.push(mkSeg(bullet, 'bullet'));
    else segs.push({html: esc(bullet), raw: bullet, w: bullet.length * W});
    if (sp1) segs.push({html: esc(sp1), raw: sp1, w: sp1.length * W});
    const cls = cb === '[X]' ? 'cb done' : cb === '[-]' ? 'cb prog' : 'cb';
    segs.push(mkSeg(cb, cls));
    if (sp2) segs.push({html: esc(sp2), raw: sp2, w: sp2.length * W});
    for (const s of scanPretty(rest)) segs.push(s);
    return segs;
  }
  // plain list item: "- foo", "+ foo", "1. foo" (no checkbox)
  const lm = /^(\s*)([-+*]|\d+[.)])(\s+)(.*)$/.exec(raw);
  if (lm){
    const segs = [];
    const lead = lm[1], bullet = lm[2], sp1 = lm[3], rest = lm[4];
    if (lead) segs.push({html: esc(lead), raw: lead, w: lead.length * W});
    if (/^[-+*]$/.test(bullet)) segs.push(mkSeg(bullet, 'bullet'));
    else segs.push({html: '<span class="olnum">' + esc(bullet) + '</span>', raw: bullet, w: bullet.length * W});
    if (sp1) segs.push({html: esc(sp1), raw: sp1, w: sp1.length * W});
    for (const s of scanPretty(rest)) segs.push(s);
    return segs;
  }
  // planning lines: SCHEDULED/DEADLINE/CLOSED
  const plm = /^(\s*)(SCHEDULED|DEADLINE|CLOSED):(\s*)(.*)$/.exec(raw);
  if (plm){
    const segs = [];
    if (plm[1]) segs.push({html: esc(plm[1]), raw: plm[1], w: plm[1].length * W});
    const key = plm[2] + ':';
    segs.push({html:'<span class="plan-key">' + esc(key) + '</span>', raw: key, w: key.length * W});
    if (plm[3]) segs.push({html: esc(plm[3]), raw: plm[3], w: plm[3].length * W});
    for (const s of scanPretty(plm[4])) segs.push(s);
    return segs;
  }
  return scanPretty(raw);
}

function buildVisRows(f){
  const out = [];
  const pushBody = (a, b) => { for (let i = a; i <= b; i++) out.push({no: i, h: null, foldMark: false, hidden: 0}); };
  const visit = (h, hideChildren) => {
    out.push({no: h.startLine, h, foldMark: false, hidden: 0});
    const st = getFold(f, h);
    if (st === 2){ out.push({no: h.startLine, h, foldMark: true, hidden: h.endLine - h.startLine}); return; }
    const firstChild = h.children.length ? h.children[0].startLine : h.endLine + 1;
    pushBody(h.startLine + 1, firstChild - 1);
    for (const c of h.children) visit(c, hideChildren || st === 1);
  };
  const heads = f.parsed.headings;
  const first = heads.length ? heads[0].startLine : f.parsed.n;
  pushBody(0, first - 1); // preamble (before the first heading) — Emacs shows it, so do we
  for (const c of f.parsed.root.children) visit(c, false);
  if (heads.length){
    const last = heads[heads.length - 1].endLine;
    pushBody(last + 1, f.parsed.n - 1); // trailing lines after the last subtree
  }
  return out;
}

function rowHtml(row){
  const f = currentFile();
  const raw = f.parsed.lines[row.no];
  let segs, cls = 'bl';
  if (row.foldMark){
    return {html: '<span class="fld">… ' + row.hidden + ' line' + (row.hidden === 1 ? '' : 's') + ' hidden — Tab to open</span>', segs: [], cls: cls + ' fold'};
  }
  if (row.h){
    cls += ' head h' + Math.min(row.h.level, 6);
    if (row.h.todo === 'DONE' || row.h.todo === 'CANCELLED' || row.h.todo === 'KILL' || row.h.todo === 'NO') cls += ' done-head';
    segs = headingSegs(row.h, raw);
  } else {
    segs = bodySegs(raw);
    const t = raw.trim();
    if (/^:PROPERTIES:$/.test(t) || /^:END:$/.test(t) || /^:ID:/.test(t) || /^:[A-Za-z0-9_]+:/.test(t)){
      cls += ' drawer';
    } else if (/^(SCHEDULED|DEADLINE|CLOSED):/.test(t)){
      cls += ' plan';
    } else if (/^#\+(BEGIN|END)_/i.test(t)){
      cls += ' src-keyword';
    } else if (/^#\+/.test(t)){
      cls += ' dim';
    } else if (raw.trim() === ''){
      cls += ' blank';
    }
  }
  return {html: segs.map(s => s.html).join(''), segs, cls};
}

function bufferViewport(){ return $('bufferViewport'); }
function bufferRowEl(vi){
  return bufferViewport().querySelector('.bl[data-i="' + vi + '"]');
}

let rafPending = false;
function paintBuffer(){
  const vp = bufferViewport();
  if (!vp) return;
  const rows = state.visRows;
  const inner = $('bufferRows');
  inner.style.height = (rows.length * ROWH) + 'px';
  const maxScroll = Math.max(0, rows.length * ROWH - (vp.clientHeight || 0));
  if (vp.scrollTop > maxScroll) vp.scrollTop = maxScroll;
  const st = vp.scrollTop, hgt = vp.clientHeight || 400;
  let i0 = Math.max(0, Math.floor(st / ROWH) - BUFFER);
  let i1 = Math.min(rows.length, Math.ceil((st + hgt) / ROWH) + BUFFER);
  // always paint the cursor row
  i0 = Math.min(i0, state.cur.vi - 5);
  i1 = Math.max(i1, state.cur.vi + 6);
  i0 = Math.max(0, i0); i1 = Math.min(rows.length, i1);
  if (state.rendered.i0 === i0 && state.rendered.i1 === i1) { updateCurClass(); placeCursor(); return; }
  state.rendered = {i0, i1};
  const frag = document.createDocumentFragment();
  state.rowCache = [];
  const curVi = state.cur.vi;
  const curCls = state.cur.mode === 'insert' ? '' : ' cur';
  for (let i = i0; i < i1; i++){
    if (state.cur.mode === 'insert' && i === state.cur.vi && state.il){
      const keep = bufferRowEl(i);
      if (keep){ frag.appendChild(keep); state.rowCache[i] = []; continue; }
    }
    const row = rows[i];
    const r = rowHtml(row);
    const div = document.createElement('div');
    const doneKw = row.h && (row.h.todo === 'DONE' || row.h.todo === 'CANCELLED' || row.h.todo === 'KILL' || row.h.todo === 'NO');
    div.className = r.cls + (i === curVi ? curCls : '') +
                    (doneKw ? ' done' : '') +
                    (row.h ? '' : (/^(\s*)([-+*]|\d+[.)])\s+\[X\]/.test(currentFile().parsed.lines[row.no]) ? ' cb-on' : /^(\s*)([-+*]|\d+[.)])\s+\[-\]/.test(currentFile().parsed.lines[row.no]) ? ' cb-prog' : ''));
    div.style.top = (i * ROWH) + 'px';
    div.style.paddingLeft = row.h ? (10 + (row.h.level - 1) * 18) + 'px' : '10px';
    div.dataset.i = i;
    div.innerHTML = r.html;
    state.rowCache[i] = r.segs;
    frag.appendChild(div);
  }
  inner.replaceChildren(frag);
  placeCursor();
  updatePerf();
}

function colToX(segs, col){
  let x = 0, off = 0;
  for (const s of segs){
    const len = s.raw.length;
    if (!len){ continue; }
    if (off + len >= col){
      x += (col - off) * charWidth();
      return x;
    }
    x += s.w; off += len;
  }
  return x;
}
function xToCol(segs, x){
  let col = 0, acc = 0;
  for (const s of segs){
    if (acc + s.w >= x) return col + Math.round((x - acc) / charWidth());
    acc += s.w; col += s.raw.length;
  }
  return col;
}

function updateCurClass(){
  const prev = state.prevCurVi;
  const cur = state.cur.vi;
  if (prev !== null && prev !== cur){
    const pe = bufferRowEl(prev);
    if (pe) pe.classList.remove('cur');
  }
  // defensive: exactly one .cur in the painted window, ever
  const all = bufferViewport().querySelectorAll('.bl.cur');
  const curEl = bufferRowEl(cur);
  for (const r of all) if (r !== curEl) r.classList.remove('cur');
  if (curEl) curEl.classList.add('cur');
}
function placeCursor(){
  // remove the caret from the row it was last on (no ghost traces)
  if (state.prevCurVi !== null && state.prevCurVi !== state.cur.vi){
    const pe = bufferRowEl(state.prevCurVi);
    if (pe) pe.style.background = '';
  }
  state.prevCurVi = state.cur.vi;
  if (state.cur.mode === 'insert') return; // let the native text caret show
  const el = bufferRowEl(state.cur.vi);
  if (!el) return;
  const segs = state.rowCache[state.cur.vi] || [];
  const x = colToX(segs, state.cur.col) + (parseFloat(el.style.paddingLeft) || 0);
  const w = charWidth();
  el.style.background = 'linear-gradient(90deg, transparent ' + x.toFixed(1) + 'px, var(--curbg) ' + x.toFixed(1) + 'px, var(--curbg) ' + (x + w).toFixed(1) + 'px, transparent ' + (x + w).toFixed(1) + 'px)';
}

function viForLine(no){
  const rows = state.visRows;
  for (let i = 0; i < rows.length; i++){
    if (!rows[i].foldMark && rows[i].no === no) return i;
  }
  let best = 0, bd = 1e9;
  for (let i = 0; i < rows.length; i++){
    const d = Math.abs(rows[i].no - no);
    if (d < bd){ bd = d; best = i; }
  }
  return best;
}
function ensureLineVisible(no){
  if (viForLine(no) !== -1) return;
  const f = currentFile();
  let h = f.parsed.lineHead[no];
  let changed = false;
  while (h){ if (getFold(f, h) !== 0){ setFold(f, h, 0); changed = true; } h = h.parent; }
  if (changed){ state.visRows = buildVisRows(f); state.rendered = {i0:-1, i1:-1}; }
}
function setCursor(vi, col){
  const n = state.visRows.length;
  if (!n) return;
  vi = Math.max(0, Math.min(n - 1, vi));
  const no = state.visRows[vi].no;
  const line = currentFile().parsed.lines[no] || '';
  col = Math.max(0, Math.min(line.length, col));
  state.cur.vi = vi; state.cur.col = col;
  paintBuffer();
  ensureCursorVisible();
  updateStatus();
  followHeading();
}
/* The preview pane (and its backlinks) follows the cursor when it lands on a
   heading — debounced so rapid j/k hopping doesn't churn. */
function followHeading(){
  clearTimeout(state._paneTimer);
  state._paneTimer = setTimeout(() => {
    const row = state.visRows[state.cur.vi];
    if (!row) return;
    const f = currentFile();
    const h = row.h || f.parsed.lineHead[row.no];
    if (!h) return;
    if (state.sel && state.sel.fileIdx === state.current && state.sel.key === h.key) return;
    selectHeading(f, h);
    state.sel = {fileIdx: state.current, key: h.key};
  }, 60);
}
function ensureCursorVisible(){
  const vp = bufferViewport();
  if (!vp) return;
  const rowTop = state.cur.vi * ROWH;
  const ch = vp.clientHeight || 400;
  if (rowTop < vp.scrollTop + 4) vp.scrollTop = Math.max(0, rowTop - 4);
  else if (rowTop + ROWH > vp.scrollTop + ch - 4) vp.scrollTop = rowTop + ROWH - ch + 4;
  const segs = state.rowCache[state.cur.vi] || [];
  const el = bufferRowEl(state.cur.vi);
  const pad = el ? (parseFloat(el.style.paddingLeft) || 0) : 0;
  const x = colToX(segs, state.cur.col) + pad;
  const cw = vp.clientWidth || 800;
  if (x < vp.scrollLeft + 40) vp.scrollLeft = Math.max(0, x - 40);
  else if (x > vp.scrollLeft + cw - 40) vp.scrollLeft = x - cw + 40;
}
function curLineNo(){ return state.visRows[state.cur.vi] ? state.visRows[state.cur.vi].no : 0; }
function curLineText(){ return currentFile().parsed.lines[curLineNo()] || ''; }
function headingAtCursor(){
  const f = currentFile();
  const row = state.visRows[state.cur.vi];
  if (!row) return null;
  if (row.h) return row.h;
  return f.parsed.lineHead[row.no] || null;
}

function page(dir){
  const vp = bufferViewport();
  const rowsPer = Math.max(1, Math.round(((vp.clientHeight || 400) / ROWH) * dir));
  setCursor(state.cur.vi + rowsPer, state.cur.col);
}

/* ---------- line editing helpers (raw text, then reparse) ---------- */
function setLine(f, no, text){
  f.parsed.lines[no] = text;
  f.content = f.parsed.lines.join('\n');
}
function insertLine(f, no, text){
  f.parsed.lines.splice(no, 0, text);
  f.content = f.parsed.lines.join('\n');
}
function deleteLine(f, no){
  f.parsed.lines.splice(no, 1);
  f.content = f.parsed.lines.join('\n');
}

/* ---------- insert mode ---------- */
function nodeOffset(el, node, off){
  if (node === el) return off;
  let col = 0, found = false;
  const walk = n => {
    if (found) return;
    if (n === node){ col += off; found = true; return; }
    if (n.nodeType === 3){ col += n.length; return; }
    for (const c of n.childNodes){ walk(c); if (found) return; }
  };
  walk(el);
  return found ? col : 0;
}
function offsetNode(el, col){
  let remaining = col, target = null;
  const walk = n => {
    if (target) return;
    if (n.nodeType === 3){
      if (n.length >= remaining) target = {node: n, off: remaining};
      else remaining -= n.length;
      return;
    }
    for (const c of n.childNodes){ walk(c); if (target) return; }
  };
  walk(el);
  if (!target){
    const last = el.lastChild;
    target = {node: last || el, off: (last && last.nodeType === 3) ? last.length : 0};
  }
  return target;
}
/* caret as character offsets into the line's raw text (markup spans keep all
   raw characters as text, so offsets are stable across pretty re-renders) */
function caretRange(el){
  try {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return {start: 0, end: 0};
    const r = sel.getRangeAt(0);
    const start = nodeOffset(el, r.startContainer, r.startOffset);
    const end = r.collapsed ? start : nodeOffset(el, r.endContainer, r.endOffset);
    return {start: Math.max(0, start), end: Math.max(0, end)};
  } catch(e){ return {start: 0, end: 0}; }
}
function setRange(el, start, end){
  try {
    const sNode = offsetNode(el, Math.max(0, start));
    const eNode = offsetNode(el, Math.max(0, end));
    const r = document.createRange();
    r.setStart(sNode.node, Math.min(sNode.off, sNode.node.length || 0));
    r.setEnd(eNode.node, Math.min(eNode.off, eNode.node.length || 0));
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  } catch(e){}
}
function caretCol(el){ return caretRange(el).start; }
function setCaret(el, col){ setRange(el, col, col); }
function ilKey(e){
  const il = e.target;
  if (e.key === 'Escape'){ e.preventDefault(); commitInsert(); }
  else if (e.key === 'Enter'){
    e.preventDefault();
    if (e.ctrlKey) commitInsert({heading: e.shiftKey ? 'prev' : 'next'});
    else if (e.shiftKey) commitInsert({shift: true});
    else commitInsert({split: true});
  }
  else if (e.key === 'ArrowUp'){ e.preventDefault(); const col = caretCol(il); commitInsert(); setCursor(Math.max(0, state.cur.vi - 1), col); openInsert(state.cur.col); }
  else if (e.key === 'ArrowDown'){ e.preventDefault(); const col = caretCol(il); commitInsert(); setCursor(Math.min(state.visRows.length - 1, state.cur.vi + 1), col); openInsert(state.cur.col); }
  else if (e.key === 'Backspace' && caretCol(il) === 0){ e.preventDefault(); commitInsert({join:true}); }
  else if (e.key === 'Tab'){ e.preventDefault(); insertSpacesAtCaret(il, 2); }
  else if (e.shiftKey && e.key === 'Tab'){ e.preventDefault(); indentLineInsert(il, -2); }
  else if (e.ctrlKey && (e.key === '>' || e.key === '.')){ e.preventDefault(); indentLineInsert(il, 2); }
  else if (e.ctrlKey && (e.key === '<' || e.key === ',')){ e.preventDefault(); indentLineInsert(il, -2); }
}
function insertSpacesAtCaret(il, n){
  const col = caretCol(il);
  const s = il.textContent;
  il.textContent = s.slice(0, col) + ' '.repeat(n) + s.slice(col);
  setCaret(il, col + n);
  liveRender(il);
}
/* Indent/dedent the whole current line in insert mode (Ctrl+> / Ctrl+<).
   The caret follows the text it was on. */
function indentLineInsert(il, delta){
  const s = il.textContent;
  const lead = /^\s*/.exec(s)[0].length;
  const col = caretCol(il);
  if (delta > 0){
    il.textContent = ' '.repeat(delta) + s;
    setCaret(il, col + delta);
  } else {
    const rem = Math.min(lead, -delta);
    il.textContent = s.slice(rem);
    setCaret(il, Math.max(0, col - rem));
  }
  liveRender(il);
}
function clearSelection(){
  try { const s = window.getSelection(); if (s && s.removeAllRanges) s.removeAllRanges(); } catch(e){}
}

function prevHeadingLevel(f, no){
  for (let i = no - 1; i >= 0; i--){
    const m = /^(\s*)(\*+)\s/.exec(f.parsed.lines[i]);
    if (m) return m[2].length;
  }
  return 1;
}
function openInsert(col){
  const f = currentFile();
  const row = state.visRows[state.cur.vi];
  if (!row) return;
  state.cur.mode = 'insert';
  const el = bufferRowEl(state.cur.vi);
  if (!el) return;
  el.style.background = ''; // clear the block caret (native text caret takes over)
  el.innerHTML = '';
  const il = document.createElement('span');
  il.className = 'il';
  il.contentEditable = 'true';
  il.spellcheck = false;
  il.textContent = f.parsed.lines[row.no];
  il.addEventListener('keydown', ilKey);
  il.addEventListener('input', e => { if (!e.isComposing) scheduleLiveRender(il); });
  il.addEventListener('paste', e => {
    e.preventDefault();
    const t = (e.clipboardData || window.clipboardData || {getData:()=>''}).getData('text/plain').replace(/\r\n?/g, '\n');
    const col = caretCol(il);
    const s = il.textContent;
    il.textContent = s.slice(0, col) + t + s.slice(col);
    setCaret(il, col + t.length);
  });
  el.appendChild(il);
  state.il = il;
  setCaret(il, Math.min(col, il.textContent.length));
  il.focus();
  state.rowCache[state.cur.vi] = [];
  updateStatus();
  ensureCursorVisible();
}
let _liveTimer = null;
function scheduleLiveRender(il){
  clearTimeout(_liveTimer);
  _liveTimer = setTimeout(() => liveRender(il), 25);
}
/* Re-render the pretty view of the line being edited, restoring the caret.
   Only this one line is touched per keystroke — no full reparse needed. */
function liveRender(il){
  if (!state.il || state.il !== il) return; // already committed
  const f = currentFile();
  const row = state.visRows[state.cur.vi];
  if (!row) return;
  const raw = il.textContent.replace(/\r\n?/g, '');
  const r = caretRange(il);
  const html = linePrettyHtml(raw);
  if (il.innerHTML !== html){
    il.innerHTML = html;
    setRange(il, Math.min(r.start, raw.length), Math.min(r.end, raw.length));
  }
}

function commitInsert(opts){
  opts = opts || {};
  const il = state.il;
  if (!il) return;
  state.il = null;
  il.onkeydown = null;
  const f = currentFile();
  const row = state.visRows[state.cur.vi];
  if (!row){ state.cur.mode = 'normal'; updateStatus(); return; }
  const no = row.no;
  const oldText = f.parsed.lines[no];
  const text = il.textContent.replace(/\r\n?/g, '');
  const col = caretCol(il);
  state.cur.mode = 'normal';
  if (opts.heading){
    // Ctrl+RET: next-level heading · Ctrl+Shift+RET: level of the most previous heading
    const head = f.parsed.lineHead[no];
    const level = opts.heading === 'next' ? (head ? head.level + 1 : 1) : prevHeadingLevel(f, no);
    const nl = '*'.repeat(level) + ' ';
    pushUndo('new heading', [{f, prev: f.content}]);
    if (text !== oldText) setLine(f, no, text); // persist edits made while typing
    insertLine(f, no + 1, nl);
    clearSelection();
    reparseAll();
    renderAll();
    const caret = nl.length;
    setCursor(viForLine(no + 1), caret);
    openInsert(caret);
    return;
  }
  if (opts.shift){
    // Shift+RET: same item, one indent deeper
    const head = f.parsed.lineHead[no];
    const isHeadingLine = !!(head && head.startLine === no);
    const lead = /^\s*/.exec(text)[0].length;
    const lm = /^(\s*)([-+*]|\d+[.)])(\s+)/.exec(text);
    let nl;
    if (isHeadingLine) nl = '*'.repeat(head.level + 1) + ' ';
    else if (lm) nl = lm[1] + '  ' + lm[2] + lm[3];
    else nl = ' '.repeat(lead + 2);
    pushUndo('indent new line', [{f, prev: f.content}]);
    if (text !== oldText) setLine(f, no, text); // persist edits made while typing
    insertLine(f, no + 1, nl);
    clearSelection();
    reparseAll();
    renderAll();
    const caret = nl.length;
    setCursor(viForLine(no + 1), caret);
    openInsert(caret);
    return;
  }
  if (opts.split){
    const before = text.slice(0, col), after = text.slice(col);
    const head = f.parsed.lineHead[no];
    const isHeadingLine = !!(head && head.startLine === no); // headings start with '*' too!
    const base = head ? head.level * 2 : 0;
    const lm = /^(\s*)([-+*]|\d+[.)])(\s+)(.*)$/.exec(text);
    let nl, caret;
    if (isHeadingLine){
      if (after.trim() === ''){
        // caret at end of heading -> body line indented under it
        nl = ' '.repeat(base);
        caret = base;
      } else {
        // mid-heading -> split into a same-level heading (org RET)
        nl = '*'.repeat(head.level) + ' ' + after;
        caret = head.level + 1;
      }
    } else if (lm){
      // list item -> continue the list, same indent + bullet (org RET)
      nl = lm[1] + lm[2] + lm[3] + after;
      caret = lm[1].length + lm[2].length + lm[3].length;
    } else {
      // body -> newline with the same indent
      nl = ' '.repeat(/^\s*/.exec(text)[0].length) + after;
      caret = /^\s*/.exec(text)[0].length;
    }
    pushUndo('split line', [{f, prev: f.content}]);
    setLine(f, no, before);
    insertLine(f, no + 1, nl);
    clearSelection();
    reparseAll();
    renderAll();
    setCursor(viForLine(no + 1), caret);
    openInsert(caret);
    return;
  }
  if (opts.join){
    if (no <= 0){ renderAll(); updateStatus(); return; }
    const prevNo = no - 1;
    const prevText = f.parsed.lines[prevNo];
    pushUndo('join lines', [{f, prev: f.content}]);
    setLine(f, prevNo, prevText + text);
    deleteLine(f, no);
    reparseAll();
    renderAll();
    setCursor(viForLine(prevNo), prevText.length);
    openInsert(prevText.length);
    return;
  }
  if (text !== oldText){
    pushUndo('edit line', [{f, prev: f.content}]);
    setLine(f, no, text);
    reparseAll();
    persist();
  }
  clearSelection();
  renderAll();
  setCursor(viForLine(no), col);
  updateStatus();
}

/* ---------- normal-mode actions ---------- */
function newLineBelow(){
  const f = currentFile(); const no = curLineNo();
  pushUndo('new line', [{f, prev: f.content}]);
  insertLine(f, no + 1, '');
  reparseAll();
  persist();
  renderAll();
  setCursor(viForLine(no + 1), 0);
  openInsert(0);
}
function newLineAbove(){
  const f = currentFile(); const no = curLineNo();
  pushUndo('new line', [{f, prev: f.content}]);
  insertLine(f, no, '');
  reparseAll();
  persist();
  renderAll();
  setCursor(viForLine(no), 0);
  openInsert(0);
}
function cycleFoldAtCursor(){
  const f = currentFile();
  const h = headingAtCursor();
  if (!h) return;
  const st = (getFold(f, h) + 1) % 3;
  setFold(f, h, st);
  clearSelection(); // a lingering text selection can look like a stuck highlight
  state.visRows = buildVisRows(f);
  state.rendered = {i0:-1, i1:-1};
  const vi = viForLine(h.startLine);
  if (st === 2) setCursor(Math.min(vi + 1, state.visRows.length - 1), 0);
  else setCursor(vi, state.cur.col);
  paintBuffer();
  updateStatus();
}
function cycleTodo(){
  const f = currentFile();
  const h = headingAtCursor();
  if (!h) return;
  const order = ['TODO','NEXT','STRT','WAIT','DONE',''];
  const idx = order.indexOf(h.todo || '');
  const next = h.todo ? order[(idx + 1) % order.length] : 'TODO';
  const raw = f.parsed.lines[h.startLine];
  const m = /^(\s*\*+)(\s+)(.*)$/.exec(raw);
  if (!m) return;
  let rest = m[3];
  if (h.todo) rest = rest.replace(new RegExp('^' + escRe(h.todo) + '\\s+'), '');
  const newRaw = m[1] + m[2] + (next ? next + ' ' : '') + rest;
  pushUndo('toggle TODO', [{f, prev: f.content}]);
  setLine(f, h.startLine, newRaw);
  reparseAll();
  persist();
  renderAll();
  setCursor(viForLine(h.startLine), Math.min(state.cur.col, newRaw.length));
  toast(next ? '"' + h.title + '" → ' + next : '"' + h.title + '" → no TODO keyword');
}
function toggleCheckboxAtCursor(){
  const f = currentFile();
  const no = curLineNo();
  const t = curLineText();
  const m = /^(\s*(?:[-+*]|\d+[.)])\s+)\[([ X-])\](.*)$/.exec(t);
  if (!m) return;
  const nt = m[1] + '[' + (m[2] === 'X' ? ' ' : 'X') + ']' + m[3];
  pushUndo('toggle checkbox', [{f, prev: f.content}]);
  setLine(f, no, nt);
  reparseAll();
  persist();
  renderAll();
  setCursor(viForLine(no), state.cur.col);
}
function deleteChar(){
  const f = currentFile();
  const no = curLineNo();
  const t = curLineText();
  if (state.cur.col >= t.length) return;
  const nt = t.slice(0, state.cur.col) + t.slice(state.cur.col + 1);
  pushUndo('delete char', [{f, prev: f.content}]);
  setLine(f, no, nt);
  reparseAll();
  persist();
  renderAll();
  setCursor(viForLine(no), state.cur.col);
}
function flashRow(vi){
  const el = bufferRowEl(vi);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

/* ---------- buffer search (/) ---------- */
function openBufferSearch(){
  const box = $('bufferSearch');
  if (!box) return;
  box.classList.remove('hidden');
  const inp = $('bufferSearchInput');
  inp.value = state.searchQ || '';
  inp.focus();
  $('bufferSearchInfo').textContent = '';
}
function closeBufferSearch(){
  const box = $('bufferSearch');
  if (box) box.classList.add('hidden');
  bufferViewport().focus();
}
function jumpMatch(dir){
  const q = state.searchQ;
  if (!q){ return; }
  const f = currentFile();
  const start = curLineNo();
  const n = f.parsed.lines.length;
  const ql = q.toLowerCase();
  let i = start + (dir > 0 ? 1 : -1);
  for (let steps = 0; steps < n; steps++, i += dir){
    const idx = ((i % n) + n) % n;
    const at = f.parsed.lines[idx].toLowerCase().indexOf(ql);
    if (at !== -1){
      ensureLineVisible(idx);
      setCursor(viForLine(idx), at);
      flashRow(state.cur.vi);
      $('bufferSearchInfo').textContent = 'line ' + (idx + 1);
      return;
    }
  }
  toast('No match for “' + q + '”');
}

/* ---------- normal-mode key dispatch ---------- */
function handleNormalKey(e){
  const k = e.key;
  if (e.ctrlKey){
    const kl = k.toLowerCase();
    if (kl === 'f'){ e.preventDefault(); page(1); return true; }
    if (kl === 'b'){ e.preventDefault(); page(-1); return true; }
    if (kl === 'd'){ e.preventDefault(); page(0.5); return true; }
    if (kl === 'u'){ e.preventDefault(); page(-0.5); return true; }
    if (k === '>' || k === '.'){ e.preventDefault(); shiftSubtree(1); return true; }
    if (k === '<' || k === ','){ e.preventDefault(); shiftSubtree(-1); return true; }
    return false;
  }
  switch (k){
    case 'j': case 'ArrowDown': e.preventDefault(); setCursor(state.cur.vi + 1, state.cur.col); return true;
    case 'k': case 'ArrowUp': e.preventDefault(); setCursor(state.cur.vi - 1, state.cur.col); return true;
    case 'h': case 'ArrowLeft': e.preventDefault(); setCursor(state.cur.vi, state.cur.col - 1); return true;
    case 'l': case 'ArrowRight': e.preventDefault(); setCursor(state.cur.vi, state.cur.col + 1); return true;
    case 'Enter': e.preventDefault(); setCursor(state.cur.vi + 1, state.cur.col); return true;
    case '0': e.preventDefault(); setCursor(state.cur.vi, 0); return true;
    case '^': { e.preventDefault(); const t = curLineText(); const nz = t.search(/\S/); setCursor(state.cur.vi, nz === -1 ? 0 : nz); return true; }
    case '$': e.preventDefault(); setCursor(state.cur.vi, curLineText().length); return true;
    case 'g': e.preventDefault();
      if (state.gg){ state.gg = false; setCursor(0, 0); }
      else { state.gg = true; setTimeout(() => { state.gg = false; }, 600); }
      return true;
    case 'G': e.preventDefault(); setCursor(state.visRows.length - 1, 0); return true;
    case 'i': e.preventDefault(); openInsert(state.cur.col); return true;
    case 'a': e.preventDefault(); openInsert(Math.min(state.cur.col + 1, curLineText().length)); return true;
    case 'A': e.preventDefault(); openInsert(curLineText().length); return true;
    case 'I': { e.preventDefault(); const t = curLineText(); const nz = t.search(/\S/); openInsert(nz === -1 ? 0 : nz); return true; }
    case 'o': e.preventDefault(); newLineBelow(); return true;
    case 'O': e.preventDefault(); newLineAbove(); return true;
    case 't': e.preventDefault(); cycleTodo(); return true;
    case 'Tab': e.preventDefault(); cycleFoldAtCursor(); return true;
    case 'x': e.preventDefault(); deleteChar(); return true;
    case ' ': e.preventDefault(); toggleCheckboxAtCursor(); return true;
    case '/': e.preventDefault(); openBufferSearch(); return true;
    case 'n': if (state.searchQ){ e.preventDefault(); jumpMatch(1); return true; } return false;
    case 'N': if (state.searchQ){ e.preventDefault(); jumpMatch(-1); return true; } return false;
    case 'u': e.preventDefault(); doUndo(); return true;
    case 'R': e.preventDefault(); refileAtCursor(); return true;
    case 'z': e.preventDefault(); toggleFocusPane(); return true;
    case 'PageDown': e.preventDefault(); page(1); return true;
    case 'PageUp': e.preventDefault(); page(-1); return true;
    default: return false;
  }
}
/* Demote (+) / promote (-) the whole subtree under the cursor — org's
   org-metaright / org-metaleft, mapped to Ctrl+> / Ctrl+< (CAPS-as-Ctrl friendly). */
function shiftSubtree(delta){
  const f = currentFile();
  const h = headingAtCursor();
  if (!h){ toast('Cursor is not on a heading.'); return; }
  let minLevel = 99;
  for (let i = h.startLine; i <= h.endLine; i++){
    const m = /^(\s*)(\*+)/.exec(f.parsed.lines[i]);
    if (m) minLevel = Math.min(minLevel, m[2].length);
  }
  if (minLevel + delta < 1){
    if (delta < 0) toast('Cannot promote above level 1.');
    return;
  }
  const prev = f.content;
  const nl = f.parsed.lines.map((l, i) => {
    if (i < h.startLine || i > h.endLine) return l;
    const m = /^(\s*)(\*+)/.exec(l);
    if (!m) return l;
    const cnt = Math.max(1, m[2].length + delta);
    return m[1] + '*'.repeat(cnt) + l.slice(m[0].length);
  });
  f.content = nl.join('\n');
  pushUndo((delta > 0 ? 'demote subtree' : 'promote subtree') + ' “' + h.title + '”', [{f, prev}]);
  reparseAll();
  persist();
  renderAll();
  const hh = f.parsed.headings.find(x => x.startLine === h.startLine);
  if (hh) setCursor(viForLine(hh.startLine), 0);
  toast((delta > 0 ? 'Demoted' : 'Promoted') + ' “' + h.title + '” (' + h.level + ' → ' + Math.max(1, h.level + delta) + ')');
}

function refileAtCursor(){
  const f = currentFile();
  const h = headingAtCursor();
  if (!h){ toast('Cursor is not on a heading.'); return; }
  if (state.files.length < 2){ toast('Need at least one other file to refile into.'); return; }
  selectHeading(f, h);
  openRefileModal(f, h);
}
function toggleFocusPane(){
  const w = $('contentWrap');
  if (w.classList.contains('focus')){
    w.classList.remove('focus');
    w.style.gridTemplateColumns = '';
  } else {
    w.classList.add('focus');
    w.style.gridTemplateColumns = '1fr 6px ' + (state.paneW || 360) + 'px';
  }
}
function applyPaneWidth(px){
  state.paneW = px;
  const w = $('contentWrap');
  w.classList.add('focus');
  w.style.gridTemplateColumns = '1fr 6px ' + Math.round(px) + 'px';
}

/* ---------- selection & focus pane ---------- */
function selectHeading(f, h){
  state.sel = {fileIdx: state.files.indexOf(f), key: h.key};
  renderFocusPane(f, h);
}
function findHeading(f, key){
  for (const h of f.parsed.headings) if (h.key === key) return h;
  return null;
}
function crumbs(h){
  const parts = [];
  let cur = h;
  while (cur && cur.parent){ parts.unshift(cur.title); cur = cur.parent; }
  return parts;
}

function renderFocusPane(f, h){
  const crumb = $('fpCrumb');
  crumb.innerHTML = crumbs(h).map((t,i,a) =>
    i === a.length-1 ? '<b>' + esc(t) + '</b>' : esc(t) + '<span class="sep">›</span>').join('');
  crumb.prepend(esc(f.name) + ' <span class="sep">›</span> ');
  $('fpTitle').innerHTML = (h.todo ? '<span class="fp-kw ' + h.todo + '">' + h.todo + '</span>' : '') + (h.priority ? '<span class="fp-kw prio ' + h.priority + '">[#' + h.priority + ']</span> ' : '') + renderInline(h.title);
  $('fpTags').innerHTML = h.tags.map(t => '<span class="fp-tag">' + esc(t) + '</span>').join('');
  const lvl = $('fpMeta');
  lvl.innerHTML = '';
  const chip = (txt, cls) => { const s = document.createElement('span'); s.className = 'fp-chip ' + (cls||''); s.textContent = txt; lvl.appendChild(s); };
  chip('level ' + h.level);
  for (const k of Object.keys(h.props)) chip(k + ': ' + h.props[k], k === 'ID' ? 'id' : '');
  if (h.props.ID){
    const id = h.props.ID;
    chip('⚑ ' + (state.index.idIndex.get(id.toLowerCase()) ? 'backlinked' : 'no links yet'));
  }
  const lines = f.parsed.lines;
  const body = $('fpBody');
  body.innerHTML = '';
  const MAX = 500;
  let shown = 0, total = 0;
  /* narrowed view: the whole subtree — every subheading with the text under
     it — like org-narrow, refreshing with the cursor */
  const walk = (node, depth) => {
    if (shown >= MAX) return;
    const hb = document.createElement('div');
    hb.className = 'fp-head' + (node === h ? ' root' : '');
    hb.setAttribute('data-level', node.level);
    hb.style.paddingLeft = (Math.min(depth, 10) * 14) + 'px';
    hb.innerHTML = '<span class="fp-stars">•</span> ' +
      (node.todo ? '<span class="fp-kw ' + node.todo + '">' + esc(node.todo) + '</span> ' : '') +
      (node.priority ? '<span class="fp-kw prio ' + node.priority + '">[#' + node.priority + ']</span> ' : '') +
      renderInline(node.title) +
      node.tags.map(t => '<span class="fp-tag">' + esc(t) + '</span>').join('');
    hb.title = 'Jump to \u201c' + node.title + '\u201d';
    hb.onclick = () => jumpToLine(node.startLine, node);
    body.appendChild(hb);
    shown++;
    let sectionEnd = node.endLine;
    if (node.children.length) sectionEnd = Math.min(sectionEnd, node.children[0].startLine - 1);
    const sec = document.createElement('div');
    sec.className = 'fp-sec';
    sec.style.paddingLeft = (Math.min(depth + 1, 11) * 14) + 'px';
    for (let i = node.startLine + 1; i <= sectionEnd; i++){
      if (shown >= MAX) break;
      const raw = lines[i];
      const t = raw.trim();
      if (!t) continue;
      if (/^:PROPERTIES:\s*$/.test(t) || /^:END:\s*$/.test(t) || /^:ID:/.test(t)) continue;
      if (/^#\+/.test(t)){ total++; if (shown < MAX){ sec.appendChild(metaLine(raw)); shown++; } continue; }
      if (/^(SCHEDULED|DEADLINE|CLOSED):/.test(t)){ total++; if (shown < MAX){ sec.appendChild(metaLine(raw)); shown++; } continue; }
      if (/^#\+BEGIN_/i.test(t)){
        let j = i, buf = [];
        while (j <= sectionEnd && !/^#\+END_/i.test(lines[j].trim())){ buf.push(lines[j]); j++; }
        total += buf.length;
        if (shown < MAX){
          const pre = document.createElement('div');
          pre.className = 'codeblock';
          pre.textContent = buf.join('\n');
          sec.appendChild(pre);
          shown++;
        }
        i = j; continue;
      }
      const cb = /^(\s*)([-+*]|\d+[.)])\s+(\[[ X-]\])\s*(.*)$/.exec(raw);
      if (cb){
        total++;
        if (shown < MAX){
          const div = document.createElement('div');
          div.className = 'fp-item' + (cb[3] === '[X]' ? ' done' : '');
          const box = document.createElement('span');
          box.className = 'box' + (cb[3] === '[X]' ? ' on' : '');
          box.textContent = '✓';
          box.title = 'Toggle checkbox (writes back to the file)';
          box.onclick = () => toggleCheckbox(f, i);
          const txt = document.createElement('span');
          txt.className = 'txt';
          txt.innerHTML = renderInline(cb[4]);
          div.appendChild(box); div.appendChild(txt);
          sec.appendChild(div);
          shown++;
        }
        continue;
      }
      total++;
      if (shown < MAX){
        const p = document.createElement('div');
        p.className = 'pl';
        p.innerHTML = renderInline(raw);
        sec.appendChild(p);
        shown++;
      }
    }
    if (sec.childNodes.length) body.appendChild(sec);
    for (const c of node.children) walk(c, depth + 1);
  };
  walk(h, 0);
  bindLinks(body);
  if (total > MAX){
    const more = document.createElement('div');
    more.className = 'empty-note';
    more.textContent = '… subtree truncated at ' + MAX + ' lines (move the cursor to narrow further).';
    body.appendChild(more);
  }
  renderBacklinks();
}
function metaLine(raw){
  const d = document.createElement('div');
  d.className = 'meta-line';
  d.textContent = raw.trim();
  return d;
}

function toggleCheckbox(f, lineNo){
  const lines = f.content.split('\n');
  const line = lines[lineNo];
  const m = /^(\s*)([-+*]|\d+[.)])\s+\[([ X-])\](.*)$/.exec(line);
  if (!m) return;
  const newBox = m[3] === 'X' ? ' ' : 'X';
  const prev = f.content;
  lines[lineNo] = m[1] + m[2] + ' [' + newBox + ']' + m[4];
  f.content = lines.join('\n');
  pushUndo('toggle checkbox', [{f, prev}]);
  reparseAll();
  renderAll();
  persist();
  const h = f.parsed.headings.find(x => x.key === state.sel.key);
  if (h) renderFocusPane(f, h);
  updateStatus();
}

/* ---------- backlinks ---------- */
function renderBacklinks(){
  const list = $('linksList');
  const f = currentFile();
  const h = state.sel ? findHeading(f, state.sel.key) : null;
  if (!h){ list.innerHTML = '<div class="empty-note">Select a heading to see what links to it.</div>'; return; }
  const linked = [];
  const keys = new Set();
  if (h.props.ID) keys.add(h.props.ID.toLowerCase());
  keys.add(h.title.toLowerCase());
  keys.add(h.title.toLowerCase().replace(/\s+/g,'-'));
  for (const key of keys){
    for (const r of (state.index.linkIndex.get(key) || [])){
      if (r.file === f && r.h === h) continue;
      linked.push({file:r.file, line:r.line, desc:r.desc});
    }
  }
  const unlinked = [];
  const title = h.title.trim();
  if (title.length >= 5){
    for (const g of state.files){
      if (g === f) continue;
      let idx = 0, found = [];
      while ((idx = g.content.toLowerCase().indexOf(title.toLowerCase(), idx)) !== -1){
        found.push(idx); idx += title.length;
        if (found.length > 5) break;
      }
      if (found.length) unlinked.push({file:g, count:found.length, first:found[0]});
    }
  }
  let html = '';
  html += '<div class="blk-group"><h4>Linked references <span class="cnt">' + linked.length + '</span></h4>';
  if (!linked.length) html += '<div class="empty-note">No [[id:…]] or [[title]] links to this heading yet.</div>';
  for (const r of linked.slice(0, 40)){
    const lineNo = r.line + 1;
    html += '<div class="blk" data-open="' + esc(r.file.name) + '" data-line="' + lineNo + '">' +
            '<span class="bl">' + esc(r.file.name) + ':' + lineNo + '</span>' +
            '<span class="bd"><span class="t">' + esc(r.desc) + '</span></span></div>';
  }
  html += '</div><div class="blk-group"><h4>Unlinked mentions <span class="cnt">' + unlinked.length + '</span></h4>';
  if (!unlinked.length) html += '<div class="empty-note">No plain-text mentions of "' + esc(h.title) + '" in other files.</div>';
  for (const r of unlinked.slice(0, 20)){
    html += '<div class="blk" data-open="' + esc(r.file.name) + '"><span class="bl">' + esc(r.file.name) + '</span>' +
            '<span class="bd"><span class="t">' + r.count + ' mention' + (r.count > 1 ? 's' : '') + '</span></span></div>';
  }
  html += '</div>';
  list.innerHTML = html;
  list.querySelectorAll('.blk').forEach(el => {
    el.onclick = () => {
      const f2 = state.files.find(x => x.name === el.dataset.open);
      if (f2){
        openFile(state.files.indexOf(f2));
        if (el.dataset.line) jumpToLine(parseInt(el.dataset.line, 10) - 1, null);
      }
    };
  });
}

/* ---------- search (sidebar) ---------- */
function runSearch(q){
  const out = $('searchResults');
  if (!q){ out.innerHTML = '<div class="empty-note">Type to search all files. Pure text scan — try "tauri" or "big picture".</div>'; return; }
  const t0 = now();
  const ql = q.toLowerCase();
  let html = '', hits = 0;
  for (const f of state.files){
    const lines = f.parsed.lines;
    let count = 0;
    for (let i = 0; i < lines.length && count < 100; i++){
      const li = lines[i].toLowerCase();
      if (li.includes(ql)){
        const idx = li.indexOf(ql);
        const snip = lines[i].slice(Math.max(0, idx - 25), idx + q.length + 45);
        html += '<div class="sr" data-open="' + esc(f.name) + '" data-line="' + (i + 1) + '">' +
                '<span class="fn">' + esc(f.name) + '</span> <span class="ln">line ' + (i + 1) + '</span>' +
                '<div class="snip">' + renderInline(snip).replace(new RegExp('(' + escRe(q) + ')', 'gi'), '<mark>$1</mark>') + '</div></div>';
        count++; hits++;
      }
    }
  }
  if (!hits) html = '<div class="empty-note">No matches for "' + esc(q) + '".</div>';
  out.innerHTML = html;
  out.querySelectorAll('.sr').forEach(el => {
    el.onclick = () => {
      openFile(state.files.findIndex(x => x.name === el.dataset.open));
      jumpToLine(parseInt(el.dataset.line, 10) - 1, null);
    };
  });
  toast('Search: ' + hits + ' hit' + (hits === 1 ? '' : 's') + ' in ' + Math.round(now() - t0) + ' ms');
}

/* ---------- graph ---------- */
const gv = {x: 0, y: 0, k: 1};
function graphView(){
  const svg = $('graphSvg');
  svg.setAttribute('viewBox', gv.x + ' ' + gv.y + ' ' + (900 / gv.k).toFixed(2) + ' ' + (600 / gv.k).toFixed(2));
}
function renderGraph(){
  const svg = $('graphSvg');
  const nodes = new Map();
  const edges = [];
  const keyOf = (f, h) => h.props.ID || (f.name + '::' + h.startLine);
  for (const f of state.files){
    for (const h of f.parsed.headings){
      if (h.props.ID) nodes.set(keyOf(f, h), {f, h, deg: 0});
    }
  }
  for (const f of state.files){
    for (const l of f.parsed.links){
      const hit = resolveTarget(l.target, state.index);
      if (!hit || !hit.h) continue;
      const a = keyOf(f, l.h || f.parsed.headings[0] || {});
      const b = keyOf(hit.file, hit.h);
      if (!a || !b || a === b) continue;
      if (!nodes.has(a)) nodes.set(a, {f, h: l.h, deg: 0});
      if (!nodes.has(b)) nodes.set(b, hit);
      edges.push({a, b});
      nodes.get(a).deg++; nodes.get(b).deg++;
    }
  }
  svg.innerHTML = '';
  if (nodes.size === 0){
    svg.innerHTML = '<text x="10" y="30" fill="var(--muted)" font-size="12">No linked nodes — add :ID: properties and [[id:…]] links.</text>';
    return;
  }
  gv.x = 0; gv.y = 0; gv.k = 1;
  if (nodes.size > 400 || edges.length > 900){
    const fNodes = new Map();
    for (const [k, v] of nodes){
      if (!fNodes.has(v.f.name)) fNodes.set(v.f.name, {name: v.f.name, deg: 0});
      fNodes.get(v.f.name).deg += v.deg;
    }
    const fEdges = new Set();
    for (const e of edges){
      const fa = nodes.get(e.a).f.name, fb = nodes.get(e.b).f.name;
      if (fa !== fb) fEdges.add([fa, fb].sort().join('|'));
    }
    drawGraph(svg, [...fNodes.entries()].map(([k,v]) => ({k, name:v.name, deg:v.deg})),
      [...fEdges].map(s => { const p = s.split('|'); return {a:p[0], b:p[1]}; }), true);
    return;
  }
  drawGraph(svg, [...nodes.entries()].map(([k,v]) => ({k, f:v.f, h:v.h, name:v.h.title, deg:v.deg})),
    edges, false);
}
function drawGraph(svg, nodes, edges, fileMode){
  const W = 300, H = 400, cx = W/2, cy = H/2;
  const colors = ['#58a6ff','#3fb950','#d29922','#f85149','#bc8cff','#39c5cf','#ffa657','#a5d6ff'];
  const byFile = {};
  nodes.forEach(n => { const fn = fileMode ? n.name : n.f.name; (byFile[fn] = byFile[fn] || []).push(n); });
  const files = Object.keys(byFile);
  files.forEach((fn, fi) => {
    const list = byFile[fn];
    const base = (fi / files.length) * Math.PI * 2;
    const step = 0.9 / Math.max(1, list.length - 1);
    list.forEach((n, i) => {
      const ang = base + (i - (list.length - 1) / 2) * step;
      n.x = cx + Math.cos(ang) * (Math.min(H, W) / 2 - 30);
      n.y = cy + Math.sin(ang) * (Math.min(H, W) / 2 - 30);
      n.color = colors[fi % colors.length];
    });
  });
  let html = '';
  for (const e of edges){
    const a = nodes.find(n => n.k === e.a), b = nodes.find(n => n.k === e.b);
    if (!a || !b) continue;
    html += '<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) +
            '" stroke="var(--border)" stroke-width="1" opacity="0.7"/>';
  }
  for (const n of nodes){
    const r = fileMode ? Math.min(14, 4 + Math.log2(n.deg + 2) * 3) : Math.min(9, 3 + Math.log2(n.deg + 2) * 2);
    html += '<g class="gnode" data-idx="' + nodes.indexOf(n) + '">' +
            '<circle cx="' + n.x.toFixed(1) + '" cy="' + n.y.toFixed(1) + '" r="' + r + '" fill="' + n.color + '" opacity="0.85" stroke="var(--panel)" stroke-width="1.5"/>' +
            '<title>' + esc(n.name) + (fileMode ? '' : ' — ' + n.f.name) + '</title></g>';
  }
  svg.innerHTML = html;
  graphView();
  svg.querySelectorAll('.gnode').forEach(g => {
    g.style.cursor = 'pointer';
    g.onclick = () => {
      const n = nodes[parseInt(g.dataset.idx, 10)];
      if (fileMode){ openFile(state.files.findIndex(x => x.name === n.name)); return; }
      openFile(state.files.indexOf(n.f));
      jumpToLine(n.h.startLine, n.h);
    };
  });
}

/* ---------- open / jump / links ---------- */
function jumpToLine(no, h){
  const f = currentFile();
  if (h) selectHeading(f, h);
  ensureLineVisible(no);
  state.rendered = {i0:-1, i1:-1};
  setCursor(viForLine(no), 0);
  state.bufActive = true;
}
function openFile(idx, opts){
  opts = opts || {};
  if (idx < 0 || idx >= state.files.length) return;
  state.current = idx;
  const f = currentFile();
  $('fname').textContent = f.name;
  state.visRows = buildVisRows(f);
  state.rendered = {i0:-1, i1:-1};
  state.cur = {vi: 0, col: 0, mode: 'normal'};
  state.bufActive = true;
  closeBufferSearch();
  renderFileList();
  paintBuffer();
  if (!opts.keepSel){
    state.sel = null;
    if (f.parsed.headings.length){
      selectHeading(f, f.parsed.headings[0]);
      state.sel = {fileIdx: idx, key: f.parsed.headings[0].key};
    } else {
      $('fpBody').innerHTML = '<div class="empty-note">No headings in this file yet — press i to start typing.</div>';
      $('fpTitle').textContent = '';
      $('fpTags').innerHTML = '';
      $('fpMeta').innerHTML = '';
      $('fpCrumb').textContent = '';
      renderBacklinks();
    }
  } else if (state.sel){
    const h = findHeading(f, state.sel.key);
    if (h) renderFocusPane(f, h);
  }
  updateStatus();
}

function openTarget(target){
  const hit = resolveTarget(target, state.index);
  if (!hit){
    toast('Unresolved link: ' + target + (target.startsWith('http') ? ' (open externally)' : ''));
    return;
  }
  const idx = state.files.indexOf(hit.file);
  if (idx === -1) return;
  openFile(idx);
  if (hit.h) jumpToLine(hit.h.startLine, hit.h);
  toast('Opened ' + hit.file.name + (hit.h ? ' → ' + hit.h.title : ''));
}

/* ---------- refile ---------- */
function openRefileModal(f, h){
  const src = $('rfSource');
  src.innerHTML = '<b>' + esc(f.name) + '</b> › ' + crumbs(h).map(esc).join(' › ');
  const sel = $('rfFile');
  sel.innerHTML = '';
  state.files.forEach((g, i) => {
    if (g === f) return;
    const o = document.createElement('option');
    o.value = i; o.textContent = g.name;
    sel.appendChild(o);
  });
  if (!sel.options.length){ toast('Need at least one other file to refile into.'); return; }
  sel.onchange = fillTargets;
  fillTargets();
  $('rfModal').classList.add('open');
}
function fillTargets(){
  const f = state.files[parseInt($('rfFile').value, 10)];
  const sel = $('rfTarget');
  sel.innerHTML = '';
  const top = document.createElement('option');
  top.value = ''; top.textContent = '— top of file —';
  sel.appendChild(top);
  f.parsed.headings.forEach(h => {
    const o = document.createElement('option');
    o.value = h.startLine;
    o.textContent = '  '.repeat(Math.max(0, h.level - 1)) + (h.todo ? h.todo + ' ' : '') + h.title + (h.props.ID ? '  #' + h.props.ID : '');
    sel.appendChild(o);
  });
}
function doRefile(){
  const f = currentFile();
  const h = state.sel ? findHeading(f, state.sel.key) : null;
  if (!h) return;
  const destFile = state.files[parseInt($('rfFile').value, 10)];
  const targetVal = $('rfTarget').value;
  const destH = targetVal === '' ? null : destFile.parsed.headings.find(x => x.startLine === parseInt(targetVal, 10));
  const mode = document.querySelector('input[name="rfmode"]:checked').value;
  const res = refileTexts(f.content, h, destFile.content, destH, mode);
  pushUndo('refile “' + h.title + '”', [{f, prev: f.content}, {f: destFile, prev: destFile.content}], f);
  f.content = res.src;
  destFile.content = res.dest;
  reparseAll();
  persist();
  $('rfModal').classList.remove('open');
  const wasSel = h.key;
  openFile(state.files.indexOf(destFile));
  const moved = destFile.parsed.headings.find(x => x.startLine === res.insertAt) ||
                destFile.parsed.headings.find(x => x.startLine >= res.insertAt);
  if (moved){ selectHeading(destFile, moved); jumpToLine(moved.startLine, moved); }
  toast('Refiled “' + h.title + '” → ' + destFile.name + (destH ? ' under “' + destH.title + '”' : ' (top)') +
        (res.delta !== 0 ? ' · levels ' + (res.delta > 0 ? '+' : '') + res.delta : '') + ' · :ID: preserved, links intact');
}

/* ---------- file list / stress / io ---------- */
function renderFileList(){
  const list = $('filesList');
  list.innerHTML = '';
  state.files.forEach((f, i) => {
    const div = document.createElement('div');
    div.className = 'file-item' + (i === state.current ? ' active' : '');
    const nm = document.createElement('span');
    nm.className = 'nm'; nm.textContent = f.name;
    const ln = document.createElement('span');
    ln.className = 'ln'; ln.textContent = f.parsed.n.toLocaleString() + ' lines';
    div.appendChild(nm); div.appendChild(ln);
    div.onclick = () => openFile(i);
    list.appendChild(div);
  });
}

function addStressFile(){
  const t0 = now();
  const content = genStressContent();
  const genMs = now() - t0;
  const f = {name:'stress-100k.org', content};
  state.files.push(f);
  f.parsed = parseOrg(content);
  state.index = buildIndex(state.files);
  const parseMs = f.parsed.parseMs;
  for (const h of f.parsed.headings) setFold(f, h, 2);
  openFile(state.files.length - 1);
  persist();
  toast('Generated ' + f.parsed.headings.length.toLocaleString() + ' headings (' + f.parsed.n.toLocaleString() + ' lines) in ' + Math.round(genMs) + ' ms · parsed in ' + parseMs.toFixed(1) + ' ms · rows rendered: ' + (state.rendered.i1 - state.rendered.i0) + ' (virtualized)', {ms: 6000});
}

function newFile(){
  $('nfName').value = 'note-' + (state.files.length + 1) + '.org';
  $('newfileModal').classList.add('open');
  setTimeout(() => $('nfName').focus(), 50);
}
function doNewFile(){
  const name = $('nfName').value.trim();
  if (!name) return;
  if (state.files.some(f => f.name === name)){ toast('A file named "' + name + '" already exists.'); return; }
  $('newfileModal').classList.remove('open');
  const f = {name, content: '#+TITLE: ' + name.replace(/\.org$/i,'') + '\n\n* Welcome\nWrite org-flavored notes here.\n- [ ] a task to try checkbox toggling\n- [ ] refile this file\'s heading into another file\n'};
  state.files.push(f);
  reparseAll();
  openFile(state.files.length - 1);
  persist();
}

function downloadCurrent(){
  const f = currentFile();
  try {
    const blob = new Blob([f.content], {type:'text/plain;charset=utf-8'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  } catch(e){ toast('Download blocked in this preview — open orglite.html directly in your browser.'); }
}

function loadFromDisk(file){
  const reader = new FileReader();
  reader.onload = () => {
    const name = file.name;
    if (state.files.some(f => f.name === name)){ toast('Already have "' + name + '" — replacing it.'); state.files = state.files.filter(f => f.name !== name); }
    const f = {name, content: String(reader.result)};
    state.files.push(f);
    reparseAll();
    openFile(state.files.length - 1);
    persist();
    toast('Loaded ' + name + ' — ' + f.parsed.n.toLocaleString() + ' lines, ' + f.parsed.headings.length.toLocaleString() + ' headings');
  };
  reader.onerror = () => toast('Could not read file.');
  reader.readAsText(file);
}

/* ---------- status ---------- */
function updateStatus(){
  const f = currentFile();
  if (!f) return;
  const vi = Math.max(0, Math.min(state.cur.vi, state.visRows.length - 1));
  const no = state.visRows[vi] ? state.visRows[vi].no : 0;
  $('stFile').textContent = f.name + ' · line ' + (no + 1) + '/' + f.parsed.n + ' · col ' + state.cur.col;
  const m = $('stMode');
  if (m){
    m.textContent = state.cur.mode === 'insert' ? 'INSERT' : 'NORMAL';
    m.className = state.cur.mode;
  }
  $('stStats').textContent = f.parsed.n.toLocaleString() + ' lines · ' +
    (f.content.length / 1024).toFixed(1) + ' KB · ' +
    f.parsed.headings.length.toLocaleString() + ' headings · ' +
    state.files.length + ' file' + (state.files.length === 1 ? '' : 's');
  updatePerf();
}
function updatePerf(){
  const f = currentFile();
  $('stPerf').textContent = 'parse ' + f.parsed.parseMs.toFixed(1) + ' ms · index ' + state.index.ms.toFixed(1) + ' ms · rows ' +
    Math.min(state.visRows.length, state.rendered.i1 - state.rendered.i0) + '/' + state.visRows.length.toLocaleString() + ' rendered';
}

/* ---------- re-render everything ---------- */
function renderAll(){
  renderFileList();
  const f = currentFile();
  state.visRows = buildVisRows(f);
  state.rendered = {i0:-1, i1:-1};
  paintBuffer();
  if (state.sel && state.sel.fileIdx === state.current){
    const h = findHeading(f, state.sel.key);
    if (h) renderFocusPane(f, h); else renderBacklinks();
  } else {
    renderBacklinks();
  }
  updateStatus();
}

/* =====================================================================
   TiddlyWiki-style single-file persistence
   ===================================================================== */
function buildSavedHtml(){
  const data = {
    v: 2,
    savedAt: new Date().toISOString(),
    title: document.title,
    markup: window.__ORGLITE__.markup,
    css: window.__ORGLITE__.css,
    app: window.__ORGLITE__.app,
    files: state.files.map(f => ({name: f.name, content: f.content}))
  };
  const json = JSON.stringify(data)
    .replace(/</g, () => '\\u003C')
    .replace(/>/g, () => '\\u003E')
    .replace(/&/g, () => '\\u0026');
  const head = window.__ORGLITE_HEAD__ ||
    ('<!DOCTYPE html>\n' + document.documentElement.outerHTML.split('<!--ORGLITE-STORE-->')[0]);
  const tail = window.__ORGLITE_TAIL__ || '</body></html>';
  return head + '<!--ORGLITE-STORE-->' +
    '<script id="orglite-store" type="application/json">' + json + '</script>' + tail;
}

function downloadSavedCopy(htmlStr){
  const blob = new Blob([htmlStr], {type: 'text/html;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'orglite.html';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  clearPersisted();
  setDirty(false);
  toast('Downloaded updated copy — replace your orglite.html with this file to keep your changes.');
}

async function saveToFile(){
  let htmlStr;
  try { htmlStr = buildSavedHtml(); }
  catch(e){ toast('Could not build the save file: ' + e.message); return; }
  if (window.showSaveFilePicker){
    try {
      if (!state.fsaHandle){
        let suggested = 'orglite.html';
        try { const p = location.pathname.split('/').pop(); if (p && /\.html?$/i.test(p)) suggested = p; } catch(e){}
        state.fsaHandle = await window.showSaveFilePicker({
          suggestedName: suggested,
          types: [{description: 'HTML file', accept: {'text/html': ['.html']}}]
        });
      }
      const w = await state.fsaHandle.createWritable();
      await w.write(htmlStr);
      await w.close();
      clearPersisted();
      setDirty(false);
      toast('Saved in place — all notes are now inside ' + state.fsaHandle.name + '.');
      return;
    } catch(err){
      state.fsaHandle = null;
      if (err && err.name === 'AbortError') return;
      try { downloadSavedCopy(htmlStr); }
      catch(e2){ toast('Save is blocked in this sandboxed preview — download orglite.html and open it directly in a browser, then save again.'); }
    }
    return;
  }
  try { downloadSavedCopy(htmlStr); }
  catch(e){ toast('Save is blocked in this sandboxed preview — download orglite.html and open it directly in a browser, then save again.'); }
}

/* =====================================================================
   boot
   ===================================================================== */
function boot(){
  // theme preference
  const s0 = storage();
  let theme = 'dark';
  if (s0){ try { theme = s0.getItem('orglite.theme') || 'dark'; } catch(e){} }
  document.documentElement.dataset.theme = theme;

  const ls = loadPersisted();
  const storeFiles = (window.__ORGLITE__ && Array.isArray(window.__ORGLITE__.files) && window.__ORGLITE__.files.length)
    ? window.__ORGLITE__.files : null;
  const storeSavedAt = (window.__ORGLITE__ && window.__ORGLITE__.savedAt) || 0;
  let arr = null, recovered = false, fresh = false;
  if (ls && ls.files && ls.savedAt > storeSavedAt){ arr = ls.files; recovered = true; }
  else if (storeFiles){ arr = storeFiles; }
  else { arr = seedFiles(); fresh = true; }
  state.files = arr.map(x => ({name: x.name, content: x.content}));
  reparseAll();
  renderFileList();
  openFile(0);
  if (recovered) toast('Restored unsaved changes from browser storage — press 💾 Save to write them into this HTML file.');
  else if (fresh) toast('Fresh copy — demo notes loaded. Edit with j/k/h/l/i, then 💾 Save (Ctrl+S) to embed your data into this single HTML file.');

  // ---- buffer events ----
  const vp = bufferViewport();
  vp.addEventListener('scroll', () => {
    // commit an in-progress edit only if the edited row actually scrolled out of view
    // (caret-scrolls keep the row visible, so they don't clobber the edit)
    if (state.cur.mode === 'insert' && state.il){
      const rowEl = state.il.closest('.bl');
      if (rowEl){
        const top = parseInt(rowEl.style.top, 10);
        const vpTop = vp.scrollTop;
        const vpBot = vpTop + (vp.clientHeight || 400);
        if (top + ROWH < vpTop || top > vpBot) commitInsert();
      }
    }
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; paintBuffer(); });
  }, {passive: true});

  $('bufferRows').addEventListener('click', e => {
    const a = e.target.closest('a.xlink');
    if (a){ e.preventDefault(); openTarget(a.dataset.target); return; }
    const rowEl = e.target.closest('.bl');
    if (!rowEl) return;
    const vi = parseInt(rowEl.dataset.i, 10);
    const row = state.visRows[vi];
    if (!row) return;
    if (row.foldMark){ cycleFoldAtCursor(); return; }
    const segs = state.rowCache[vi] || [];
    const rect = rowEl.getBoundingClientRect();
    const x = e.clientX - rect.left - (parseFloat(rowEl.style.paddingLeft) || 0);
    const col = xToCol(segs, x);
    setCursor(vi, col);
    if (row.h) selectHeading(currentFile(), row.h);
    state.bufActive = true;
  });
  $('bufferRows').addEventListener('dblclick', e => {
    const rowEl = e.target.closest('.bl');
    if (!rowEl || e.target.closest('a.xlink')) return;
    const vi = parseInt(rowEl.dataset.i, 10);
    const row = state.visRows[vi];
    if (!row || row.foldMark) return;
    const segs = state.rowCache[vi] || [];
    const rect = rowEl.getBoundingClientRect();
    const x = e.clientX - rect.left - (parseFloat(rowEl.style.paddingLeft) || 0);
    setCursor(vi, xToCol(segs, x));
    openInsert(state.cur.col);
  });
  document.addEventListener('pointerdown', e => {
    state.bufActive = !!(e.target.closest && e.target.closest('#bufferViewport'));
    if (state.cur.mode === 'insert' && e.target !== state.il && !e.target.closest('#bufferViewport')) commitInsert();
  });

  // ---- keys ----
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's'){ e.preventDefault(); saveToFile(); return; }
    if (e.key === 'Escape'){
      $('rfModal').classList.remove('open'); $('helpModal').classList.remove('open'); $('newfileModal').classList.remove('open');
      if (!$('bufferSearch').classList.contains('hidden')){ closeBufferSearch(); return; }
      return;
    }
    // keys originating from the in-place editor (even a just-detached one) are handled there
    if (e.target && e.target.classList && e.target.classList.contains('il')) return;
    const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT' || e.target.isContentEditable);
    if (state.cur.mode === 'insert'){
      if (typing && e.target === state.il) return;
      if (!typing) commitInsert();
      return;
    }
    if (typing || !state.bufActive) return;
    handleNormalKey(e);
  });

  // buffer search
  $('bufferSearchInput').addEventListener('input', e => {
    state.searchQ = e.target.value;
    $('bufferSearchInfo').textContent = '';
    if (state.searchQ) jumpMatch(1);
  });
  $('bufferSearchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter'){ e.preventDefault(); jumpMatch(1); }
    else if (e.key === 'Escape'){ e.preventDefault(); closeBufferSearch(); }
  });

  // ---- sidebar tabs ----
  document.querySelectorAll('.sb-tab').forEach(t => {
    t.onclick = () => {
      document.querySelectorAll('.sb-tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.sb-panel').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      $(t.dataset.panel).classList.add('active');
      if (t.dataset.panel === 'pGraph') renderGraph();
    };
  });

  // ---- header actions ----
  $('btnSave').onclick = saveToFile;
  $('btnNew').onclick = newFile;
  $('btnLoad').onclick = () => $('fileInput').click();
  $('fileInput').onchange = e => { if (e.target.files[0]) loadFromDisk(e.target.files[0]); e.target.value = ''; };
  $('btnStress').onclick = addStressFile;
  $('btnDownload').onclick = downloadCurrent;
  $('btnUndo').onclick = doUndo;
  $('themeSel').onchange = e => {
    document.documentElement.dataset.theme = e.target.value;
    const ss = storage(); if (ss){ try { ss.setItem('orglite.theme', e.target.value); } catch(err){} }
  };
  $('btnFoldAll').onclick = () => {
    const f = currentFile();
    for (const h of f.parsed.headings) setFold(f, h, 2);
    state.visRows = buildVisRows(f);
    state.rendered = {i0:-1, i1:-1};
    setCursor(0, 0);
    paintBuffer();
  };
  $('btnUnfoldAll').onclick = () => {
    const f = currentFile();
    for (const h of f.parsed.headings) setFold(f, h, 0);
    state.visRows = buildVisRows(f);
    state.rendered = {i0:-1, i1:-1};
    paintBuffer();
  };
  $('btnRefileCur').onclick = refileAtCursor;
  $('btnFocusPane').onclick = toggleFocusPane;

  // ---- focus pane actions ----
  $('fpRefile').onclick = () => {
    const f = currentFile();
    const h = state.sel ? findHeading(f, state.sel.key) : null;
    if (h) openRefileModal(f, h); else toast('Select a heading first.');
  };
  $('fpCopyId').onclick = () => {
    const f = currentFile();
    const h = state.sel ? findHeading(f, state.sel.key) : null;
    if (!h){ toast('Select a heading first.'); return; }
    if (!h.props.ID){ toast('No :ID: on this heading. Add a :PROPERTIES: drawer with :ID: to make links survive refiles.'); return; }
    try { navigator.clipboard.writeText(h.props.ID); toast('Copied :ID: ' + h.props.ID); }
    catch(e){ toast('Clipboard blocked in preview — ID: ' + h.props.ID); }
  };
  $('fpJump').onclick = () => {
    const f = currentFile();
    const h = state.sel ? findHeading(f, state.sel.key) : null;
    if (h){ jumpToLine(h.startLine, h); bufferViewport().focus(); }
  };

  // ---- modals ----
  $('rfCancel').onclick = () => $('rfModal').classList.remove('open');
  $('rfConfirm').onclick = doRefile;
  $('rfModal').addEventListener('click', e => { if (e.target === $('rfModal')) $('rfModal').classList.remove('open'); });
  $('helpClose').onclick = () => $('helpModal').classList.remove('open');
  $('btnHelp').onclick = () => $('helpModal').classList.add('open');
  $('nfCancel').onclick = () => $('newfileModal').classList.remove('open');
  $('nfCreate').onclick = doNewFile;
  $('newfileModal').addEventListener('click', e => { if (e.target === $('newfileModal')) $('newfileModal').classList.remove('open'); });
  $('nfName').addEventListener('keydown', e => { if (e.key === 'Enter') doNewFile(); if (e.key === 'Escape') $('newfileModal').classList.remove('open'); });

  // ---- search (sidebar) ----
  let sdeb = null;
  $('searchInput').addEventListener('input', e => {
    clearTimeout(sdeb);
    sdeb = setTimeout(() => runSearch(e.target.value.trim()), 220);
  });
  $('btnGraphRefresh').onclick = renderGraph;

  // graph zoom / pan
  const gsvg = $('graphSvg');
  gsvg.addEventListener('wheel', e => {
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    gv.k = Math.min(8, Math.max(0.2, gv.k * f));
    graphView();
  }, {passive: false});
  gsvg.addEventListener('mousedown', e => {
    if (e.target.closest('.gnode')) return;
    state.pan = {x: e.clientX, y: e.clientY, vx: gv.x, vy: gv.y};
  });
  window.addEventListener('mousemove', e => {
    if (state.pan){
      gv.x = state.pan.vx - (e.clientX - state.pan.x) / gv.k;
      gv.y = state.pan.vy - (e.clientY - state.pan.y) / gv.k;
      graphView();
    }
  });
  window.addEventListener('mouseup', () => { state.pan = null; });

  // resizable preview pane
  {
    let pw = 360;
    try { const v = parseInt(storage().getItem('orglite.paneW'), 10); if (v) pw = v; } catch(e){}
    if (pw !== 360) applyPaneWidth(pw);
    const ph = $('paneHandle');
    ph.addEventListener('pointerdown', e => {
      e.preventDefault();
      ph.classList.add('dragging');
      let startW = state.paneW || 360;
      try {
        const cs = window.getComputedStyle($('contentWrap')).gridTemplateColumns;
        const parts = cs ? cs.split(' ') : [];
        const last = parseFloat(parts[parts.length - 1]);
        if (isFinite(last) && last > 0) startW = last;
      } catch(err){}
      state.paneDrag = {startX: e.clientX, startW};
    });
    window.addEventListener('pointermove', e => {
      if (!state.paneDrag) return;
      const w = Math.min(820, Math.max(180, state.paneDrag.startW + (state.paneDrag.startX - e.clientX)));
      applyPaneWidth(w);
      try { storage().setItem('orglite.paneW', String(Math.round(w))); } catch(err){}
    });
    window.addEventListener('pointerup', () => {
      state.paneDrag = null;
      ph.classList.remove('dragging');
    });
  }

  // unsaved-changes guard (classic TiddlyWiki behavior)
  window.addEventListener('beforeunload', e => {
    if (state.dirty){ e.preventDefault(); e.returnValue = ''; }
  });

  updateUndoBtn();
}

window.OrgLite = {parseOrg, buildIndex, resolveTarget, refileTexts, genStressContent, esc, escRe,
                  buildSavedHtml, saveToFile, setDirty, getState: () => state};
if (typeof document !== 'undefined') boot();

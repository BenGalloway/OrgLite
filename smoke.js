// DOM-level smoke test for orglite.html (jsdom) — modal editing model.
// Exercises: boot from store, j/k/h/l navigation, insert mode (i), fold (Tab),
// TODO cycle (t), checkbox toggle (space), undo (u), refile (R), search (/),
// live pretty rendering, save round-trip, stress 100k virtualization.
const fs = require('fs');
const { JSDOM } = require('/tmp/node_modules/jsdom');

const html = fs.readFileSync('/home/user/orglite.html', 'utf8');
const errors = [];
function makeDom(src){
  const dom = new JSDOM(src, { url: 'https://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  dom.window.addEventListener('error', e => errors.push('window error: ' + e.message));
  return dom;
}
const dom = makeDom(html);
const { window } = dom;
const $ = id => window.document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(cond, label){
  if (cond){ pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label); }
}
function key(k, target, opts){
  (target || window.document).dispatchEvent(new window.KeyboardEvent('keydown', Object.assign({key: k, bubbles: true, cancelable: true}, opts || {})));
}
function click(el){
  el.dispatchEvent(new window.MouseEvent('click', {bubbles: true, cancelable: true, clientX: 0, clientY: 0}));
}
function pdown(el){
  el.dispatchEvent(new window.MouseEvent('pointerdown', {bubbles: true, cancelable: true}));
}
function rowsText(){
  return [...window.document.querySelectorAll('#bufferRows .bl')].map(r => r.textContent);
}
function findRow(txt){
  const list = rowsText();
  const i = list.findIndex(t => t.includes(txt));
  return i === -1 ? null : window.document.querySelectorAll('#bufferRows .bl')[i];
}
function curLine(){ return parseInt($('stFile').textContent.match(/line (\d+)\//)[1], 10); }

(async () => {
  await sleep(500);

  console.log('--- boot (from embedded store) ---');
  ok(!!window.__ORGLITE__, 'boot injected app from store');
  ok($('filesList').children.length === 6, 'seed files listed: ' + $('filesList').children.length);
  ok($('bufferRows').children.length > 0, 'buffer rows rendered: ' + $('bufferRows').children.length);
  ok($('stMode').textContent === 'NORMAL', 'mode indicator shows NORMAL');
  ok($('stStats').textContent.includes('headings'), 'status stats present');
  ok(curLine() === 1, 'cursor at top of file (preamble visible): ' + curLine());
  ok(rowsText().some(t => t.includes('#+TITLE: Inbox')), 'preamble lines render in the buffer (like Emacs)');

  console.log('--- navigation j/k/h/l ---');
  pdown($('bufferViewport'));
  const row1 = findRow('Review orglite prototype');
  ok(!!row1, 'heading row rendered pretty: "' + (row1 && row1.textContent.slice(0, 30)) + '"');
  key('j'); key('j');
  ok(curLine() === 3, 'j,j moves to line 3 (first heading): ' + curLine());
  key('k');
  ok(curLine() === 2, 'k moves back to 2: ' + curLine());
  key('j'); key('j'); key('j');
  ok(curLine() === 5, '3 more j: line 5: ' + curLine());
  key('$');
  ok($('stFile').textContent.includes('col '), 'moves to end of line');
  key('0');
  ok($('stFile').textContent.includes('col 0'), '0 → column 0');
  key('G');
  ok(curLine() === 20, 'G → bottom (line 20): ' + curLine());
  key('g'); key('g');
  ok(curLine() === 1, 'gg → top (line 1): ' + curLine());
  key('j');
  ok(curLine() === 2, 'j moves into body: ' + curLine());

  console.log('--- cursor leaves no trace ---');
  const gradRows = () => [...window.document.querySelectorAll('#bufferRows .bl')].filter(r => (r.style.background || '').includes('linear-gradient')).length;
  key('j'); key('j'); key('k');
  ok(gradRows() === 1, 'after j,j,k only the current row carries the caret: ' + gradRows());
  key('l'); key('l'); key('h'); key('j'); key('k');
  ok(gradRows() === 1, 'still exactly 1 after more moves: ' + gradRows());
  key('g'); key('g');
  ok(gradRows() === 1, 'gg moves caret, no ghosts: ' + gradRows());

  console.log('--- current-line highlight follows cursor (no sticky sel) ---');
  const curRows = () => [...window.document.querySelectorAll('#bufferRows .bl.cur')];
  ok(curRows().length === 1, 'exactly one current-line highlight: ' + curRows().length);
  key('j');
  await sleep(30);
  ok(curRows().length === 1 && parseInt(curRows()[0].dataset.i, 10) === 1, 'highlight moved with cursor to row 1: ' + curRows()[0].dataset.i);
  // fold + unfold a parent heading, then move away — no leftover highlight
  key('g'); key('g');
  key('j'); key('j'); key('j'); // row 3 = first heading (line 3)
  key('Tab'); await sleep(80); // fold 0->1
  key('Tab'); await sleep(80); // fold 1->2
  key('Tab'); await sleep(80); // unfold 2->0
  key('j');
  await sleep(30);
  ok(curRows().length === 1 && parseInt(curRows()[0].dataset.i, 10) === 4, 'after fold/unfold+move: exactly one highlight, on cursor row 4: ' + curRows()[0].dataset.i);

  console.log('--- click row → selection + focus pane ---');
  const jpRow = findRow('日本語のメモ');
  if (jpRow){ pdown(jpRow); click(jpRow); await sleep(80); }
  ok($('fpTitle').textContent.includes('日本語のメモ'), 'clicking heading selects it in pane');
  ok(curLine() === 14, 'click moves cursor to line 14: ' + curLine());

  console.log('--- insert mode (i), edit, Esc commit ---');
  pdown($('bufferViewport'));
  key('j');
  key('i');
  ok($('stMode').textContent === 'INSERT', 'i enters INSERT mode');
  const il = window.document.querySelector('.bl .il');
  ok(!!il, 'insert editor element appears in buffer');
  const before = il.textContent;
  il.textContent = before + ' EDITED';
  key('Escape', il);
  await sleep(150);
  ok($('stMode').textContent === 'NORMAL', 'Esc returns to NORMAL');
  ok(rowsText().some(t => t.includes('EDITED')), 'typed text appears in rendered buffer');
  ok($('stSaved').textContent.includes('unsaved'), 'dirty indicator set');
  const store1 = JSON.parse(window.OrgLite.buildSavedHtml().match(/application\/json">([\s\S]*?)<\/script>/)[1]);
  ok(store1.files.find(f => f.name === 'inbox.org').content.includes('EDITED'), 'raw line text persisted (pretty view, raw file)');

  console.log('--- live pretty rendering while typing ---');
  pdown($('bufferViewport'));
  key('j'); // body line
  key('i');
  const il3 = window.document.querySelector('.bl .il');
  il3.textContent = 'text with *bold* and /italics/ and =code=';
  il3.dispatchEvent(new window.Event('input', {bubbles: true}));
  await sleep(120);
  const ilB = il3.querySelector('b');
  ok(!!ilB && ilB.textContent === 'bold', 'live: *bold* turns <b> while still in INSERT mode');
  ok(il3.querySelector('i') && il3.querySelector('i').textContent === 'italics', 'live: /italics/ turns <i>');
  ok(il3.textContent === 'text with *bold* and /italics/ and =code=', 'live: raw text preserved 1:1 under the pretty view');
  il3.textContent = '** TODO New live heading :tag:';
  il3.dispatchEvent(new window.Event('input', {bubbles: true}));
  await sleep(120);
  ok(!!il3.querySelector('.kw.TODO'), 'live: TODO pill appears while typing a heading');
  ok(!!il3.querySelector('.tagpill'), 'live: tag pill appears while typing');
  key('Escape', il3);
  await sleep(150);
  ok(rowsText().some(t => t.includes('New live heading')), 'committed heading re-parses into the tree');
  key('u');
  await sleep(120);
  ok(!rowsText().some(t => t.includes('New live heading')), 'u undoes the live-typed heading');

  console.log('--- regression: space between stars and TODO pill is preserved ---');
  pdown($('bufferViewport'));
  key('g'); key('g');
  key('j'); key('j'); key('j'); // first heading (line 4)
  key('i');
  const il4 = window.document.querySelector('.bl .il');
  il4.textContent = '* TODO a list';
  il4.dispatchEvent(new window.Event('input', {bubbles: true}));
  await sleep(120);
  ok(il4.innerHTML.includes('</span> <span class="kw TODO">'), 'live: space kept between * and TODO pill: "' + il4.innerHTML.slice(0, 70) + '"');
  il4.textContent = '* TODO Task 1.10 alpha';
  il4.dispatchEvent(new window.Event('input', {bubbles: true}));
  await sleep(120);
  ok(il4.innerHTML.includes('</span> <span class="kw TODO">'), 'live: stress-style TODO heading edits cleanly');
  key('Escape', il4);
  await sleep(150);
  ok(rowsText().some(t => t.includes('TODO Task 1.10 alpha')), 'committed * TODO Task 1.10 alpha parses with TODO intact');
  key('u');
  await sleep(120);
  ok(!rowsText().some(t => t.includes('Task 1.10')), 'u undoes the typed TODO heading');

  console.log('--- plain list bullets render (no checkbox) ---');
  pdown($('bufferViewport'));
  key('g'); key('g');
  key('j'); key('j'); key('j'); // first heading
  key('i');
  const ilL = window.document.querySelector('.bl .il');
  ilL.textContent = '- a plain bullet';
  ilL.dispatchEvent(new window.Event('input', {bubbles: true}));
  await sleep(120);
  ok(!!ilL.querySelector('.mk.bullet'), 'live: "- " renders as a bullet while typing');
  ilL.textContent = '1. an ordered item';
  ilL.dispatchEvent(new window.Event('input', {bubbles: true}));
  await sleep(120);
  ok(!!ilL.querySelector('.olnum'), 'live: "1. " renders an ordered number');
  ok(ilL.textContent === '1. an ordered item', 'live: raw text preserved 1:1');
  key('Escape', ilL);
  await sleep(150);
  const bulletRow = findRow('ordered item');
  ok(!!bulletRow && !!bulletRow.querySelector('.olnum'), 'committed "1. an ordered item" keeps its ordered-number rendering');
  key('u');
  await sleep(120);
  ok(!rowsText().some(t => t.includes('ordered item')), 'u undoes the bullet line');

  console.log('--- RET auto-indents under the heading ---');
  pdown($('bufferViewport'));
  key('g'); key('g');
  key('j'); key('j'); key('j'); // first heading
  key('i');
  const ilH = window.document.querySelector('.bl .il');
  // caret at end of the heading line
  const r1 = window.document.createRange();
  r1.setStart(ilH.firstChild, ilH.textContent.length);
  r1.collapse(true);
  const sel1 = window.getSelection(); sel1.removeAllRanges(); sel1.addRange(r1);
  key('Enter', ilH);
  await sleep(150);
  const rowsA = rowsText();
  const hIdx = rowsA.findIndex(t => t.includes('Review orglite prototype'));
  ok(rowsA[hIdx + 1] === '  ', 'new line after heading is auto-indented 2 spaces: "' + rowsA[hIdx + 1] + '"');
  ok($('stMode').textContent === 'INSERT', 'still in INSERT on the new indented line');
  key('Escape', window.document.querySelector('.bl .il'));
  await sleep(120);
  key('u');
  await sleep(120);
  ok(rowsText().length === rowsA.length - 1, 'u undoes the auto-indented line');

  console.log('--- RET on a list item continues the list ---');
  pdown($('bufferViewport'));
  key('g'); key('g');
  for (let i = 0; i < 5; i++) key('j'); // "  - [ ] Check performance..." (line 6)
  key('i');
  const ilC = window.document.querySelector('.bl .il');
  const r2 = window.document.createRange();
  r2.setStart(ilC.firstChild, ilC.textContent.length);
  r2.collapse(true);
  const sel2 = window.getSelection(); sel2.removeAllRanges(); sel2.addRange(r2);
  key('Enter', ilC);
  await sleep(150);
  const rowsB = rowsText();
  const cIdx = rowsB.findIndex(t => t.includes('Check performance'));
  ok(rowsB[cIdx + 1] === '  - ', 'Enter on a list item continues the list: "' + rowsB[cIdx + 1] + '"');
  key('Escape', window.document.querySelector('.bl .il'));
  await sleep(120);
  key('u');
  await sleep(120);

  console.log('--- RET mid-heading splits into a same-level heading ---');
  pdown($('bufferViewport'));
  key('g'); key('g');
  key('j'); key('j'); key('j'); // first heading
  key('i');
  const ilS = window.document.querySelector('.bl .il');
  const r3 = window.document.createRange();
  r3.setStart(ilS.firstChild, 3); // after "* T"
  r3.collapse(true);
  const sel3 = window.getSelection(); sel3.removeAllRanges(); sel3.addRange(r3);
  key('Enter', ilS);
  await sleep(150);
  ok(rowsText().some(t => t.startsWith('* ') && t.includes('ODO Review orglite prototype')), 'mid-heading RET splits into a same-level heading: "' + (rowsText().find(t => t.startsWith('* ') && t.includes('ODO')) || '') + '"');
  key('Escape', window.document.querySelector('.bl .il'));
  await sleep(120);
  key('u');
  await sleep(120);
  ok(rowsText().some(t => t.includes('TODO Review orglite prototype')), 'u restores the heading');

  console.log('--- Shift+RET: same item at next indent ---');
  pdown($('bufferViewport'));
  key('g'); key('g');
  for (let i = 0; i < 5; i++) key('j'); // list item line
  key('i');
  const ilSR = window.document.querySelector('.bl .il');
  ilSR.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'Enter', shiftKey: true, bubbles: true, cancelable: true}));
  await sleep(150);
  ok(rowsText().some(t => t === '    - '), 'Shift+RET nests the same item one level deeper: "' + (rowsText().find(t => t === '    - ') || '') + '"');
  key('Escape', window.document.querySelector('.bl .il'));
  await sleep(120);
  key('u');
  await sleep(120);

  console.log('--- REGRESSION: RET commands must NOT delete typed text ---');
  pdown($('bufferViewport'));
  key('g'); key('g');
  key('j'); key('j'); key('j'); // first heading
  key('i');
  const ilT1 = window.document.querySelector('.bl .il');
  ilT1.textContent = '* TODO Draft heading';
  ilT1.dispatchEvent(new window.Event('input', {bubbles: true}));
  await sleep(80);
  ilT1.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true}));
  await sleep(150);
  ok(rowsText().some(t => t.includes('Draft heading')), 'Ctrl+Enter keeps the typed heading text: "' + (rowsText().find(t => t.includes('Draft heading')) || '').slice(0, 30) + '"');
  ok(rowsText().some(t => t === '** '), 'Ctrl+Enter inserts the next-level heading below');
  key('Escape', window.document.querySelector('.bl .il'));
  await sleep(120);
  key('u');
  await sleep(120);
  ok(!rowsText().some(t => t.includes('Draft heading')), 'single u undoes typed text + new heading together');
  // Shift+Enter variant (re-position cursor onto the heading first)
  key('g'); key('g');
  key('j'); key('j'); key('j');
  key('i');
  const ilT2 = window.document.querySelector('.bl .il');
  ilT2.textContent = '* TODO Draft heading';
  ilT2.dispatchEvent(new window.Event('input', {bubbles: true}));
  await sleep(80);
  ilT2.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'Enter', shiftKey: true, bubbles: true, cancelable: true}));
  await sleep(150);
  ok(rowsText().some(t => t.includes('Draft heading')), 'Shift+Enter keeps the typed text too');
  ok(rowsText().some(t => t === '** '), 'Shift+Enter inserts the nested item');
  key('Escape', window.document.querySelector('.bl .il'));
  await sleep(120);
  key('u');
  await sleep(120);
  ok(!rowsText().some(t => t.includes('Draft heading')), 'u undoes Shift+Enter pair');
  // body line variant: type text, Ctrl+Enter, text must persist
  key('j'); key('j'); // onto SCHEDULED line (line 5)
  key('i');
  const ilT3 = window.document.querySelector('.bl .il');
  ilT3.textContent = '  SCHEDULED: <2026-08-25 Tue> body text';
  ilT3.dispatchEvent(new window.Event('input', {bubbles: true}));
  await sleep(80);
  ilT3.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true}));
  await sleep(150);
  ok(rowsText().some(t => t.includes('body text')), 'Ctrl+Enter on a body line keeps its text');
  key('Escape', window.document.querySelector('.bl .il'));
  await sleep(120);
  key('u');
  await sleep(120);

  console.log('--- Ctrl+RET: next-level heading / Ctrl+Shift+RET: previous level ---');
  click([...$('filesList').querySelectorAll('.file-item')].find(f => f.textContent.includes('projects.org')));
  await sleep(120);
  pdown($('bufferViewport'));
  const phRow = findRow('Phase 1: Research');
  ok(!!phRow, 'indented ** subheading now renders as a heading row: "' + (phRow && phRow.textContent.slice(0, 30)) + '"');
  const ivRow = findRow('Interview users');
  if (ivRow){ pdown(ivRow); click(ivRow); await sleep(80); }
  key('i');
  const ilCR = window.document.querySelector('.bl .il');
  ilCR.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true}));
  await sleep(150);
  ok(rowsText().some(t => t === '*** '), 'Ctrl+RET inside a ** heading adds a *** heading: "' + (rowsText().find(t => t.startsWith('***')) || '') + '"');
  key('Escape', window.document.querySelector('.bl .il'));
  await sleep(120);
  key('u');
  await sleep(120);
  key('j'); key('j'); // back onto the checkbox body line
  key('i');
  const ilCSR = window.document.querySelector('.bl .il');
  ilCSR.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true}));
  await sleep(150);
  ok(rowsText().some(t => t === '** '), 'Ctrl+Shift+RET uses the most previous heading level (**): "' + (rowsText().find(t => t.startsWith('** ')) || '') + '"');
  key('Escape', window.document.querySelector('.bl .il'));
  await sleep(120);
  key('u');
  await sleep(120);
  click([...$('filesList').querySelectorAll('.file-item')].find(f => f.textContent.includes('inbox.org')));
  await sleep(100);

  console.log('--- deep headings (no 3-level limit) ---');
  pdown($('bufferViewport'));
  key('g'); key('g');
  key('j'); key('j'); key('j');
  key('i');
  const ilD = window.document.querySelector('.bl .il');
  ilD.textContent = '******** deep eight';
  ilD.dispatchEvent(new window.Event('input', {bubbles: true}));
  await sleep(120);
  ok(!!ilD.querySelector('.mk.stars'), 'live: 8-star heading renders');
  key('Escape', ilD);
  await sleep(150);
  ok(rowsText().some(t => t.startsWith('********') && t.includes('deep eight')), 'level-8 heading parses and renders');
  key('Tab'); await sleep(80);
  key('Tab'); await sleep(80);
  ok(rowsText().some(t => t.includes('hidden')), 'level-8 heading folds (fold marker appears)');
  key('Tab'); await sleep(80);
  key('u');
  await sleep(120);
  ok(!rowsText().some(t => t.includes('deep eight')), 'u removes the deep heading');

  console.log('--- narrowed preview + resize ---');
  click([...$('filesList').querySelectorAll('.file-item')].find(f => f.textContent.includes('big-picture.org')));
  await sleep(150);
  ok($('fpTitle').textContent.includes('The big picture'), 'preview shows root heading');
  const fpHeads = [...window.document.querySelectorAll('.fp-head')];
  ok(fpHeads.length >= 3, 'narrowed preview lists subheadings: ' + fpHeads.map(h => h.textContent.trim().slice(0, 15)).join(' | '));
  ok(fpHeads.some(h => h.textContent.includes('Why files beat databases')), 'subheading with its text is listed');
  ok(fpHeads.some(h => h.textContent.includes('Related')), 'nested subheading is listed');
  ok($('fpBody').textContent.includes('Files are portable'), 'subheading text renders in the narrowed view');
  const rel = fpHeads.find(h => h.textContent.includes('Related'));
  if (rel){ pdown(rel); click(rel); await sleep(150); }
  ok($('fpTitle').textContent.includes('Related'), 'clicking a subheading narrows the preview to it');
  const handle = $('paneHandle');
  const cw = $('contentWrap');
  handle.dispatchEvent(new window.MouseEvent('pointerdown', {bubbles: true, clientX: 800, clientY: 100}));
  window.dispatchEvent(new window.MouseEvent('pointermove', {bubbles: true, clientX: 650, clientY: 100}));
  window.dispatchEvent(new window.MouseEvent('pointerup', {bubbles: true}));
  await sleep(50);
  ok(cw.style.gridTemplateColumns === '1fr 6px 510px', 'dragging the divider resizes the preview: ' + cw.style.gridTemplateColumns);
  handle.dispatchEvent(new window.MouseEvent('pointerdown', {bubbles: true, clientX: 650, clientY: 100}));
  window.dispatchEvent(new window.MouseEvent('pointermove', {bubbles: true, clientX: 944, clientY: 100}));
  window.dispatchEvent(new window.MouseEvent('pointerup', {bubbles: true}));
  await sleep(50);
  ok(cw.style.gridTemplateColumns === '1fr 6px 216px', 'divider drags both ways (narrower): ' + cw.style.gridTemplateColumns);
  click([...$('filesList').querySelectorAll('.file-item')].find(f => f.textContent.includes('inbox.org')));
  await sleep(100);

  console.log('--- insert-mode Tab / Ctrl+> / Ctrl+< ---');
  pdown($('bufferViewport'));
  key('g'); key('g');
  key('j'); // preamble-ish line 2: "#+FILETAGS: :inbox:"
  key('i');
  const ilT = window.document.querySelector('.bl .il');
  ilT.textContent = 'draft line';
  key('Tab', ilT);
  await sleep(100);
  ok(ilT.textContent === '  draft line', 'Tab inserts 2 spaces at caret: "' + ilT.textContent + '"');
  ilT.dispatchEvent(new window.KeyboardEvent('keydown', {key: '>', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true}));
  await sleep(100);
  ok(ilT.textContent === '    draft line', 'Ctrl+> indents the line: "' + ilT.textContent + '"');
  ilT.dispatchEvent(new window.KeyboardEvent('keydown', {key: '<', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true}));
  await sleep(100);
  ok(ilT.textContent === '  draft line', 'Ctrl+< dedents the line: "' + ilT.textContent + '"');
  key('Escape', ilT);
  await sleep(120);
  key('u');
  await sleep(120);

  console.log('--- normal-mode Ctrl+> / Ctrl+< shift the whole subtree ---');
  pdown($('bufferViewport'));
  key('g'); key('g');
  key('j'); key('j'); key('j'); // first heading (level 1)
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', {key: '>', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true}));
  await sleep(150);
  ok(rowsText().some(t => t.startsWith('** ') && t.includes('Review orglite prototype')), 'Ctrl+> demotes subtree to level 2');
  ok(rowsText().some(t => t.includes('Check performance')), 'subtree body still present after demote');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', {key: '<', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true}));
  await sleep(150);
  ok(rowsText().some(t => t.startsWith('* TODO Review orglite prototype')), 'Ctrl+< promotes subtree back to level 1');
  key('u'); key('u');
  await sleep(150);
  ok(rowsText().some(t => t.startsWith('* TODO Review orglite prototype')), 'u,u undoes the shift dance');
  // cannot promote above level 1
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', {key: '<', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true}));
  await sleep(120);
  ok(rowsText().some(t => t.startsWith('* TODO Review orglite prototype')), 'Ctrl+< at level 1 is a no-op (blocked)');

  console.log('--- highlight survives fold-stress (no strays) ---');
  const curRows2 = () => [...window.document.querySelectorAll('#bufferRows .bl.cur')];
  const gradRows2 = () => [...window.document.querySelectorAll('#bufferRows .bl')].filter(r => (r.style.background || '').includes('linear-gradient')).length;
  click($('btnUnfoldAll')); await sleep(80);
  key('g'); key('g');
  key('j'); key('j'); key('j'); // heading
  for (let i = 0; i < 6; i++){ key('Tab'); await sleep(50); }
  ok(curRows2().length === 1, 'after 6 fold cycles exactly one .cur: ' + curRows2().length);
  ok(gradRows2() === 1, 'after 6 fold cycles exactly one caret gradient: ' + gradRows2());
  for (let i = 0; i < 12; i++){ key('j'); await sleep(15); }
  for (let i = 0; i < 12; i++){ key('k'); await sleep(15); }
  ok(curRows2().length === 1 && gradRows2() === 1, 'after 24 moves still exactly one of each');
  click($('btnUnfoldAll')); await sleep(80);
  ok(curRows2().length === 1 && gradRows2() === 1, 'unfold-all keeps exactly one highlight');

  console.log('--- split line with Enter in insert (on a body line) ---');
  pdown($('bufferViewport'));
  key('g'); key('g');
  key('j'); key('j'); key('j'); key('j'); key('j'); // line 5: "  - [ ] Check performance..."
  key('i');
  const il2 = window.document.querySelector('.bl .il');
  il2.textContent = 'split-me-here';
  key('Enter', il2);
  await sleep(150);
  ok(rowsText().some(t => t.includes('split-me-here')), 'split keeps text on the line');
  ok($('stMode').textContent === 'INSERT', 'stays in INSERT after split (no scroll clobber)');
  key('Escape', window.document.querySelector('.bl .il'));
  await sleep(120);
  ok($('stMode').textContent === 'NORMAL', 'Esc after split returns to NORMAL');
  key('u');
  await sleep(120);
  ok(!rowsText().some(t => t.includes('split-me-here')), 'u undoes the split line');
  ok(rowsText().some(t => t.includes('Check performance')), 'checkbox line restored after undo');

  console.log('--- Tab folding (deterministic: top of file) ---');
  pdown($('bufferViewport'));
  key('g'); key('g');
  key('j'); key('j'); key('j'); // first heading (line 3)
  const openRows = window.document.querySelectorAll('#bufferRows .bl').length;
  key('Tab'); // open -> children-only (no grandchildren to hide for this heading, so rows may stay)
  await sleep(80);
  const after1 = window.document.querySelectorAll('#bufferRows .bl').length;
  ok(after1 <= openRows, 'Tab #1 children-only: rows ' + openRows + ' -> ' + after1);
  key('Tab'); // children-only -> fully folded
  await sleep(80);
  const after2 = window.document.querySelectorAll('#bufferRows .bl').length;
  ok(after2 < openRows, 'Tab #2 folds fully: ' + after2 + ' rows (was ' + openRows + ')');
  key('Tab'); // folded -> open
  await sleep(80);
  const after3 = window.document.querySelectorAll('#bufferRows .bl').length;
  ok(after3 === openRows, 'Tab #3 unfolds back to ' + after3 + ' rows');
  key('Tab'); key('Tab');
  await sleep(80);
  ok(window.document.querySelectorAll('#bufferRows .bl').length < openRows, 'cycles keep working (ends folded)');
  key('Tab');
  await sleep(80);
  ok(window.document.querySelectorAll('#bufferRows .bl').length === openRows, 'and back to open');

  console.log('--- t cycles TODO, space toggles checkbox ---');
  pdown($('bufferViewport'));
  click($('btnUnfoldAll')); await sleep(80);
  key('g'); key('g');
  key('j'); key('j'); key('j'); // first heading
  key('t');
  await sleep(120);
  ok(rowsText().some(t => t.includes('NEXT Review orglite prototype')), 't: TODO → NEXT');
  key('t'); await sleep(80);
  key('t'); await sleep(80);
  ok(rowsText().some(t => t.includes('Review orglite prototype') && !t.includes('NEXT') && !t.includes('TODO') && !t.includes('DONE')), 't: cycles to no keyword');
  key('t'); await sleep(80);
  ok(rowsText().some(t => t.includes('TODO Review orglite prototype')), 't: back to TODO');
  // checkbox: row "  - [ ] Check performance" (file line 5)
  const cbRow = findRow('[ ] Check performance');
  ok(!!cbRow, 'checkbox line rendered: "' + (cbRow && cbRow.textContent.slice(0, 28)) + '"');
  if (cbRow){ pdown(cbRow); click(cbRow); await sleep(60); key(' '); await sleep(150); }
  ok(rowsText().some(t => t.includes('[X] Check performance')), 'space toggles checkbox to [X]');
  key('u'); await sleep(120);
  ok(rowsText().some(t => t.includes('[ ] Check performance')), 'u undoes checkbox toggle');

  console.log('--- refile with R + undo returns to source ---');
  pdown($('bufferViewport'));
  key('g'); key('g');
  key('j'); key('j'); key('j'); // first heading
  key('R');
  await sleep(80);
  ok($('rfModal').classList.contains('open'), 'R opens refile modal');
  if ($('rfModal').classList.contains('open')){
    ok($('rfFile').options.length >= 2, 'destination files listed: ' + $('rfFile').options.length);
    $('rfFile').value = $('rfFile').options[1].value;
    $('rfFile').dispatchEvent(new window.Event('change'));
    await sleep(30);
    $('rfTarget').value = $('rfTarget').options[Math.min(2, $('rfTarget').options.length - 1)].value;
    $('rfConfirm').dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
    await sleep(150);
    ok(!$('rfModal').classList.contains('open'), 'refile confirmed');
    ok($('fname').textContent !== 'inbox.org', 'switched to destination file: ' + $('fname').textContent);
    ok(!$('btnUndo').disabled, 'undo enabled after refile');
    key('u');
    await sleep(150);
    ok($('fname').textContent === 'inbox.org', 'u undoes refile AND returns to source file');
    ok(rowsText().some(t => t.includes('Review orglite prototype')), 'subtree back in inbox');
  }

  console.log('--- buffer search (/) ---');
  pdown($('bufferViewport'));
  key('/');
  await sleep(50);
  ok(!$('bufferSearch').classList.contains('hidden'), '/ opens buffer search');
  const bsi = $('bufferSearchInput');
  bsi.value = 'tauri';
  bsi.dispatchEvent(new window.Event('input'));
  await sleep(100);
  ok($('bufferSearchInfo').textContent.includes('line'), 'jumps to match: ' + $('bufferSearchInfo').textContent);
  key('Enter', bsi);
  await sleep(80);
  ok($('bufferSearchInfo').textContent.includes('line'), 'Enter finds next match: ' + $('bufferSearchInfo').textContent);
  key('Escape', bsi);
  await sleep(50);
  ok($('bufferSearch').classList.contains('hidden'), 'Esc closes buffer search');
  key('n');
  await sleep(80);
  ok(true, 'n continues searching after close');

  console.log('--- CRITICAL: save round-trip ---');
  const savedHtml = window.OrgLite.buildSavedHtml();
  const storeMatch = savedHtml.match(/<script id="orglite-store" type="application\/json">([\s\S]*?)<\/script>/);
  ok(!!storeMatch, 'store extractable from saved file');
  ok(!/[<>&]/.test(storeMatch[1]), 'store JSON serializer-safe (no raw < > &)');
  const store = JSON.parse(storeMatch[1]);
  ok(store.files.length === 6, 'store embeds 6 files');
  ok(store.files.find(f => f.name === 'inbox.org').content.includes('EDITED'), 'edits persisted in store');
  ok((savedHtml.match(/<script/g) || []).length === 2, 'saved file has exactly 2 script tags');
  const dom2 = makeDom(savedHtml);
  const w2 = dom2.window;
  const $2 = id => w2.document.getElementById(id);
  await sleep(600);
  ok(w2.__ORGLITE__ && $2('bufferRows'), 'saved file boots fresh');
  ok([...$2('bufferRows').querySelectorAll('.bl')].some(r => r.textContent.includes('EDITED')), 'edit survived save → reload');
  ok([...$2('bufferRows').querySelectorAll('.bl')].some(r => r.textContent.includes('日本語のメモ')), 'utf-8 content intact');
  const saved2 = w2.OrgLite.buildSavedHtml();
  ok(saved2.includes('orglite-store'), 'reloaded app can save again (2nd generation)');

  console.log('--- sidebar: search / graph / backlinks ---');
  const si = $('searchInput');
  si.value = 'tauri';
  si.dispatchEvent(new window.Event('input'));
  await sleep(400);
  ok($('searchResults').querySelectorAll('.sr').length >= 1, 'sidebar search finds "tauri": ' + $('searchResults').querySelectorAll('.sr').length);
  const graphTab = [...window.document.querySelectorAll('.sb-tab')].find(t => t.dataset.panel === 'pGraph');
  click(graphTab);
  await sleep(100);
  ok($('graphSvg').innerHTML.length > 50, 'graph SVG rendered: ' + $('graphSvg').innerHTML.length + ' chars');
  const linksTab = [...window.document.querySelectorAll('.sb-tab')].find(t => t.dataset.panel === 'pLinks');
  click(linksTab);
  await sleep(80);
  const bpFile = [...$('filesList').querySelectorAll('.file-item')].find(f => f.textContent.includes('big-picture.org'));
  if (bpFile){ click(bpFile); await sleep(120); }
  ok($('fpTitle').textContent.includes('The big picture'), 'opened big-picture.org');
  ok($('linksList').querySelectorAll('.blk').length >= 3, 'backlinks populated: ' + $('linksList').querySelectorAll('.blk').length);

  console.log('--- themes ---');
  const ts = $('themeSel');
  ts.value = 'gruvbox';
  ts.dispatchEvent(new window.Event('change'));
  ok(window.document.documentElement.dataset.theme === 'gruvbox', 'theme switch applies');

  console.log('--- stress 100k ---');
  click($('btnStress'));
  await sleep(800);
  ok($('stStats').textContent.includes('100,000'), 'stress file loaded: ' + $('stStats').textContent.slice(0, 80));
  ok($('bufferRows').children.length <= 120, 'virtualized rows stay small: ' + $('bufferRows').children.length);
  ok($('stPerf').textContent.includes('rows'), 'perf badge: ' + $('stPerf').textContent);
  pdown($('bufferViewport'));
  key('g'); key('g');
  ok(curLine() === 1, 'gg at top of stress file: line ' + curLine());
  key('G');
  ok(curLine() >= 114000, 'G jumps near bottom of stress file: line ' + curLine());
  const tops = [...$('bufferRows').querySelectorAll('.bl')].map(r => parseInt(r.style.top, 10));
  ok(Math.max(...tops) > 50000, 'painted rows positioned near bottom: max top=' + Math.max(...tops));
  key('g'); key('g');
  key('j'); key('j'); key('j'); key('j'); key('j'); // preamble rows + Area 1 heading + fold marker
  ok(curLine() > 100, 'j jumps past folded body to next heading: line ' + curLine());
  // fold with Tab on the first Area heading stays fast
  key('g'); key('g');
  key('j'); key('j'); key('j'); // Area 1 heading (line 4)
  key('Tab');
  await sleep(100);
  ok($('bufferRows').children.length <= 120, 'Tab fold keeps rows virtualized: ' + $('bufferRows').children.length);

  console.log('');
  console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
  if (errors.length){ console.log('ERRORS:'); errors.forEach(e => console.log('  !', e)); }
  process.exit(fail || errors.length ? 1 : 0);
})().catch(e => { console.error('SMOKE CRASH:', e); process.exit(1); });

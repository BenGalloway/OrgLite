// Benchmarks the pure core of orglite.html in Node (no DOM needed).
// The app now lives inside the embedded JSON store (TiddlyWiki-style).
const fs = require('fs');
const html = fs.readFileSync('orglite.html', 'utf8');
const m = html.match(/<script id="orglite-store" type="application\/json">([\s\S]*?)<\/script>/);
if (!m) { console.error('store not found'); process.exit(1); }
const store = JSON.parse(m[1]);

global.window = {};
try { eval(store.app); } catch (e) { console.error('EVAL ERROR:', e.message); process.exit(1); }
const O = global.window.OrgLite;

// ---------- 1. stress parse ----------
const content = O.genStressContent();
console.log('generated lines:', content.split('\n').length, '| chars:', content.length.toLocaleString());

let t0 = Date.now();
const parsed = O.parseOrg(content);
let t1 = Date.now();
console.log('parse:', parsed.n, 'lines,', parsed.headings.length, 'headings,', parsed.links.length, 'links,', parsed.listItems.length, 'checkboxes |', (t1 - t0), 'ms');

// ---------- 2. index ----------
t0 = Date.now();
const idx = O.buildIndex([{name:'stress-100k.org', content, parsed}]);
t1 = Date.now();
console.log('index:', (t1 - t0), 'ms | idIndex entries:', idx.idIndex.size);

// ---------- 3. refile across files ----------
const seed = `
* Project Aurora
  :PROPERTIES:
  :ID: proj-aurora
  :END:
  ** TODO Phase 1
     - [ ] a task
  ** DONE Phase 0
* Project Banshee
  :PROPERTIES:
  :ID: proj-banshee
  :END:
  ** TODO Build the indexer
`;
const dest = `#+TITLE: notes.org
* Note A
* Note B
  Some body text.
* Note C
`;
const p1 = O.parseOrg(seed);
const p2 = O.parseOrg(dest);
const srcH = p1.headings.find(h => h.title === 'Project Banshee');
const destH = p2.headings.find(h => h.title === 'Note B');
const res = O.refileTexts(seed, srcH, dest, destH, 'child');
const p1b = O.parseOrg(res.src);
const p2b = O.parseOrg(res.dest);
console.log('\nrefile: source headings now:', p1b.headings.length, '(was 2) | dest headings now:', p2b.headings.length, '(was 3)');
const moved = p2b.headings.find(h => h.props.ID === 'proj-banshee');
console.log('moved heading found:', !!moved, '| level:', moved && moved.level, '| ID preserved:', moved && moved.props.ID);
console.log('subtree intact (children):', moved && moved.children.length, '(1 expected)');
const a1 = O.buildIndex([{name:'a.org',content:res.src,parsed:p1b},{name:'b.org',content:res.dest,parsed:p2b}]);
console.log('backlink resolution after refile:', O.resolveTarget('id:proj-banshee', a1) ? 'RESOLVES ✓' : 'BROKEN ✗');

// ---------- 4. repeated edits (simulate typing -> reparse) ----------
t0 = Date.now();
let c = content;
for (let i = 0; i < 20; i++){ c = c.replace('TODO Task 5.10', 'DONE Task 5.10'); O.parseOrg(c); }
t1 = Date.now();
console.log('\n20 incremental re-parses of the full 100k file:', (t1 - t0), 'ms (', ((t1 - t0) / 20).toFixed(1), 'ms each )');

// ---------- 5. search across stress file ----------
t0 = Date.now();
let hits = 0;
for (const line of parsed.lines) if (line.includes('Задача')) hits++;
t1 = Date.now();
console.log('search "Задача" (cyrillic, utf-8):', hits, 'hits in', (t1 - t0), 'ms');

// ---------- 6. buildSavedHtml size estimate ----------
console.log('\nstore payload (app+markup+css):', (store.app.length + store.markup.length + store.css.length).toLocaleString(), 'chars');

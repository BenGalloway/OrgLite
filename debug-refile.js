// quick debug of refileTexts
const fs = require('fs');
const html = fs.readFileSync('orglite.html', 'utf8');
const m = html.match(/<script id="app">([\s\S]*?)<\/script>/);
global.window = {};
eval(m[1]);
const O = global.window.OrgLite;

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
console.log('srcH', srcH.startLine, srcH.endLine, 'destH', destH.startLine, destH.endLine);
const res = O.refileTexts(seed, srcH, dest, destH, 'child');
console.log('--- DEST AFTER REFILE ---');
console.log(JSON.stringify(res.dest));
const p2b = O.parseOrg(res.dest);
for (const h of p2b.headings) console.log('HEADING', h.level, JSON.stringify(h.title), 'children:', h.children.map(c=>c.title), 'ID:', h.props.ID || '-');

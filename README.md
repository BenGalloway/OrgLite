# OrgLite — single-file org-flavored notes, minus Emacs

A prototype proving the concept: **org-flavored plain-text notes with org-roam-style
nodes & backlinks, edited in one rendered buffer with Emacs-style modal keys —
zero Emacs, instant even at 100k+ lines.** And, TiddlyWiki-style: **the app and
all your notes live inside one HTML file.**

## What's in here

| File | What it is |
|---|---|
| `orglite.html` | **The whole app — UI, engine, and your data — in one self-contained HTML file.** No dependencies, no network. Open in any browser; 💾 Save (Ctrl+S) persists your notes *into the file itself*. |
| `src/` | The maintainable parts (`app.js`, `app.css`, `app.markup.html`) that `build.py` assembles. |
| `build.py` | Assembles the single file: `python3 build.py` (or `extract` to pull parts out). |
| `tauri/` + `.github/workflows/build-windows.yml` | Optional native Windows shell (Tauri 2) — cloud-built `.exe` via GitHub Actions, no Rust needed locally. |
| `bench.js`, `smoke.js` | Benchmarks + a 71-check DOM smoke test (navigation, editing, folding, refile, save→reload round-trip, 100k stress). |

## Editing: one rendered buffer, modal keys

The main area is **both the editor and the viewer** — no source/view toggle. Lines
render org-modern style (pretty ▸ bullets, TODO pills, ☐/☑ checkboxes, styled
timestamps, tag pills, links) while the raw org text stays underneath; typing
edits the raw text, so files stay clean and portable.

**Normal mode** (status bar shows `NORMAL`):
| Keys | Action |
|---|---|
| `j` / `k` / `h` / `l` (or arrows) | down / up / left / right |
| `i` / `a` / `A` / `I` | insert at cursor / append / end of line / first non-space |
| `o` / `O` | new line below / above (enters insert) |
| `Esc` | back to normal mode |
| `Enter` | move down |
| `Ctrl+>` / `Ctrl+<` | **demote / promote the whole subtree** (org-metaright / org-metaleft; CAPS-as-Ctrl friendly) |
| `0` `^` `$` | line start / first non-space / line end |
| `gg` / `G` | top / bottom of buffer |
| `Ctrl-f` `Ctrl-b` `Ctrl-d` `Ctrl-u` | page down / up / half down / half up |
| `Tab` / `Shift-Tab` | cycle fold (open → children → folded) / fold all |
| `t` | cycle TODO state (TODO → NEXT → DONE → none) |
| `space` | toggle checkbox on the line |
| `x` / `u` | delete char / undo |
| `/` `n` `N` | search buffer / next / prev match |
| `R` | refile subtree (links survive — `:ID:` travels with it) |
| `z` | toggle the preview pane |

**Insert mode** (status bar shows `INSERT`):
| Keys | Action |
|---|---|
| `Enter` | same level, same item — splits at the cursor; on a heading the rest becomes a same-level heading, at the end of a heading it indents a body line under it; on a list item it continues the list |
| `Shift+Enter` | the same item one indent deeper (nested list item, or heading one level deeper) |
| `Ctrl+Enter` | insert a heading one level deeper than the current one |
| `Ctrl+Shift+Enter` | insert a heading at the level of the most previous heading |
| `Tab` | insert indentation |
| `Ctrl+>` / `Ctrl+<` | indent / dedent the current line (CAPS-as-Ctrl friendly) |
| `Backspace` | at line start, join lines |

Typing edits the *raw* org text and the pretty view re-renders **live as you
type** — close a `*bold*` and it turns bold, type a heading and its TODO pill
and tags appear immediately (only the edited line re-styles per keystroke, so
it stays free even in the 100k-line file). **Headings nest to any depth** —
`****** …` works, no three-level limit.

Plain lists render org-modern style too: `-` and `+` become • bullets, `1.`
numbered items get accent-colored numbers — raw text underneath stays untouched.

**Preview pane**: shows the whole subtree under the cursor, narrowed like org —
every subheading with the text under it, refreshing as the cursor moves (click
a subheading to jump, click a checkbox to toggle). **Drag the divider** to
resize it (width persists), or `z` to hide it.

**Insert mode** (status bar shows `INSERT`):
`Enter` splits the line · `Backspace` at line start joins lines · arrows move
across lines · `Esc` commits. The pretty view re-renders **live as you type** —
close a `*bold*` and it turns bold, type a heading and its TODO pill and tags
appear immediately (only the edited line re-styles per keystroke, so it stays
free even in the 100k-line file). On commit the full file re-parses
(~140 ms at 115k lines) and re-renders.

The block caret is a translucent highlight on the character under the cursor —
it moves without leaving traces, and hides while you're in insert mode.

Click a heading to select it (preview pane + backlinks update); click a link to
follow it; double-click a line to start editing right there.

## How the single file works (TiddlyWiki architecture)

```
orglite.html
├── <div id="app-root">            (empty shell)
├── <script id="orglite-store">    JSON store:
│     ├── markup / css / app       the application itself
│     └── files                    your notes: [{name, content}, …]
└── <script id="boot">             tiny boot script (no <, > or & in it)
```

- **💾 Save / Ctrl+S** rebuilds the store JSON with your notes and re-emits the
  file. All `<`, `>`, `&` are escaped (`\u003C` etc.), so the file survives any
  HTML round-trip — no serializer can corrupt the app.
- **Chrome/Edge**: save in place (pick the file once). **Firefox/Safari**: an
  updated copy downloads — replace the old file (classic TiddlyWiki behavior).
- **Crash recovery**: unsaved changes mirror to browser storage and auto-restore
  on reopen. Status bar shows `💾 saved` / `● unsaved changes`.
- **Portability**: `Load .org` / `Save .org` exchange individual notes with
  Emacs or any org tool — no note is ever hostage to the app.

## What it demonstrates

- Org-flavored markup: headlines, TODO keywords, tags, `:PROPERTIES:` drawers
  with `:ID:`, `[[id:…][desc]]` links, checkboxes, timestamps, `SCHEDULED:`,
  `#+BEGIN_SRC` blocks, plain lists, tables, bold/italic/underline/code/verbatim.
- Nodes & backlinks (org-roam model): links by `:ID:` (stable) or title; linked
  references + unlinked title mentions; graph view.
- Refile subtrees across files with level adjustment and `:ID:` preserved —
  backlinks keep resolving after the move; undo returns you to the source file.
- Snappy at scale: virtualized buffer (~60 rows rendered regardless of file
  size), single-pass parser (~170 ms / 115k lines), debounced background re-index.
- Creature comforts: 5 instant CSS-variable themes, UTF-8 everywhere
  (日本語, Задача, 任務, Überblick), dirty indicator, unsaved-changes guard.

## Try it

1. Open `orglite.html` in a browser (open from disk, not the sandboxed preview,
   for full save behavior).
2. Navigate with `j/k/h/l`, edit with `i`, fold with `Tab`, cycle TODOs with `t`.
3. Hit **⚡ Stress 100k**, then `G` to the bottom — still instant.
4. `R` a subtree into another file, watch the Backlinks tab, then **💾 Save** —
   the file now contains everything. Close, reopen the saved copy: it's all there.

## Bench numbers (Node 20, this machine)

```
parse 115,003 lines / 100,000 headings   ~170 ms
index (links, ids, backlinks)            ~10 ms
re-parse after edit (full file)          ~140 ms
search across 2.6 MB (UTF-8)             ~10-30 ms
refile subtree across files              structure + IDs + backlinks verified
edit → save → reload round-trip          71/71 smoke checks pass
```

## Size tradeoffs (honest)

Single-file means every save rewrites the whole file — keep notes under a few MB
(the 100k-line stress file makes a ~3.5 MB HTML; opens instantly, saves take a
beat). Don't keep two copies open in different windows at once. For a
multi-megabyte vault, the Tauri shell can host this same file and save in place
on disk — the parser/engine port 1:1.

## Getting the .exe (optional)

- **Easiest:** push this repo to GitHub → **Actions** → **Build Windows .exe** →
  **Run workflow** → download the artifact.
- **Locally (once Rust is installed):** `cd tauri && cargo tauri build`.

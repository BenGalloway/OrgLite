// OrgLite — org-flavored notes without Emacs.
// This shell simply hosts the single-file UI (orglite.html).
// The next step (with Rust available) is to replace the demo's in-memory
// storage with real disk I/O, a rope buffer (ropey), tree-sitter parsing
// and a SQLite index — the HTML stays exactly the same.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running OrgLite");
}

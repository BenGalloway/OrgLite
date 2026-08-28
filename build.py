#!/usr/bin/env python3
"""OrgLite build script.

Modes:
  python3 build.py extract   -- pull src/app.css, src/app.markup.html, src/app.js out of orglite.html
  python3 build.py           -- assemble orglite.html from src/ parts + boot script

The output is a TiddlyWiki-style single file: the app (markup, CSS, JS) and all
user data live inside a JSON "store" embedded in the page; a tiny boot script
reads the store and renders the app. Every '<', '>' and '&' in the store JSON is
escaped as \\u003C/\\u003E/\\u0026 so the file round-trips through any HTML
serializer (outerHTML) without corruption — and the boot script is written to
contain none of those characters at all.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'src')
OUT = os.path.join(ROOT, 'orglite.html')

# Boot script: must NOT contain '<', '>' or '&' (it survives serialization
# verbatim). It reads the store, captures the static skeleton for later saves,
# then injects markup/css/app at runtime.
BOOT = ("(function(){var s=document.getElementById('orglite-store');if(!s)return;"
        "var D;try{D=JSON.parse(s.textContent);}catch(e){return;}"
        "window.__ORGLITE__=D;"
        "var lt=String.fromCharCode(60),gt=String.fromCharCode(62);"
        "var h='<!DOCTYPE html>'+String.fromCharCode(10)+document.documentElement.outerHTML;"
        "window.__ORGLITE_HEAD__=h.split(lt+'!--ORGLITE-STORE--'+gt)[0];"
        "var b=document.getElementById('boot');"
        "window.__ORGLITE_TAIL__=(b?b.outerHTML:'')+lt+'/body'+gt+lt+'/html'+gt;"
        "var root=document.getElementById('app-root');"
        "root.innerHTML=D.markup;"
        "var st=document.createElement('style');st.textContent=D.css;document.head.appendChild(st);"
        "var sc=document.createElement('script');sc.textContent=D.app;document.body.appendChild(sc);})();")

SKELETON = """<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OrgLite — single-file org-flavored notes</title>
</head>
<body>
<div id="app-root"></div>
<!--ORGLITE-STORE-->
<script id="orglite-store" type="application/json">__STORE__</script>
<script id="boot">
__BOOT__
</script>
</body>
</html>
"""


def extract():
    html = open(OUT, encoding='utf-8').read()
    css = html.split('<style>', 1)[1].split('</style>', 1)[0]
    markup = html.split('<body>', 1)[1].split('<script id="app">', 1)[0]
    app = html.split('<script id="app">', 1)[1].split('</script>', 1)[0]
    os.makedirs(SRC, exist_ok=True)
    for name, content in (('app.css', css), ('app.markup.html', markup), ('app.js', app)):
        open(os.path.join(SRC, name), 'w', encoding='utf-8').write(content)
        print('wrote src/%s (%d chars)' % (name, len(content)))


def esc(s):
    return s.replace('<', '\\u003C').replace('>', '\\u003E').replace('&', '\\u0026')


def build():
    css = open(os.path.join(SRC, 'app.css'), encoding='utf-8').read()
    markup = open(os.path.join(SRC, 'app.markup.html'), encoding='utf-8').read()
    app = open(os.path.join(SRC, 'app.js'), encoding='utf-8').read()
    store = {'v': 2, 'savedAt': 0, 'title': 'OrgLite',
             'markup': markup, 'css': css, 'app': app, 'files': []}
    js = esc(json.dumps(store, ensure_ascii=False))
    assert '<' not in js and '>' not in js and '&' not in js, 'store JSON must be serializer-safe'
    out = SKELETON.replace('__STORE__', js).replace('__BOOT__', BOOT)
    open(OUT, 'w', encoding='utf-8').write(out)
    print('wrote orglite.html (%.1f KB)' % (len(out) / 1024))
    validate(out)


def validate(out):
    m = re.search(r'<script id="orglite-store" type="application/json">([\s\S]*?)</script>', out)
    assert m, 'store script not found'
    store = json.loads(m.group(1))
    assert store['v'] == 2 and store['files'] == []
    assert out.count('<script') == 2, 'expected exactly store + boot scripts, got %d' % out.count('<script')
    assert '<script id="app">' not in out, 'app must not live in the body'
    assert BOOT in out, 'boot script missing'
    print('validation OK: store parses, app=%d chars, markup=%d chars, css=%d chars' % (
        len(store['app']), len(store['markup']), len(store['css'])))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'extract':
        extract()
    else:
        build()

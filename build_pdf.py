#!/usr/bin/env python3
"""Build a 250-page, one-page-per-spine-entry PDF using WeasyPrint
(browser-free, real text + embedded images — no rasterized screenshots).

For each spine document:
  1. Inject a tall @page size and render to a PNG at 96 DPI.
  2. Measure the last non-blank pixel row -> content height in inches.
  3. Re-render the PDF with @page size = 8.5in x contentHeight.
  4. Inject metadata + TOC outline via pikepdf.
"""
import json, re, subprocess, os, sys
from PIL import Image
from weasyprint import HTML
import pikepdf
from collections import defaultdict

DUMP = '/root/vsb/dump'
HTML_DIR = '/root/vsb/wp_html'
PDF_DIR = '/root/vsb/wp_pdf'
RAW_PDF = '/root/vsb/living_with_art_raw.pdf'
FINAL_PDF = '/root/vsb/living_with_art.pdf'
DPI = 96.0
PAGE_W_IN = 8.5

pb = json.load(open(f'{DUMP}/r_065.bin'))          # pagebreaks
sp = json.load(open(f'{DUMP}/r_066.json'))          # spine / pages.json
toc = json.load(open(f'{DUMP}/r_091.bin'))          # toc
info = json.load(open(f'{DUMP}/r_064.json'))        # book info
book = info['books'][0]

if not os.path.exists(PDF_DIR):
    os.makedirs(PDF_DIR)

def sa(cfi):
    return re.sub(r'\[data-uuid-[a-f0-9]+\]', '', cfi)

# ---- build stripped-cfi -> spine-index map ----
# The rebuilt PDF has exactly one page per spine entry (250 pages),
# so spine index i == PDF page index i (0-based).
sp_cfi = {sa(e['cfiWithoutAssertions']): i for i, e in enumerate(sp)}

# Group pagebreaks by spine entry (preserving order) so each pagebreak's
# cfiWithoutAssertions can be matched to its spine index.
sp_url = defaultdict(list)
for i, e in enumerate(sp):
    sp_url[e['path']].append(i)

cur, groups = None, []
for e in pb:
    idxs = sp_url.get(e['url'], [])
    cand = [i for i in idxs if sa(e['cfiWithoutAssertions']).startswith(sa(sp[i]['cfiWithoutAssertions']))] or idxs
    i = cand[0]
    if i != cur:
        groups.append([i, []])
        cur = i
    groups[-1][1].append(e)

pb_list = []
for spine_i, brs in groups:
    for b in brs:
        pb_list.append((sa(b['cfiWithoutAssertions']), spine_i))

def toc_pdf_page(toc_entry):
    k = sa(toc_entry['cfi'])
    for c, pn in pb_list:
        if k == c:
            return pn
    best, best_len = None, -1
    for c, pn in pb_list:
        if k.startswith(c) and len(c) > best_len:
            nxt = k[len(c):len(c) + 1]
            if nxt in ('/', '!'):
                best, best_len = pn, len(c)
    return best

# ---- measure + render each spine document ----
def measure_and_render(idx):
    src = f'{HTML_DIR}/page_{idx:04d}.html'
    pdf = f'{PDF_DIR}/page_{idx:04d}.pdf'
    html_src = open(src).read()
    # 1. render with a tall page to measure content bottom
    tall = re.sub(r'@page\s*\{[^}]*\}',
                  '@page { size: 8.5in 1000in; margin: 0; }', html_src, count=1)
    doc = HTML(string=tall).render()
    p = doc.pages[0]
    pb = p._page_box
    state = {'maxbottom': 0.0}
    def walk(box, is_root=True):
        if not is_root:
            try:
                by = box.border_box_y()
                bh = box.border_height()
                if isinstance(by, (int, float)) and isinstance(bh, (int, float)):
                    b = by + bh
                    if b > state['maxbottom']:
                        state['maxbottom'] = b
            except Exception:
                pass
        for ch in getattr(box, 'children', []) or []:
            walk(ch, False)
    walk(pb)
    content_h_in = max(11.0, state['maxbottom'] / DPI)
    # 2. inject exact height into @page and render PDF (real text + images)
    html_src = re.sub(r'@page\s*\{[^}]*\}',
                      f'@page {{ size: {PAGE_W_IN}in {content_h_in:.2f}in; margin: 0; }}',
                      html_src, count=1)
    HTML(string=html_src).write_pdf(pdf)
    return content_h_in

print('Rendering', len(sp), 'spine documents with WeasyPrint...')
for i in range(len(sp)):
    h = measure_and_render(i)
    if i % 5 == 0 or i == len(sp) - 1:
        print(f'  [{i+1}/{len(sp)}] spine {i}: {h:.2f}in', flush=True)
print('All pages rendered.')

# ---- merge per-page PDFs ----
print('Merging...')
pdf_files = [f'{PDF_DIR}/page_{i:04d}.pdf' for i in range(len(sp))]
cmd = ['pdfunite'] + pdf_files + [RAW_PDF]
subprocess.run(cmd, check=True, timeout=600)
print('Merged ->', RAW_PDF)

# ---- inject metadata + outline ----
pdf = pikepdf.open(RAW_PDF, allow_overwriting_input=True)
total = len(pdf.pages)
print('Total pages:', total)

meta = pdf.docinfo
meta['/Title'] = book.get('title', 'Living with Art')
meta['/Author'] = book.get('author', 'Mark Getlein')
meta['/Subject'] = 'Art appreciation - Textbook'
meta['/Keywords'] = 'Living with Art, Mark Getlein, art appreciation, McGraw Hill, textbook, ' + book.get('isbn', '')
meta['/Creator'] = 'VitalSource / WeasyPrint PDF builder'
meta['/Producer'] = 'WeasyPrint 69.0 + pikepdf'
meta['/CreationDate'] = "D:20261022220000Z"
meta['/ModDate'] = "D:20261022220000Z"

class Node:
    __slots__ = ('title', 'page', 'children')
    def __init__(self, title, page):
        self.title = title
        self.page = page
        self.children = []

roots = []
stack = []
for t in toc:
    lvl = t['level']
    page = toc_pdf_page(t)
    if page is None:
        continue
    node = Node(t.get('title') or '', page)
    while stack and stack[-1][0] >= lvl:
        stack.pop()
    if not stack:
        roots.append(node)
    else:
        stack[-1][1].children.append(node)
    stack.append((lvl, node))

def make_item(node):
    if 0 <= node.page < total:
        item = pikepdf.OutlineItem(node.title, destination=node.page, page_location='FitH', top=100)
    else:
        item = pikepdf.OutlineItem(node.title, destination=0, page_location='FitH')
    for ch in node.children:
        item.children.append(make_item(ch))
    return item

with pdf.open_outline() as outline:
    outline.root = [make_item(r) for r in roots]

pdf.save(FINAL_PDF)
pdf.close()

def count(n):
    return 1 + sum(count(c) for c in n.children)
print('Saved', FINAL_PDF)
print('Outline entries:', sum(count(r) for r in roots))
print('Roots:', [(r.title, r.page + 1) for r in roots[:6]])
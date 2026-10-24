#!/usr/bin/env python3
"""Inject PDF metadata (title, author, subject, keywords) and outline/bookmarks
into living_with_art.pdf using pikepdf, mapping TOC entries to PDF pages via the
pagebreaks API (cfi -> PDF page)."""
import json, re, subprocess
import pikepdf
from collections import defaultdict

PDF_IN = '/root/vsb/living_with_art_raw.pdf'
PDF_OUT = '/root/vsb/living_with_art.pdf'
DUMP = '/root/vsb/dump'

pb = json.load(open(f'{DUMP}/r_065.bin'))          # pagebreaks
sp = json.load(open(f'{DUMP}/r_066.json'))          # spine / pages.json
toc = json.load(open(f'{DUMP}/r_091.bin'))          # toc
info = json.load(open(f'{DUMP}/r_064.json'))        # book info
book = info['books'][0]

def sa(cfi):
    return re.sub(r'\[data-uuid-[a-f0-9]+\]', '', cfi)

# ---- build stripped-cfi -> pdf-page map ----
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

# Each pagebreak inside a spine entry maps to that entry's single PDF page.
pb_list = []
for spine_i, brs in groups:
    for b in brs:
        pb_list.append((sa(b['cfiWithoutAssertions']), spine_i))

def toc_pdf_page(toc_entry):
    k = sa(toc_entry['cfi'])
    # exact match
    for c, pn in pb_list:
        if k == c:
            return pn
    # longest CFI-step-boundary prefix match
    best, best_len = None, -1
    for c, pn in pb_list:
        if k.startswith(c) and len(c) > best_len:
            nxt = k[len(c):len(c) + 1]
            if nxt in ('/', '!'):
                best, best_len = pn, len(c)
    return best

# ---- build outline tree from TOC (levels 1/2/3) ----
class Node:
    __slots__ = ('title', 'page', 'children')
    def __init__(self, title, page):
        self.title = title
        self.page = page
        self.children = []

roots = []
stack = []  # (level, node)
for t in toc:
    lvl = t['level']
    page = toc_pdf_page(t)
    if page is None:
        continue
    title = t.get('title') or ''
    node = Node(title, page)
    while stack and stack[-1][0] >= lvl:
        stack.pop()
    if not stack:
        roots.append(node)
    else:
        stack[-1][1].children.append(node)
    stack.append((lvl, node))

# ---- write PDF with pikepdf ----
pdf = pikepdf.open(PDF_IN, allow_overwriting_input=True)
total = len(pdf.pages)

# Metadata
meta = pdf.docinfo
meta['/Title'] = book.get('title', 'Living with Art')
meta['/Author'] = book.get('author', 'Mark Getlein')
meta['/Subject'] = 'Art appreciation - Textbook'
meta['/Keywords'] = 'Living with Art, Mark Getlein, art appreciation, McGraw Hill, textbook, ' + book.get('isbn', '')
meta['/Creator'] = 'VitalSource / Kilo PDF builder'
meta['/Producer'] = 'pikepdf + Playwright/Chromium'
meta['/CreationDate'] = "D:20261022213000Z"
meta['/ModDate'] = "D:20261022213000Z"

# Outline (bookmarks)
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

pdf.save(PDF_OUT)
pdf.close()

def count(n):
    return 1 + sum(count(c) for c in n.children)
print('Saved', PDF_OUT)
print('Total pages:', total)
print('Outline entries:', sum(count(r) for r in roots))
print('Roots:', [(r.title, r.page + 1) for r in roots[:6]])
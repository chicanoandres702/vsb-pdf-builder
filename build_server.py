#!/usr/bin/env python3
"""Build PDF for selected spine indices, streaming JSON progress to stdout."""
import json, re, subprocess, os, sys, io
from weasyprint import HTML
import pikepdf
from PIL import Image
from collections import defaultdict

args = json.loads(sys.argv[1])
spine_indices = args['spine_indices']
out_dir = args['outDir']
final_out = args['finalOut']

DUMP = '/root/vsb/dump'
HTML_DIR = '/root/vsb/wp_html'
PAGINATED_DIR = '/root/vsb/paginated'
PDF_DIR = '/root/vsb/wp_pdf'
OUT_DIR = args['outDir']
DPI = 96.0
PAGE_W_IN = 8.5
PAGE_H_IN = 11.0

# Use dynamic book title for output filename
sp = json.load(open(f'{DUMP}/r_066.json'))
pb = json.load(open(f'{DUMP}/r_065.bin'))
toc = json.load(open(f'{DUMP}/r_091.bin'))
info = json.load(open(f'{DUMP}/r_064.json'))
book = info['books'][0]
book_title = book.get('title', 'Book')
safe_title = re.sub(r'[^a-zA-Z0-9]+', '_', book_title).strip('_')

def sa(cfi):
    return re.sub(r'\[data-uuid-[a-f0-9]+\]', '', cfi)

# Build stripped-cfi -> spine-index map
sp_url = defaultdict(list)
for i, e in enumerate(sp):
    sp_url[e['path']].append(i)
cur, groups = None, []
for e in pb:
    idxs = sp_url.get(e['url'], [])
    ecfi = sa(e['cfiWithoutAssertions'])
    cand = [i for i in idxs if ecfi == sa(sp[i]['cfiWithoutAssertions']) or ecfi.startswith(sa(sp[i]['cfiWithoutAssertions']) + '/') or ecfi.startswith(sa(sp[i]['cfiWithoutAssertions']) + '!')] or idxs
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
        if (k.startswith(c + '/') or k.startswith(c + '!')) and len(c) > best_len:
            best, best_len = pn, len(c)
    return best

def measure_and_render(idx):
    """Legacy: kept for reference, no longer used."""
    pass

def out(msg_type, **kw):
    print(json.dumps({'type': msg_type, **kw}), flush=True)

if not os.path.exists(out_dir):
    os.makedirs(out_dir)

total = len(spine_indices)
out(f'progress', progress=0, message=f'Rendering {total} spine documents to PDF...')

# Step 1: Render each spine HTML to PDF using Playwright with pagebreak-based pagination
import subprocess as sp_mod
render_proc = sp_mod.Popen(
    ['node', f'{DUMP}/../render_pb.js', json.dumps(spine_indices)],
    stdout=sp_mod.PIPE, stderr=sp_mod.PIPE, text=True, bufsize=1
)
rendered_set = set()
rendered_count = 0
for line in render_proc.stdout:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
        if msg.get('type') == 'rendered':
            idx = msg['idx']
            if idx not in rendered_set:
                rendered_set.add(idx)
                rendered_count += 1
                pct = int(rendered_count / total * 80)
                out(f'progress', progress=pct,
                    message=f'Rendered spine {idx} ({msg["breaks"]} breaks, {msg["imgs"]} imgs) [{rendered_count}/{total}]')
        elif msg.get('type') == 'done':
            break
    except Exception:
        pass
render_proc.wait(timeout=3600)
if render_proc.returncode != 0:
    err = render_proc.stderr.read()
    out(f'error', message=f'Render failed: {err[:500]}')
    sys.exit(1)

# Merge selected PDFs
out(f'progress', progress=80, message='Merging PDFs...')
raw = f'{out_dir}/raw.pdf'
pdf_files = [f'{PDF_DIR}/page_{i:04d}.pdf' for i in spine_indices]
subprocess.run(['pdfunite'] + pdf_files + [raw], check=True, timeout=900)
out(f'progress', progress=90, message='Merged, injecting metadata...')

# Inject metadata + outline
pdf = pikepdf.open(raw, allow_overwriting_input=True)
total_pages = len(pdf.pages)

meta = pdf.docinfo
meta['/Title'] = book.get('title', 'Living with Art')
meta['/Author'] = book.get('author', 'Mark Getlein')
meta['/Subject'] = 'Art appreciation - Textbook'
meta['/Keywords'] = 'Living with Art, Mark Getlein, art appreciation, McGraw Hill, textbook, ' + book.get('isbn', '')
meta['/Creator'] = 'VitalSource / WeasyPrint PDF builder'
meta['/Producer'] = 'WeasyPrint 69.0 + pikepdf'

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
    # Only include TOC entries whose mapped spine index is in the selected set
    if page not in spine_indices:
        continue
    node = Node(t.get('title') or '', page)
    while stack and stack[-1][0] >= lvl:
        stack.pop()
    if not stack:
        roots.append(node)
    else:
        stack[-1][1].children.append(node)
    stack.append((lvl, node))

# Remap page numbers to the merged PDF (dense renumbering)
def _walk(n):
    for c in n.children:
        yield c
        yield from _walk(c)

page_map = {old: new for new, old in enumerate(sorted(spine_indices))}
for n in roots:
    n.page = page_map[n.page]
    for c in _walk(n):
        c.page = page_map[c.page]

def make_item(node):
    if 0 <= node.page < total_pages:
        item = pikepdf.OutlineItem(node.title, destination=node.page, page_location='FitH', top=100)
    else:
        item = pikepdf.OutlineItem(node.title, destination=0, page_location='FitH')
    for ch in node.children:
        item.children.append(make_item(ch))
    return item

with pdf.open_outline() as outline:
    outline.root = [make_item(r) for r in roots]

pdf.save(final_out)
pdf.close()

# Step 4: Compress images using pikepdf + Pillow
out(f'progress', progress=92, message='Compressing images...')
from PIL import Image
import zlib

pdf2 = pikepdf.open(final_out, allow_overwriting_input=True)
img_count = 0
total_saved = 0
for i, page in enumerate(pdf2.pages):
    resources = page.get('/Resources', {})
    xobj = resources.get('/XObject', {})
    if xobj is None:
        continue
    try:
        keys = list(xobj.keys())
    except Exception:
        continue
    for name in keys:
        obj = xobj[name]
        if not (hasattr(obj, 'get') and str(obj.get('/Subtype', '')) == '/Image'):
            continue
        try:
            w = int(obj.get('/Width', 0))
            h = int(obj.get('/Height', 0))
            if w == 0 or h == 0:
                continue
            raw_comp = obj.read_raw_bytes()
            raw = raw_comp
            filt = obj.get('/Filter', '')
            filt_str = str(filt)
            if 'FlateDecode' in filt_str:
                raw = zlib.decompress(raw_comp)
            
            cs = obj.get('/ColorSpace', '/DeviceRGB')
            cs_str = str(cs)
            
            if cs_str == '/DeviceRGB':
                mode = 'RGB'
                expected = w * h * 3
            elif cs_str == '/DeviceCMYK':
                mode = 'CMYK'
                expected = w * h * 4
            elif 'ICCBased' in cs_str:
                mode = 'RGB'
                expected = w * h * 3
            else:
                continue
            
            if len(raw) < expected:
                continue
            
            pixels = raw[:expected]
            img = Image.frombytes(mode, (w, h), pixels)
            
            buf = io.BytesIO()
            quality = 75 if w > 200 else 85
            img.save(buf, format='JPEG', quality=quality, optimize=True)
            jpeg_data = buf.getvalue()
            
            if len(jpeg_data) < len(raw_comp):
                new_stream = pdf2.make_stream(jpeg_data)
                new_stream['/Subtype'] = '/Image'
                new_stream['/Width'] = w
                new_stream['/Height'] = h
                new_stream['/ColorSpace'] = '/DeviceRGB'
                new_stream['/BitsPerComponent'] = 8
                new_stream['/Filter'] = '/DCTDecode'
                xobj[name] = new_stream
                img_count += 1
                total_saved += len(raw_comp) - len(jpeg_data)
        except Exception:
            pass

pdf2.save(final_out)
pdf2.close()
out(f'progress', progress=95, message=f'Compressed {img_count} images, saved {total_saved/1e6:.0f}MB')

def count(n):
    return 1 + sum(count(c) for c in n.children)
out(f'done', progress=100, message=f'Complete: {total_pages} pages, {sum(count(r) for r in roots)} outline entries, {img_count} images compressed', pdf=final_out, pdfName=safe_title)

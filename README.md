# VSB - VitalSource Book PDF Builder

A complete pipeline that extracts DRM-protected VitalSource e-books into clean, browser-free PDFs with real text and embedded images (no screenshots, no print-to-PDF).

## Overview

VSB captures a VitalSource reader session, deobfuscates the JavaScript, decrypts AES-256-GCM encrypted EPUB content, and renders each spine entry as a single PDF page using WeasyPrint (real text + real images, no rasterization).

```
VitalSource URL → Playwright capture → Deobfuscate JS → Decrypt EPUB → Render PDF
```

## Architecture

| Component | File | Description |
|-----------|------|-------------|
| HTTP Server | `server.js` | Express-free Node.js server with web UI and job API |
| Build Pipeline | `build_server.py` | Orchestrates Playwright render + WeasyPrint + pikepdf, streams JSON progress |
| Page Renderer | `render_pb.js` | Renders spine HTML to PDF via Playwright with CFI-based page breaks |
| HTML Generator | `make_wp_html.js` | Converts decrypted EPUB XHTML to standalone HTML files |
| Content Capture | `capture.js` | Playwright script to capture JS, cookies, and resources from VitalSource |
| Cookie Capture | `capture_cookies.js` | Captures fresh Netscape-format cookies via Playwright |
| Content Decryption | `decrypt.js`, `decrypt_all.js` | AES-256-GCM decryption of EPUB content (32-byte hardcoded key) |
| JS Deobfuscator | `deob.js`, `format.js` | Babel parse + Prettier pretty-printer with semantic hint extraction |

## Prerequisites

### Node.js
```bash
node >= 22
```

### Python
```bash
pip install -r requirements.txt
```

### Playwright browsers
```bash
npx playwright install chromium
```

### System packages (for Playwright on Linux)
```bash
apt-get install -y libatk1.0-0 libatk-bridge2.0-0 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
  libnss3 libnspr4 libdrm2 libxshmfence1 libpangocairo-1.0-0
```

### WeasyPrint system deps
```bash
apt-get install -y build-essential python3-dev python3-pip libpango-1.0-0 \
  libpangocairo-1.0-0 libcairo2 libgdk-pixbuf-2.0-0 libffi-dev
```

## Usage

### 1. Start the server
```bash
node server.js
```

The web UI is available at `http://localhost:3000`.

### 2. Extract a book (optional)
To extract a new book from a VitalSource URL:
```bash
node capture.js '<vitalsource_book_url>'
```

### 3. Build the PDF
Via the web UI:
1. Open `http://localhost:3000`
2. Select chapters or click "Select All"
3. Click "Build PDF"
4. Monitor progress in the UI

Via the API:
```bash
curl -X POST http://localhost:3000/api/build -d '{"chapters": null}'
# {"jobId": "job_..."}
curl http://localhost:3000/api/job/<jobId>
# {"status":"complete","progress":100,...}
curl -O http://localhost:3000/pdf
```

## Workflow Details

### PDF Rendering
Each spine entry is rendered to exactly one PDF page (250 pages total for "Living with Art"). Content height is measured via render-tree traversal and injected as an exact `@page` size, preserving the original layout.

### Table of Contents
The TOC outline is built from the VitalSource TOC API (`/books/:isbn/toc`), mapped to PDF pages via CFI-to-pagebreak resolution. Chapter titles are matched to spines using assertion-stripped CFIs with step-boundary detection (`/6/2` vs `/6/20`).

### Image Handling
Images are embedded as native PDF image XObjects (DCTDecode JPEGs / FlateDecode PNGs) — never rasterized screenshots. Post-build compression with Pillow+Pillow optimizes file size.

### DRM
Content is decrypted client-side using AES-256-GCM with the VitalSource reader's runtime key. The JWT bearer token (`setupSecureToken()`) authenticates API requests.

## Project Structure

```
vsb/
├── server.js          # Main HTTP server + web UI API
├── build_server.py    # PDF build orchestrator (Python)
├── render_pb.js       # Playwright page renderer
├── make_wp_html.js    # EPUB XHTML → HTML converter
├── capture.js         # Playwright content capture
├── capture_cookies.js # Cookie capture
├── decrypt.js         # AES-256-GCM decryption
├── deob.js            # JS deobfuscator
├── format.js          # JS formatter
├── package.json
├── requirements.txt
├── .nvmrc
├── public/
│   └── index.html     # Web UI
├── dump/              # Captured resources (gitignored)
├── epub/              # Decrypted EPUB content (gitignored)
├── wp_html/            # Generated HTML per spine (gitignored)
└── wp_pdf/             # Generated per-spine PDFs (gitignored)
```

## License

ISC
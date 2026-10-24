#!/usr/bin/env node
/** Render spine HTML to PDF using pagebreaks for proper pagination.
    For each spine entry, inject page-break-before divs at CFI positions
    from r_065.bin, then render with Playwright PDF (auto-paginated at 8.5x11in).
    Usage: node render_pb.js '[0,1,2,...]' */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const VSB = process.env.VSB_DIR || '/root/vsb';
const HTML_DIR = `${VSB}/wp_html`;
const PDF_DIR = `${VSB}/wp_pdf`;
const DUMP = `${VSB}/dump`;
const PAGE_W_PX = Math.round(8.5 * 96); // 816px = 8.5in at 96dpi
const PAGE_H_PX = Math.round(11 * 96); // 1056px = 11in at 96dpi

if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

// Load pagebreaks and build spine -> [cfis] map
const pb = JSON.parse(fs.readFileSync(`${DUMP}/r_065.bin`, 'utf8'));
const sp = JSON.parse(fs.readFileSync(`${DUMP}/r_066.json`, 'utf8'));
const pbBySpine = {};
pb.forEach((b, pi) => {
  // Find which spine this pagebreak belongs to
  const url = b.url;
  let spineIdx = -1;
  for (let i = 0; i < sp.length; i++) {
    if (sp[i].path === url) { spineIdx = i; break; }
  }
  if (spineIdx >= 0) {
    if (!pbBySpine[spineIdx]) pbBySpine[spineIdx] = [];
    pbBySpine[spineIdx].push({ cfi: b.cfi, pbIndex: pi });
  }
});

// Sort CFIs within each spine by their original order in pb
for (const key in pbBySpine) {
  pbBySpine[key].sort((a, b) => a.pbIndex - b.pbIndex);
}

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let fp = path.join(VSB, decodeURIComponent(req.url));
      if (!fs.existsSync(fp)) { res.writeHead(404); res.end('NF'); return; }
      const ext = path.extname(fp).toLowerCase();
      const types = { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.css': 'text/css' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      fs.createReadStream(fp).pipe(res);
    });
    server.listen(0, () => resolve(server));
  });
}

async function renderBatch(indices, port) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: PAGE_W_PX, height: PAGE_H_PX } });

  for (const idx of indices) {
    const htmlPath = path.join(HTML_DIR, `page_${String(idx).padStart(4, '0')}.html`);
    const pdfPath = path.join(PDF_DIR, `page_${String(idx).padStart(4, '0')}.pdf`);

    if (!fs.existsSync(htmlPath)) {
      console.log(JSON.stringify({ type: 'skip', idx, reason: 'no html' }));
      continue;
    }

    let htmlContent = fs.readFileSync(htmlPath, 'utf8');
    htmlContent = htmlContent.replace(/file:\/\/\/root\/vsb\//g, `http://127.0.0.1:${port}/`);
    // Remove @page rules
    htmlContent = htmlContent.replace(/@page\s*\{[^}]*\}/g, '');
    // Fix .page to fill viewport exactly (no padding, full width)
    htmlContent = htmlContent.replace(
      /\.page\s*\{[^}]*\}/,
      '.page { width: 100vw; height: auto; margin: 0; padding: 0; overflow: visible; box-sizing: border-box; }'
    );
    // Fix body
    htmlContent = htmlContent.replace(
      /body\s*\{[^}]*\}/,
      'body { margin: 0; padding: 0; overflow: visible; }'
    );
    // Fix img to not overflow
    htmlContent = htmlContent.replace(
      /img\s*\{[^}]*\}/,
      'img { max-width: 100% !important; height: auto !important; display: block; }'
    );

    const renderPage = await context.newPage();
    await renderPage.setContent(htmlContent, { waitUntil: 'load', timeout: 30000 });

    // Wait for images
    await renderPage.evaluate(async () => {
      const imgs = Array.from(document.images);
      await Promise.all(imgs.map(img => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise((resolve) => {
          img.onload = () => resolve();
          img.onerror = () => resolve();
          setTimeout(resolve, 5000);
        });
      }));
    });

    // Inject page breaks at CFI positions (skip first = entry start)
    const cfis = (pbBySpine[idx] || []).map(x => x.cfi);
    const breakCfis = cfis.length > 1 ? cfis.slice(1) : [];

    const breakResult = await renderPage.evaluate((breakCfis) => {
      const breaks = [];
      for (const cfi of breakCfis) {
        try {
          const uuidMatches = [...cfi.matchAll(/data-uuid-([a-f0-9]+)/g)];
          if (uuidMatches.length > 0) {
            const uuid = uuidMatches[uuidMatches.length - 1][1];
            const el = document.getElementById('data-uuid-' + uuid);
            if (el) {
              const breakDiv = document.createElement('div');
              breakDiv.style.pageBreakBefore = 'always';
              breakDiv.style.breakBefore = 'page';
              el.parentNode.insertBefore(breakDiv, el);
              breaks.push(uuid);
            }
          }
        } catch (e) {}
      }
      return breaks;
    }, breakCfis);

    // Count images for reporting
    const imgInfo = await renderPage.evaluate(() => {
      const imgs = Array.from(document.images);
      return { total: imgs.length, loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length };
    });

    // Get page count from PDF
    const pdfBefore = pdfPath;
    await renderPage.pdf({
      path: pdfPath,
      width: '8.5in',
      height: '11in',
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
      timeout: 60000
    });

    // Count pages in generated PDF
    const pdfBuf = fs.readFileSync(pdfPath);
    const pageMatches = pdfBuf.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
    const pageCount = pageMatches ? pageMatches.length : 1;

    await renderPage.close();

    console.log(JSON.stringify({ type: 'rendered', idx, breaks: breakResult.length, imgs: `${imgInfo.loaded}/${imgInfo.total}`, pages: pageCount }));
  }

  await context.close();
  await browser.close();
}

async function main() {
  const spineIndices = JSON.parse(process.argv[2]);
  const server = await startServer();
  const port = server.address().port;

  const NUM_WORKERS = 4;
  const chunks = [];
  for (let i = 0; i < NUM_WORKERS; i++) {
    chunks.push(spineIndices.filter((_, j) => j % NUM_WORKERS === i));
  }

  await Promise.all(chunks.map((chunk, i) => {
    if (chunk.length === 0) return Promise.resolve();
    return renderBatch(chunk, port);
  }));

  server.close();
  console.log(JSON.stringify({ type: 'done' }));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
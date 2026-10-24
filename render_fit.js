#!/usr/bin/env node
/** Render spine HTML files to PDF: one page per spine entry, content scaled to fit 8.5x11in.
    Images served via local HTTP server (file:// doesn't work in headless Chrome).
    Parallelized with multiple browser contexts for speed.
    Usage: node render_fit.js '[0,1,2,...]' */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const HTML_DIR = '/root/vsb/wp_html';
const PDF_DIR = '/root/vsb/wp_pdf';
const ROOT = '/root/vsb';
const PAGE_W_PX = 1440;
const PAGE_H_PX = Math.round(11 * (1440 / 8.5)); // ~1857px

if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

// Start a simple HTTP server to serve files from /root/vsb
function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let fp = path.join(ROOT, decodeURIComponent(req.url));
      // Handle file:// URLs that might have been rewritten
      if (!fs.existsSync(fp)) {
        res.writeHead(404); res.end('NF'); return;
      }
      const ext = path.extname(fp).toLowerCase();
      const types = { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.css': 'text/css' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      fs.createReadStream(fp).pipe(res);
    });
    server.listen(0, () => resolve(server));
  });
}

async function renderBatch(indices, workerId, port) {
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
    // Rewrite file:// URLs to HTTP
    htmlContent = htmlContent.replace(/file:\/\/\/root\/vsb\//g, `http://127.0.0.1:${port}/`);

    // Create a fresh page for each render to avoid state issues
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

    // Measure and scale
    const result = await renderPage.evaluate((pageH) => {
      const container = document.querySelector('.page');
      if (!container) return { scale: 1, height: 0, imgCount: 0 };

      const imgs = Array.from(document.images);
      const loadedImgs = imgs.filter(i => i.complete && i.naturalWidth > 0).length;

      const rect = container.getBoundingClientRect();
      const contentH = rect.height;

      let scale = 1;
      if (contentH > pageH) {
        scale = pageH / contentH;
      }

      if (scale < 1) {
        container.style.transformOrigin = 'top center';
        container.style.transform = `scale(${scale})`;
        container.style.width = `${100 / scale}%`;
      }

      return { scale, height: Math.round(contentH), imgCount: imgs.length, loaded: loadedImgs };
    }, PAGE_H_PX);

    await renderPage.pdf({
      path: pdfPath,
      width: '8.5in',
      height: '11in',
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
      timeout: 60000
    });

    await renderPage.close();

    console.log(JSON.stringify({ type: 'rendered', idx, scale: result.scale.toFixed(3), origH: result.height, imgs: `${result.loaded}/${result.imgCount}` }));
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
    return renderBatch(chunk, i, port);
  }));

  server.close();
  console.log(JSON.stringify({ type: 'done' }));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
#!/usr/bin/env node
/** Render spine HTML files to PDF using Playwright with proper 8.5x11in pagination.
    Playwright auto-splits tall content across multiple pages.
    Usage: node render_pdf.js '[0,1,2,...]' */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HTML_DIR = '/root/vsb/wp_html';
const PDF_DIR = '/root/vsb/wp_pdf';

if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

async function render(spineIndices) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Block font files to speed up
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.match(/\.(woff|woff2|ttf|otf|eot)$/)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  for (const idx of spineIndices) {
    const htmlPath = path.join(HTML_DIR, `page_${String(idx).padStart(4, '0')}.html`);
    const pdfPath = path.join(PDF_DIR, `page_${String(idx).padStart(4, '0')}.pdf`);

    if (!fs.existsSync(htmlPath)) {
      console.log(JSON.stringify({ type: 'skip', idx, reason: 'no html' }));
      continue;
    }

    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    await page.setContent(htmlContent, { waitUntil: 'load', timeout: 30000 });

    // Wait for all images
    await page.evaluate(async () => {
      const imgs = Array.from(document.images);
      await Promise.all(imgs.map(img => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise((resolve) => {
          img.onload = () => resolve();
          img.onerror = () => resolve();
          setTimeout(resolve, 3000);
        });
      }));
    });

    // Generate PDF with fixed 8.5x11in page size - Playwright auto-paginates
    await page.pdf({
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

    console.log(JSON.stringify({ type: 'rendered', idx, pages: pageCount }));
  }

  await page.close();
  await context.close();
  await browser.close();
  console.log(JSON.stringify({ type: 'done' }));
}

const spineIndices = JSON.parse(process.argv[2]);
render(spineIndices).catch(err => {
  console.error(err);
  process.exit(1);
});
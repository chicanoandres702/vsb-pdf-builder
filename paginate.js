#!/usr/bin/env node
/** Paginate spine HTML files using Playwright: measure content and inject page-break-before
    divs so each rendered PDF page is exactly 11in tall. Outputs to /root/vsb/paginated/.
    Usage: node paginate.js '[0,1,2,...]' */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HTML_DIR = '/root/vsb/wp_html';
const OUT_DIR = '/root/vsb/paginated';
const PAGE_HEIGHT_PX = 11 * 96; // 11in at 96dpi

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

async function paginate(spineIndices) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Block unnecessary resources to speed up
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
    if (!fs.existsSync(htmlPath)) {
      console.log(JSON.stringify({ type: 'skip', idx, reason: 'no html' }));
      continue;
    }

    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    await page.setContent(htmlContent, { waitUntil: 'load', timeout: 30000 });

    // Wait for all images to load (shorter timeout)
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

    // Measure and inject page breaks
    const result = await page.evaluate((pageHeight) => {
      const container = document.querySelector('.page');
      if (!container) return { breaks: 0, height: 0 };

      const children = Array.from(container.children);
      let accumulatedHeight = 0;
      let breaks = 0;

      for (const child of children) {
        const rect = child.getBoundingClientRect();
        const childHeight = rect.height;

        if (accumulatedHeight + childHeight > pageHeight && accumulatedHeight > 0) {
          const breakDiv = document.createElement('div');
          breakDiv.style.pageBreakBefore = 'always';
          breakDiv.style.breakBefore = 'page';
          container.insertBefore(breakDiv, child);
          accumulatedHeight = childHeight;
          breaks++;
        } else {
          accumulatedHeight += childHeight;
        }
      }
      return { breaks, height: accumulatedHeight };
    }, PAGE_HEIGHT_PX);

    // Get modified HTML with page breaks injected
    const modifiedHtml = await page.content();

    // Ensure proper @page CSS for weasyprint
    const finalHtml = modifiedHtml.replace(
      /<style>/,
      `<style>
        @page { size: 8.5in 11in; margin: 0; }
        body { margin: 0; padding: 0; }
      `
    );

    const outPath = path.join(OUT_DIR, `page_${String(idx).padStart(4, '0')}.html`);
    fs.writeFileSync(outPath, finalHtml);

    console.log(JSON.stringify({ type: 'paginated', idx, breaks: result.breaks, totalHeight: result.height }));
  }

  await page.close();
  await context.close();
  await browser.close();
  console.log(JSON.stringify({ type: 'done' }));
}

const spineIndices = JSON.parse(process.argv[2]);
paginate(spineIndices).catch(err => {
  console.error(err);
  process.exit(1);
});
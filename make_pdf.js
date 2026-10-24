const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const EPUB = '/root/vsb/epub';
const PDF_OUT = '/root/vsb/living_with_art.pdf';
const pageList = JSON.parse(fs.readFileSync('/root/vsb/dump/r_066.json', 'utf8'));
const OUT = '/root/vsb/out';
const HTML_DIR = '/root/vsb/pages_html';
if (!fs.existsSync(HTML_DIR)) fs.mkdirSync(HTML_DIR, { recursive: true });

(async () => {
  const cssImports = [];
  const cssDir = `${EPUB}/OPS/assets/css`;
  if (fs.existsSync(cssDir)) {
    for (const cf of fs.readdirSync(cssDir)) {
      if (!cf.endsWith('.css')) continue;
      let cssContent = fs.readFileSync(`${cssDir}/${cf}`, 'utf8');
      cssContent = cssContent.replace(/url\(\.\.\/\.\.\/([^)]+)\)/g, 'url("../epub/OPS/$1")');
      cssImports.push(`<style>${cssContent}</style>`);
    }
  }

  // Write all page HTML files
  for (let i = 0; i < pageList.length; i++) {
    const entry = pageList[i];
    const outName = entry.path.replace('/OPS/', '').replace(/\//g, '_');
    const xhtmlPath = `${OUT}/${outName}`;
    if (!fs.existsSync(xhtmlPath)) continue;

    let xhtml = fs.readFileSync(xhtmlPath, 'utf8');
    xhtml = xhtml.replace(/<\?xml[^>]*\?>/g, '');
    xhtml = xhtml.replace(/src="\.\.\/\.\.\/(img\/[^"]+)"/g, 'src="../epub/OPS/$1"');
    xhtml = xhtml.replace(/src="\.\.\/\.\.\/(assets\/[^"]+)"/g, 'src="../epub/OPS/$1"');
    xhtml = xhtml.replace(/href="\.\.\/\.\.\/(assets\/css\/[^"]+)"/g, 'href="../epub/OPS/$1"');
    xhtml = xhtml.replace(/url\(\.\.\/\.\.\/([^)]+)\)/g, 'url("../epub/OPS/$1")');
    xhtml = xhtml.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
    xhtml = xhtml.replace(/<link[^>]*>/g, '');
    // Strip nested html/head/body tags from inner XHTML
    xhtml = xhtml.replace(/<html[^>]*>/gi, '');
    xhtml = xhtml.replace(/<\/html[^>]*>/gi, '');
    xhtml = xhtml.replace(/<head[^>]*>[\s\S]*?<\/head[^>]*>/gi, '');
    xhtml = xhtml.replace(/<body[^>]*>/gi, '');
    xhtml = xhtml.replace(/<\/body[^>]*>/gi, '');
    // Strip the visibility:hidden style
    xhtml = xhtml.replace(/body\s*\{\s*visibility\s*:\s*hidden[^}]*\}/gi, '');
    xhtml = xhtml.replace(/<style[^>]*>[\s\S]*?<\/style[^>]*>/gi, '');

    const bodyContent = xhtml.trim();

    const pageHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body { margin: 0; padding: 0; font-family: 'Times New Roman', serif; }
  .page { width: 8.5in; min-height: 11in; box-sizing: border-box; padding: 0.5in; overflow: visible; }
  img { max-width: 100%; height: auto; display: block; }
  ${cssImports.join('\n  ')}
</style>
</head><body>
<div class="page">${bodyContent}</div>
</body></html>`;

    fs.writeFileSync(`${HTML_DIR}/page_${String(i).padStart(4, '0')}.html`, pageHtml);
  }

  console.log('Wrote', pageList.length, 'page HTML files');

  // Serve via HTTP
  const server = http.createServer((req, res) => {
    const fp = path.join('/root/vsb', req.url);
    if (!fs.existsSync(fp)) { res.writeHead(404); res.end('NF'); return; }
    const ext = path.extname(fp).toLowerCase();
    const types = { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  console.log('Server on port', port);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  const pdfFiles = [];

  for (let i = 0; i < pageList.length; i++) {
    const page = await ctx.newPage();
    const pageFile = `page_${String(i).padStart(4, '0')}.html`;
    const pdfPath = `${HTML_DIR}/page_${String(i).padStart(4, '0')}.pdf`;
    
    try {
      await page.goto(`http://localhost:${port}/pages_html/${pageFile}`, {
        timeout: 60000,
        waitUntil: 'load'
      });

      // Wait for all images to load
      await page.evaluate(async () => {
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

      const imgCount = await page.evaluate(() => document.images.length);
      const loaded = await page.evaluate(() => Array.from(document.images).filter(i => i.complete && i.naturalWidth > 0).length);

      await page.pdf({
        path: pdfPath,
        width: '8.5in', height: '11in',
        printBackground: true,
        preferCSSPageSize: false,
        margin: { top: 0, bottom: 0, left: 0, right: 0 }
      });

      const pdfContent = fs.readFileSync(pdfPath, 'utf8');
      const imageMatches = pdfContent.match(/\/Subtype \/Image/g);
      const imgObjCount = imageMatches ? imageMatches.length : 0;
      pdfFiles.push(pdfPath);

      if (imgCount > 0) console.log(`Page ${i}: ${loaded}/${imgCount} images, ${imgObjCount} img objects in PDF`);
    } catch (e) {
      console.log(`Page ${i} error:`, e.message);
    } finally {
      await page.close();
    }

    if (i % 25 === 0) console.log(`Progress: ${i}/${pageList.length}`);
  }

  console.log('Merging', pdfFiles.length, 'PDFs...');
  const mergeCmd = `pdfunite ${pdfFiles.join(' ')} "${PDF_OUT}"`;
  execSync(mergeCmd, { timeout: 120000 });
  console.log('Merged');

  const stats = fs.statSync(PDF_OUT);
  console.log('PDF saved:', stats.size, 'bytes');
  server.close();
})();
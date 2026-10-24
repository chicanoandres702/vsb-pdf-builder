const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

(async () => {
const pageList = JSON.parse(fs.readFileSync('/root/vsb/dump/r_066.json', 'utf8'));
const OUT = '/root/vsb/out';
const HTML_DIR = '/root/vsb/pages_html';
if (!fs.existsSync(HTML_DIR)) fs.mkdirSync(HTML_DIR, { recursive: true });

const cssImports = [];
const cssDir = '/root/vsb/epub/OPS/assets/css';
if (fs.existsSync(cssDir)) {
  for (const cf of fs.readdirSync(cssDir)) {
    if (!cf.endsWith('.css')) continue;
    let cssContent = fs.readFileSync(`${cssDir}/${cf}`, 'utf8');
    cssContent = cssContent.replace(/url\(\.\.\/\.\.\/([^)]+)\)/g, 'url("../epub/OPS/$1")');
    cssImports.push(`<style>${cssContent}</style>`);
  }
}

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
  xhtml = xhtml.replace(/<html[^>]*>/gi, '');
  xhtml = xhtml.replace(/<\/html[^>]*>/gi, '');
  xhtml = xhtml.replace(/<head[^>]*>[\s\S]*?<\/head[^>]*>/gi, '');
  xhtml = xhtml.replace(/<body[^>]*>/gi, '');
  xhtml = xhtml.replace(/<\/body[^>]*>/gi, '');
  xhtml = xhtml.replace(/body\s*\{\s*visibility\s*:\s*hidden[^}]*\}/gi, '');
  xhtml = xhtml.replace(/<style[^>]*>[\s\S]*?<\/style[^>]*>/gi, '');

  const bodyContent = xhtml.trim();
  const pageHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body { margin: 0; padding: 0; font-family: 'Times New Roman', serif; }
  .page { width: 8.5in; box-sizing: border-box; padding: 0.5in; overflow: visible; }
  img { max-width: 100%; height: auto; display: block; }
  ${cssImports.join('\n  ')}
</style>
</head><body>
<div class="page">${bodyContent}</div>
</body></html>`;

  fs.writeFileSync(`${HTML_DIR}/page_${String(i).padStart(4, '0')}.html`, pageHtml);
}
console.log('Wrote', pageList.length, 'page HTML files');

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
const ctx = await browser.newContext({ viewport: { width: 816, height: 900 } });

const pdfFiles = [];
for (let i = 0; i < pageList.length; i++) {
  const page = await ctx.newPage();
  const pageFile = `page_${String(i).padStart(4, '0')}.html`;
  const pdfPath = `${HTML_DIR}/page_${String(i).padStart(4, '0')}.pdf`;
  try {
    await page.goto(`http://localhost:${port}/pages_html/${pageFile}`, { timeout: 90000, waitUntil: 'load' });
    await page.evaluate(async () => {
      const imgs = Array.from(document.images);
      await Promise.all(imgs.map(img => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise(r => { img.onload = () => r(); img.onerror = () => r(); setTimeout(r, 8000); });
      }));
    });
    // measure actual content height at 96dpi
    const h = await page.evaluate(() => document.body.scrollHeight);
    const heightIn = Math.max(11, Math.ceil(h / 96 * 100) / 100);
    await page.pdf({
      path: pdfPath,
      width: '8.5in',
      height: heightIn + 'in',
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: 0, bottom: 0, left: 0, right: 0 }
    });
    pdfFiles.push(pdfPath);
    if (i % 25 === 0) console.log(`Progress: ${i}/${pageList.length} (height ${heightIn}in)`);
  } catch (e) {
    console.log(`Page ${i} error:`, e.message);
  } finally {
    await page.close();
  }
}

console.log('Merging', pdfFiles.length, 'PDFs...');
execSync(`pdfunite ${pdfFiles.join(' ')} /root/vsb/living_with_art_raw.pdf`, { timeout: 300000 });
console.log('Merged');
await browser.close();
server.close();
})().catch(e => { console.error(e); process.exit(1); });

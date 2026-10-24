const fs = require('fs');
const path = require('path');

const VSB = process.env.VSB_DIR || '/root/vsb';

const pageList = JSON.parse(fs.readFileSync(`${VSB}/dump/r_066.json`, 'utf8'));
const OUT = `${VSB}/out`;
const HTML_DIR = `${VSB}/wp_html`;
if (!fs.existsSync(HTML_DIR)) fs.mkdirSync(HTML_DIR, { recursive: true });

const epubBase = `${VSB}/epub/OPS`;
const cssImports = [];
const cssDir = `${VSB}/epub/OPS/assets/css`;
if (fs.existsSync(cssDir)) {
  for (const cf of fs.readdirSync(cssDir)) {
    if (!cf.endsWith('.css')) continue;
    let cssContent = fs.readFileSync(`${cssDir}/${cf}`, 'utf8');
    cssContent = cssContent.replace(/url\(\.\.\/\.\.\/([^)]+)\)/g, `url("${epubBase}/$1")`);
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
  xhtml = xhtml.replace(/src="\.\.\/\.\.\/(img\/[^"]+)"/g, `src="file://${epubBase}/$1"`);
  xhtml = xhtml.replace(/src="\.\.\/\.\.\/(assets\/[^"]+)"/g, `src="file://${epubBase}/$1"`);
  xhtml = xhtml.replace(/href="\.\.\/\.\.\/(assets\/css\/[^"]+)"/g, `href="${epubBase}/$1"`);
  xhtml = xhtml.replace(/url\(\.\.\/\.\.\/([^)]+)\)/g, `url("${epubBase}/$1")`);
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
  @page { size: 8.5in 200in; margin: 0; }
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
console.log('Wrote', pageList.length, 'wp HTML files');

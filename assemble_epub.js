// Assemble a valid EPUB from decrypted XHTML pages + assets
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = '/root/vsb/out';
const EPUB = '/root/vsb/epub';
const OPS = `${EPUB}/OPS`;
const META = `${EPUB}/META-INF`;
const PAGE_LIST = '/root/vsb/dump/r_066.json';
const META_JSON = '/root/vsb/dump/r_064.json';

if (!fs.existsSync(EPUB)) fs.mkdirSync(EPUB, { recursive: true });
if (!fs.existsSync(META-INF)) fs.mkdirSync(META-INF, { recursive: true });

const pageList = JSON.parse(fs.readFileSync(PAGE_LIST, 'utf8'));
const bookMeta = JSON.parse(fs.readFileSync(META_JSON, 'utf8'));
const book = bookMeta.books[0];

// 1. Write mimetype (uncompressed, first in ZIP)
const mimetype = 'application/epub+zip';
fs.writeFileSync(`${EPUB}/mimetype`, mimetype);

// 2. Write container.xml
const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
fs.writeFileSync(`${META-INF}/container.xml`, containerXml);

// 3. Write package.opf
const now = new Date().toISOString();
let spineItems = '';
let manifestItems = '';
const seen = new Set();

// Add CSS files
const cssDir = `${OPS}/assets/css`;
if (fs.existsSync(cssDir)) {
  for (const f of fs.readdirSync(cssDir)) {
    if (f.endsWith('.css')) {
      const id = `css_${f.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const href = `assets/css/${f}`;
      manifestItems += `    <item id="${id}" href="${href}" media-type="text/css"/>\n`;
    }
  }
}

// Add image files
function addManifest(dir, prefix) {
  if (!fs.existsSync(dir)) return;
  function walk(d, p) {
    for (const f of fs.readdirSync(d)) {
      const full = path.join(d, f);
      const rel = path.join(p, f);
      if (fs.statSync(full).isDirectory()) walk(full, rel);
      else if (f.match(/\.(png|jpg|jpeg|gif|svg|webp)$/)) {
        const ext = f.match(/\.([a-z]+)$/)[1];
        const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
        const id = `img_${rel.replace(/[^a-zA-Z0-9]/g, '_')}`;
        manifestItems += `    <item id="${id}" href="${rel}" media-type="${mime}"/>\n`;
      }
    }
  }
  walk(dir, prefix);
}
addManifest(`${OPS}/img`, 'img');
addManifest(`${OPS}/assets`, 'assets');

// Add XHTML spine items
for (let i = 0; i < pageList.length; i++) {
  const entry = pageList[i];
  const outName = entry.path.replace('/OPS/', '').replace(/\//g, '_');
  const xhtmlPath = `${OUT}/${outName}`;
  if (!fs.existsSync(xhtmlPath)) continue;

  const id = `page_${i}`;
  const href = entry.path.replace('/OPS/', '');
  manifestItems += `    <item id="${id}" href="${href}" media-type="application/xhtml+xml"/>\n`;
  spineItems += `    <itemref idref="${id}"/>\n`;
}

const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:${book.isbn}</dc:identifier>
    <dc:title>${book.title}</dc:title>
    <dc:creator>${book.author}</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier scheme="ISBN">${book.isbn}</dc:identifier>
    <meta property="dcterms:modified">${now}</meta>
  </metadata>
  <manifest>
${manifestItems}  </manifest>
  <spine>
${spineItems}  </spine>
</package>`;
fs.writeFileSync(`${OPS}/package.opf`, opf);

// 4. Copy XHTML files into OPS preserving structure
for (const entry of pageList) {
  const outName = entry.path.replace('/OPS/', '').replace(/\//g, '_');
  const xhtmlPath = `${OUT}/${outName}`;
  if (!fs.existsSync(xhtmlPath)) continue;

  // Fix asset paths for EPUB structure
  let xhtml = fs.readFileSync(xhtmlPath, 'utf8');
  xhtml = xhtml.replace(/src="\.\.\/\.\.\/(img\/[^"]+)"/g, 'src="../$1"');
  xhtml = xhtml.replace(/src="\.\.\/\.\.\/(assets\/[^"]+)"/g, 'src="../$1"');
  xhtml = xhtml.replace(/href="\.\.\/\.\.\/(assets\/css\/[^"]+)"/g, 'href="../$1"');
  // Remove scripts
  xhtml = xhtml.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');

  const dest = path.join(OPS, entry.path.replace('/OPS/', ''));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, xhtml);
}

// 5. Build EPUB ZIP (mimetype stored uncompressed, then everything else)
const epubPath = '/root/vsb/living_with_art.epub';
const { execSync } = require('child_process');

// Use system zip with proper EPUB ordering
execSync(
  `cd "${EPUB}" && zip -0X "${epubPath}" mimetype && zip -9 "${epubPath}" META-INF/container.xml OPS/package.opf OPS/assets OPS/img $(find OPS -name '*.xhtml' | sort)`,
  { stdio: 'inherit' }
);

const stats = fs.statSync(epubPath);
console.log(`EPUB created: ${epubPath} (${stats.size} bytes)`);
console.log(`Pages: ${pageList.length}`);
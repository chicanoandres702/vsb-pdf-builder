// Step 2: Fetch all assets (CSS, images) referenced in the decrypted XHTML
const https = require('https');
const fs = require('fs');
const path = require('path');

const Vbid = '9781266607752';
const OUT = '/root/vsb/out';
const EPUB = '/root/vsb/epub';
const OPS = `${EPUB}/OPS`;

// Load cookies
const cookies = JSON.parse(fs.readFileSync(`${OUT}/cookies.json`, 'utf8'));
const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

// Scan all XHTML for asset references
const xhtmlFiles = fs.readdirSync(OUT).filter(f => f.endsWith('.xhtml'));
const cssPaths = new Set();
const imgPaths = new Set();

for (const f of xhtmlFiles) {
  const content = fs.readFileSync(`${OUT}/${f}`, 'utf8');
  // CSS links
  let m;
  while ((m = /href="([^"]*\.css)"/g.exec(content)) !== null) cssPaths.add(m[1]);
  // Images
  while ((m = /src="([^"]*\.(?:png|jpg|jpeg|gif|svg|webp))"/g.exec(content)) !== null) imgPaths.add(m[1]);
}

console.log(`Found ${cssPaths.size} CSS files, ${imgPaths.size} images`);

function fetchAsset(relPath) {
  const url = `https://jigsaw.vitalsource.com/books/${Vbid}/epub${relPath}?bc_token=400d31c0-b077-013f-1f83-62a3ec843065&js=bach`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Cookie: cookieStr, 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

(async () => {
  // Fetch CSS
  for (const css of cssPaths) {
    const dest = path.join(OPS, css.replace(/^\//, ''));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      const data = await fetchAsset(css);
      fs.writeFileSync(dest, data);
      console.log(`CSS: ${css} -> ${dest} (${data.length} bytes)`);
    } catch (e) {
      console.log(`CSS FAIL: ${css} - ${e.message}`);
    }
  }

  // Fetch images
  let ok = 0, fail = 0;
  for (const img of imgPaths) {
    const dest = path.join(OPS, img.replace(/^\//, ''));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      const data = await fetchAsset(img);
      fs.writeFileSync(dest, data);
      ok++;
    } catch (e) {
      fail++;
      console.log(`IMG FAIL: ${img} - ${e.message}`);
    }
  }
  console.log(`Images: ${ok} ok, ${fail} failed`);
})();
// Full extraction pipeline: login -> get fresh bc_token -> fetch all pages -> decrypt -> assemble EPUB -> convert to PDF
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const KEY = Buffer.from([
  0xdc,0x6d,0xba,0x54,0xac,0x91,0xc9,0xe7,0x56,0xa4,0xdd,0x34,
  0xd1,0x3e,0x45,0xb2,0xd8,0x60,0x80,0x6c,0x2d,0x2f,0xf6,0xac,
  0x26,0xfe,0xfc,0x4f,0xac,0x71,0xd4,0xc2
]);

const Vbid = '9781266607752';
const OUT = '/root/vsb/out';
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function decryptPage(encryptedText) {
  const [ivPart, cipherPart] = encryptedText.split(':');
  const iv = Buffer.from(ivPart.split(',').map(Number));
  const ciphertext = Buffer.from(cipherPart, 'base64');
  const tag = ciphertext.slice(-16);
  const data = ciphertext.slice(0, -16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function decodePage(decrypted) {
  const b64 = decrypted.toString('utf16le').trim();
  return Buffer.from(b64, 'base64').toString('utf8');
}

function fetchWithCookies(url, cookieStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { Cookie: cookieStr, 'User-Agent': 'Mozilla/5.0', Accept: '*/*' }
    };
    https.get(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // Step 1: Load the bookshelf to get a fresh bc_token
  console.log('Step 1: Getting fresh bc_token...');
  const bookshelfUrl = `https://bc.vitalsource.com/books/${Vbid}?bc_token=400d31c0-b077-013f-1f83-62a3ec843065&relaunch_vbid=${Vbid}&course_dash_relaunch=true`;
  await page.goto(bookshelfUrl, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(5000);

  // Capture all responses
  const responses = [];
  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (url.includes('jigsaw.vitalsource.com') && url.includes('/books/') && url.endsWith('.xhtml')) {
        const body = await res.text();
        responses.push({ url, body });
      }
    } catch {}
  });

  // Step 2: Try to get the page list from the reader
  console.log('Step 2: Navigating to reader...');
  // The reader loads pages via jigsaw. Let's intercept the bc_token from the page
  const html = await page.content();
  fs.writeFileSync(path.join(OUT, 'reader.html'), html);

  // Find fresh bc_token in the page
  const bcMatch = html.match(/bc_token=([a-f0-9-]+)/) || html.match(/"bc_token":"([a-f0-9-]+)"/);
  let bcToken = bcMatch ? bcMatch[1] : null;
  console.log('Fresh bc_token:', bcToken ? bcToken.slice(0, 8) + '...' : 'NOT FOUND');

  // Get cookies
  const cookies = await ctx.cookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  fs.writeFileSync(path.join(OUT, 'cookies.json'), JSON.stringify(cookies, null, 2));
  console.log('Cookies:', cookies.length);

  // Save the page list JSON we captured earlier
  const pageList = JSON.parse(fs.readFileSync('/root/vsb/dump/r_066.json', 'utf8'));
  console.log('Total pages to fetch:', pageList.length);

  // Step 3: Fetch and decrypt each page
  let success = 0;
  for (let i = 0; i < pageList.length; i++) {
    const entry = pageList[i];
    const pagePath = entry.path;
    const url = `https://jigsaw.vitalsource.com/books/${Vbid}/epub${pagePath}?bc_token=${bcToken}&js=bach`;

    try {
      const { status, body } = await fetchWithCookies(url, cookieStr);
      if (status !== 200) {
        console.log(`  [${i+1}/${pageList.length}] ${pagePath} -> HTTP ${status}`);
        continue;
      }

      const match = body.match(/<div id="page-content">([^<]*)<\/div>/);
      if (!match || !match[1]) {
        console.log(`  [${i+1}/${pageList.length}] ${pagePath} -> no encrypted content`);
        continue;
      }

      const decrypted = decryptPage(match[1]);
      const xhtml = decodePage(decrypted);

      const outName = pagePath.replace('/OPS/', '').replace(/\//g, '_');
      fs.writeFileSync(path.join(OUT, outName), xhtml);
      success++;
      console.log(`  [${i+1}/${pageList.length}] ${pagePath} -> OK (${xhtml.length} bytes)`);
    } catch (e) {
      console.log(`  [${i+1}/${pageList.length}] ${pagePath} -> ERROR: ${e.message}`);
    }
  }

  console.log(`\nDecrypted ${success}/${pageList.length} pages`);
  await browser.close();
  console.log('Done. Files in', OUT);
})();
#!/usr/bin/env node
/** New book extraction pipeline: URL + bc_token -> fetch pages -> decrypt -> save HTML.
    Streams JSON progress to stdout.
    Usage: node extract_new.js '{"url":"...","jobId":"..."}' */
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

const VSB_DIR = process.env.VSB_DIR || '/root/vsb';
const DUMP = `${VSB_DIR}/dump`;
const OUT = `${VSB_DIR}/out`;

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

function out(type, data) {
  console.log(JSON.stringify({ type, ...data }));
}

async function main() {
  const cfg = JSON.parse(process.argv[2]);
  const url = cfg.url;
  const jobId = cfg.jobId;

  // Parse URL to extract vbid and bc_token
  const u = new URL(url);
  const vbid = u.searchParams.get('relaunch_vbid') || u.searchParams.get('vbid') || u.pathname.split('/').pop();
  const bcToken = u.searchParams.get('bc_token');

  if (!bcToken) {
    out('error', { message: 'No bc_token in URL' });
    process.exit(1);
  }

  out('progress', { progress: 0, message: `Extracting book ${vbid}...` });

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // Load the book page to get cookies
  const bookUrl = `https://bc.vitalsource.com/books/${vbid}?bc_token=${bcToken}&relaunch_vbid=${vbid}&course_dash_relaunch=true`;
  try {
    await page.goto(bookUrl, { waitUntil: 'networkidle', timeout: 90000 });
  } catch (e) {
    out('error', { message: `Navigation failed: ${e.message}` });
    process.exit(1);
  }
  await page.waitForTimeout(3000);

  const cookies = await ctx.cookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  // Get page list from spine
  const spinePath = `${DUMP}/r_066.json`;
  if (!fs.existsSync(spinePath)) {
    out('error', { message: 'No spine data. Run capture first.' });
    process.exit(1);
  }
  const pageList = JSON.parse(fs.readFileSync(spinePath, 'utf8'));
  const total = pageList.length;
  out('progress', { progress: 5, message: `Found ${total} pages to fetch` });

  // Fetch and decrypt each page
  let success = 0;
  let fail = 0;
  for (let i = 0; i < pageList.length; i++) {
    const entry = pageList[i];
    const pagePath = entry.path;
    const fetchUrl = `https://jigsaw.vitalsource.com/books/${vbid}/epub${pagePath}?bc_token=${bcToken}&js=bach`;

    try {
      const { status, body } = await fetchWithCookies(fetchUrl, cookieStr);
      if (status !== 200) {
        fail++;
        continue;
      }

      const match = body.match(/<div id="page-content">([^<]*)<\/div>/);
      if (!match || !match[1]) {
        fail++;
        continue;
      }

      const decrypted = decryptPage(match[1]);
      const xhtml = decodePage(decrypted);

      const outName = pagePath.replace('/OPS/', '').replace(/\//g, '_');
      if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, outName), xhtml);
      success++;
    } catch (e) {
      fail++;
    }

    if (i % 10 === 0 || i === total - 1) {
      const pct = 5 + Math.round((i / total) * 70);
      out('progress', { progress: pct, message: `Fetched ${success} pages, ${fail} failed [${i+1}/${total}]` });
    }
  }

  out('progress', { progress: 80, message: `Extraction done: ${success}/${total} pages decrypted` });

  // Save metadata
  const meta = { vbid, bcToken, title: `Book ${vbid}`, success, total };
  fs.writeFileSync(`${DUMP}/r_064.json`, JSON.stringify({ books: [meta] }, null, 2));

  await browser.close();
  out('done', { message: 'Extraction complete' });
}

main().catch(err => {
  out('error', { message: err.message });
  process.exit(1);
});
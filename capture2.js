const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT = '/root/vsb/dump';
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const captured = new Map();
  page.on('response', async (res) => {
    const url = res.url();
    if (captured.has(url)) return;
    const ct = (res.headers()['content-type'] || '').toLowerCase();
    let body;
    try { body = await res.text(); } catch { return; }
    captured.set(url, body);
  });

  const consoleMsgs = [];
  page.on('console', m => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => consoleMsgs.push(`[pageerror] ${e.message}`));

  // capture all network as HAR-ish
  const TARGET = 'https://bc.vitalsource.com/books/9781266431227?bc_token=400d31c0-b077-013f-1f83-62a3ec843065&relaunch_vbid=9781266431227&course_dash_relaunch=true';

  let html;
  try {
    html = await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 90000 });
  } catch (e) {
    html = await page.content();
  }

  fs.writeFileSync(path.join(OUT, 'page.html'), await page.content());

  // wait for late resources
  await page.waitForTimeout(8000);

  // also try clicking / interacting to trigger API calls
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch {}

  // save all captured resources by type
  let i = 0;
  const index = [];
  for (const [url, body] of captured) {
    i++;
    const ct = (res => res && res.headers ? res.headers()['content-type'] : '')(page);
    let ext = '.bin';
    const u = url.toLowerCase();
    if (u.endsWith('.js') || u.includes('javascript')) ext = '.js';
    else if (u.endsWith('.json') || u.includes('json')) ext = '.json';
    else if (u.endsWith('.png')) ext = '.png';
    else if (u.endsWith('.jpg') || u.endsWith('.jpeg')) ext = '.jpg';
    else if (u.endsWith('.gif')) ext = '.gif';
    else if (u.endsWith('.svg')) ext = '.svg';
    else if (u.endsWith('.woff') || u.endsWith('.woff2')) ext = '.woff2';
    else if (u.endsWith('.ttf')) ext = '.ttf';
    else if (u.endsWith('.eot')) ext = '.eot';
    else if (u.endsWith('.webp')) ext = '.webp';
    else if (u.endsWith('.webm')) ext = '.webm';
    else if (u.endsWith('.mp4')) ext = '.mp4';
    else if (u.endsWith('.css')) ext = '.css';
    else if (u.endsWith('.html')) ext = '.html';
    else if (u.endsWith('.xml')) ext = '.xml';
    else if (u.endsWith('.map')) ext = '.map';

    const name = `r_${String(i).padStart(3, '0')}${ext}`;
    fs.writeFileSync(path.join(OUT, name), body);
    index.push(`${name}\t${url}`);
  }

  fs.writeFileSync(path.join(OUT, 'resources.txt'), index.join('\n'));
  fs.writeFileSync(path.join(OUT, 'console.log'), consoleMsgs.join('\n'));

  const cookies = await ctx.cookies();
  fs.writeFileSync(path.join(OUT, 'cookies.json'), JSON.stringify(cookies, null, 2));

  console.log('Resources captured:', captured.size);
  await browser.close();
})();
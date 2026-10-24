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

  const jsFiles = new Map();
  page.on('response', async (res) => {
    const url = res.url();
    const ct = res.headers()['content-type'] || '';
    if (url.endsWith('.js') || ct.includes('javascript')) {
      try {
        const body = await res.text();
        jsFiles.set(url, body);
      } catch {}
    }
  });

  const consoleMsgs = [];
  page.on('console', m => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => consoleMsgs.push(`[pageerror] ${e.message}`));

  const TARGET = 'https://bc.vitalsource.com/books/9781266431227?bc_token=400d31c0-b077-013f-1f83-62a3ec843065&relaunch_vbid=9781266431227&course_dash_relaunch=true';

  let html;
  try {
    html = await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (e) {
    html = await page.content();
  }

  // save html
  fs.writeFileSync(path.join(OUT, 'page.html'), await page.content());

  // wait a bit for any late js
  await page.waitForTimeout(5000);

  // save all js
  let i = 0;
  for (const [url, body] of jsFiles) {
    i++;
    const name = `js_${String(i).padStart(3, '0')}.js`;
    fs.writeFileSync(path.join(OUT, name), `// URL: ${url}\n` + body);
  }

  fs.writeFileSync(path.join(OUT, 'js_index.txt'), [...jsFiles.keys()].map((u, i) => `${String(i+1).padStart(3,'0')}: ${u}`).join('\n'));
  fs.writeFileSync(path.join(OUT, 'console.log'), consoleMsgs.join('\n'));

  // also dump localStorage / cookies
  const cookies = await ctx.cookies();
  fs.writeFileSync(path.join(OUT, 'cookies.json'), JSON.stringify(cookies, null, 2));

  console.log('JS files captured:', jsFiles.size);
  await browser.close();
})();
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const TARGET = 'https://bc.vitalsource.com/books/9781266431227?bc_token=400d31c0-b077-013f-1f83-62a3ec843065&relaunch_vbid=9781266431227&course_dash_relaunch=true';

  console.log('Loading page...');
  await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(5000);

  const cookies = await ctx.cookies();
  fs.writeFileSync('/root/vsb/dump/cookies.json', JSON.stringify(cookies, null, 2));
  console.log('Saved', cookies.length, 'cookies');

  // Netscape format for curl
  let out = '# Netscape HTTP Cookie File\n';
  for (const c of cookies) {
    const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
    out += `${domain}\tTRUE\t${c.path || '/'}\t${c.secure ? 'TRUE' : 'FALSE'}\t${(c.expires||0)}\t${c.name}\t${c.value}\n`;
  }
  fs.writeFileSync('/tmp/vsb_cookies.txt', out);
  console.log('Saved Netscape cookie file');

  await browser.close();
  console.log('Done.');
})();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

(async () => {
  const cookies = JSON.parse(fs.readFileSync('/root/vsb/dump/cookies.json', 'utf8'));
  
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  
  // Add cookies
  await ctx.addCookies(cookies);
  
  const page = await ctx.newPage();
  
  // Navigate to the book
  await page.goto('https://bc.vitalsource.com/books/9781266431227', { 
    timeout: 60000, 
    waitUntil: 'domcontentloaded' 
  });
  
  console.log('Page title:', await page.title());
  console.log('URL:', page.url());
  
  // Check if we're on the reader
  const isReader = await page.evaluate(() => {
    return document.querySelector('.reader, [class*="reader"], [class*="book"]') !== null;
  });
  console.log('On reader page:', isReader);
  
  // Wait a bit for the reader to load
  await page.waitForTimeout(5000);
  
  // Try to get the reader URL
  const readerUrl = page.url();
  console.log('Reader URL:', readerUrl);
  
  // Take screenshot to see what we got
  await page.screenshot({ path: '/root/vsb/screenshot.png', fullPage: true });
  
  await browser.close();
})();
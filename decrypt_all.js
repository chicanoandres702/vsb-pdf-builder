// Batch decrypt all captured .bin pages to XHTML
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const KEY = Buffer.from([
  0xdc,0x6d,0xba,0x54,0xac,0x91,0xc9,0xe7,0x56,0xa4,0xdd,0x34,
  0xd1,0x3e,0x45,0xb2,0xd8,0x60,0x80,0x6c,0x2d,0x2f,0xf6,0xac,
  0x26,0xfe,0xfc,0x4f,0xac,0x71,0xd4,0xc2
]);

function decryptPage(encryptedText) {
  const [ivPart, cipherPart] = encryptedText.split(':');
  if (!ivPart || !cipherPart) throw new Error('Invalid format');
  const iv = Buffer.from(ivPart.split(',').map(Number));
  const ciphertext = Buffer.from(cipherPart, 'base64');
  const tag = ciphertext.slice(-16);
  const data = ciphertext.slice(0, -16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

const dumpDir = '/root/vsb/dump';
const outDir = '/root/vsb/decoded';
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const files = fs.readdirSync(dumpDir).filter(f => f.endsWith('.bin'));
let ok = 0, fail = 0;
const results = [];

for (const f of files) {
  const src = path.join(dumpDir, f);
  try {
    const raw = fs.readFileSync(src, 'utf8');
    const match = raw.match(/<div id="page-content">([^<]*)<\/div>/);
    if (!match) { console.log(`SKIP ${f}: no page-content div`); continue; }
    const decrypted = decryptPage(match[1]);
    // UTF-16LE -> base64 -> XHTML
    const b64 = decrypted.toString('utf16le').trim();
    const xhtml = Buffer.from(b64, 'base64').toString('utf8');
    const outName = f.replace('.bin', '.xhtml');
    fs.writeFileSync(path.join(outDir, outName), xhtml);
    results.push({ file: f, out: outName, bytes: xhtml.length });
    ok++;
  } catch (e) {
    console.log(`FAIL ${f}: ${e.message}`);
    fail++;
  }
}

console.log(`\nDecrypted: ${ok} ok, ${fail} failed`);
for (const r of results) {
  console.log(`  ${r.out} — ${r.bytes} bytes`);
}
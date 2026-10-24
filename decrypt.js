// VitalSource EPUB Content Decryptor
//
// Deobfuscated from the obfuscated script in r_017.deob.js (jigsaw mosaic reader).
// The original code:
//   1. Reads the encrypted page content from <div id="page-content"> (format: "iv_bytes_base64:ciphertext_base64")
//   2. Splits on ':' -> [ivPart, cipherPart]
//   3. ivPart is comma-separated decimal byte values (e.g. "107,82,110,...")
//   4. cipherPart is base64-encoded ciphertext+GCM tag
//   5. Decrypts with AES-256-GCM using a hardcoded 32-byte key
//   6. Submits the decrypted result via a form POST (the favre parameter)
//
// Hardcoded AES-256 key (32 bytes):
const KEY = Buffer.from([
  0xdc,0x6d,0xba,0x54,0xac,0x91,0xc9,0xe7,0x56,0xa4,0xdd,0x34,
  0xd1,0x3e,0x45,0xb2,0xd8,0x60,0x80,0x6c,0x2d,0x2f,0xf6,0xac,
  0x26,0xfe,0xfc,0x4f,0xac,0x71,0xd4,0xc2
]);

const crypto = require('crypto');

function decryptPage(encryptedText) {
  // Format: "107,82,110,...:base64ciphertext"
  const [ivPart, cipherPart] = encryptedText.split(':');
  if (!ivPart || !cipherPart) throw new Error('Invalid encrypted page format');

  // IV = comma-separated decimal bytes
  const iv = Buffer.from(ivPart.split(',').map(Number));

  // Ciphertext = base64 decode (includes 16-byte GCM auth tag at end)
  const ciphertext = Buffer.from(cipherPart, 'base64');

  // AES-256-GCM: last 16 bytes are the auth tag
  const tag = ciphertext.slice(-16);
  const data = ciphertext.slice(0, -16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);

  let decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted;
}

// Test with the captured encrypted page
const fs = require('fs');
const encrypted = fs.readFileSync('/root/vsb/dump/r_088.bin', 'utf8');

// Extract the page-content div value
const match = encrypted.match(/<div id="page-content">([^<]*)<\/div>/);
if (!match) {
  console.error('Could not find page-content div');
  process.exit(1);
}

const encryptedPayload = match[1];
console.log('Encrypted payload (first 80 chars):', encryptedPayload.slice(0, 80));
console.log('IV bytes:', encryptedPayload.split(':')[0]);

try {
  const decrypted = decryptPage(encryptedPayload);
  console.log('\nDecrypted (' + decrypted.length + ' bytes):');
  console.log(decrypted.toString('utf8').slice(0, 500));

  fs.writeFileSync('/root/vsb/dump/decrypted_page.html', decrypted);
  console.log('\nSaved to /root/vsb/dump/decrypted_page.html');
} catch (e) {
  console.error('Decryption failed:', e.message);
}
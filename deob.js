const fs = require('fs').promises;
const parser = require('@babel/parser');
const prettier = require('prettier');

const dir = '/root/vsb/dump';

const SEMANTIC = {
  'eyJ': 'JWT_HEADER',
  '/user/verify': 'API_USER_VERIFY',
  '/user': 'API_USER',
  '/info/books.json': 'API_BOOKS_INFO',
  '/books/': 'API_BOOK',
  '/tokens/print': 'API_PRINT_TOKEN',
  '/secure-token': 'API_SECURE_TOKEN',
  '/base64font': 'API_BASE64FONT',
  '/socket': 'API_SOCKET',
  '/ancillaries/code': 'API_ANCILLARIES',
  '/toc': 'API_TOC',
  '/pagebreaks': 'API_PAGEBREAKS',
  '/pages.json': 'API_PAGES',
  '/bookmarks': 'API_BOOKMARKS',
  '/highlights': 'API_HIGHLIGHTS',
  '/logs/bookmark': 'API_LOGS',
  '/epub/OPS': 'EPUB_OPS',
  '/mosaic/public/': 'MOSAIC_PUBLIC',
  '/api/brands/': 'API_BRANDS',
  '/api/session': 'API_SESSION',
  '/api/assets': 'API_ASSETS',
  '/ai/api/': 'API_AI',
  '/api/users/me/': 'API_USER_ME',
  '/api/agentic-interface/': 'API_AGENTIC',
  'Authorization': 'HEADER_AUTHORIZATION',
  'Content-Type': 'HEADER_CONTENT_TYPE',
  'application/x-www-form-urlencoded': 'MIME_FORM_URLENCODED',
  'application/json': 'MIME_JSON',
  'Bearer': 'SCHEME_BEARER',
};

function semanticFor(str) {
  for (const [k, v] of Object.entries(SEMANTIC)) {
    if (str.includes(k)) return v;
  }
  return null;
}

async function processFile(filename) {
  const p = `${dir}/${filename}`;
  if (!(await fs.stat(p).catch(() => null))) return;
  let src = await fs.readFile(p, 'utf8');
  src = src.replace(/^\/\/ URL: .+\n/, '');

  let ast;
  try {
    ast = parser.parse(src, { sourceType: 'module', errorRecovery: true });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const hints = [];
  const seen = new Set();
  parser.parse(src, { sourceType: 'module', errorRecovery: true });
  const collect = (node) => {
    if (!node) return;
    if (node.type === 'StringLiteral' && typeof node.value === 'string') {
      const s = semanticFor(node.value);
      if (s) {
        const key = s + '|' + node.value.slice(0, 60);
        if (!seen.has(key)) { seen.add(key); hints.push({ str: node.value, semantic: s }); }
      }
    }
    for (const k in node) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === 'object' && v.type) collect(v);
    }
  };
  collect(ast.program);

  let header = `// =====================================================================\n`;
  header += `// DEOBFUSCATED (formatted) FILE: ${filename}\n`;
  header += `// Original was minified (mangled identifiers) - NOT obfuscated/encrypted.\n`;
  header += `// Pretty-printed with Babel/Prettier for readability.\n`;
  header += `// Variable names remain minified (no semantic info available).\n`;
  header += `// =====================================================================\n`;
  header += `// SEMANTIC HINTS (string literals with known meaning):\n`;
  if (hints.length) {
    hints.forEach(({ str, semantic }) => {
      header += `//   ${semantic}: ${str.slice(0, 120)}${str.length > 120 ? '...' : ''}\n`;
    });
  } else {
    header += `//   (none detected)\n`;
  }
  header += `// =====================================================================\n\n`;

  try {
    const formatted = await prettier.format(src, { parser: 'babel' });
    return { ok: true, code: header + formatted };
  } catch (e) {
    return { ok: true, code: header + src };
  }
}

(async () => {
  const files = process.argv.slice(2);
  for (const f of files) {
    const res = await processFile(f);
    if (res.ok) {
      await fs.writeFile(`${dir}/${f.replace('.js', '.deob.js')}`, res.code);
      console.log('deobfuscated', f, res.code.length);
    } else {
      console.log('FAIL', f, res.error);
    }
  }
})();

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const VSB = process.env.VSB_DIR || __dirname;
const HTML_DIR = `${VSB}/wp_html`;
const PDF_DIR = `${VSB}/wp_pdf`;
const OUT_DIR = `${VSB}/out_pdf`;
const TOC_PATH = `${VSB}/dump/r_091.bin`;
const SPINE_PATH = `${VSB}/dump/r_066.json`;

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// In-memory job state
const jobs = new Map();

function loadToc() {
  return JSON.parse(fs.readFileSync(TOC_PATH, 'utf8'));
}
function loadSpine() {
  return JSON.parse(fs.readFileSync(SPINE_PATH, 'utf8'));
}

// Build a chapter list from TOC (level 1 document_container entries)
function buildChapters() {
  const toc = loadToc();
  const spine = loadSpine();
  const chapters = [];
  let cur = null;
  for (const t of toc) {
    if (t.level === 1 && t.kind === 'document_container') {
      cur = { title: t.title, page: t.page, startSpine: null, endSpine: null, sections: [] };
      chapters.push(cur);
    }
    if (cur && t.level === 2 && t.kind === 'document') {
      // find spine index by matching cfiWithoutAssertions exactly (after stripping data-uuid)
      const tcfi = t.cfi.replace(/\[data-uuid-[a-f0-9]+\]/g, '');
      const idx = spine.findIndex(e => {
        const ecfi = e.cfiWithoutAssertions.replace(/\[data-uuid-[a-f0-9]+\]/g, '');
        // Exact match, or TOC cfi starts with spine cfi followed by '/' or '!' (segment boundary)
        return tcfi === ecfi || tcfi.startsWith(ecfi + '/') || tcfi.startsWith(ecfi + '!');
      });
      if (cur.startSpine == null) cur.startSpine = idx;
      cur.endSpine = idx;
      cur.sections.push({ title: t.title, page: t.page, spine: idx });
    }
  }
  return chapters;
}

function serveFile(res, fp, type) {
  if (!fs.existsSync(fp)) { res.writeHead(404); res.end('Not Found'); return; }
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(fp).pipe(res);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost`);
  const p = u.pathname;

  if (p === '/' || p === '/index.html') {
    const html = fs.readFileSync(`${VSB}/public/index.html`, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }
  if (p === '/api/chapters') {
    const chapters = buildChapters();
    // Add back matter entries not covered by any chapter
    const covered = new Set();
    for (const ch of chapters) for (const s of ch.sections) if (s.spine != null) covered.add(s.spine);
    const spine = loadSpine();
    const extra = [];
    for (let i = 0; i < spine.length; i++) {
      if (!covered.has(i)) extra.push({ title: spine[i].path.replace('/OPS/s9ml/', '').replace('.xhtml', ''), page: '', spine: i });
    }
    if (extra.length) {
      chapters.push({ title: 'Back Matter', page: 0, startSpine: null, endSpine: null, sections: extra });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(chapters));
    return;
  }
  if (p === '/api/build' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let cfg = {};
      try { cfg = JSON.parse(body || '{}'); } catch {}
      const chapters = cfg.chapters || null;
      const jobId = 'job_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
      const job = { id: jobId, status: 'queued', progress: 0, message: 'Queued', chapters, out: `${OUT_DIR}/living_with_art.pdf` };
      jobs.set(jobId, job);
      runBuild(job);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jobId }));
    });
    return;
  }
  if (p === '/api/newbook' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let cfg = {};
      try { cfg = JSON.parse(body || '{}'); } catch {}
      const url = cfg.url || '';
      const jobId = 'job_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
      const job = { id: jobId, status: 'queued', progress: 0, message: 'Starting new book extraction...', url, out: `${OUT_DIR}/living_with_art.pdf` };
      jobs.set(jobId, job);
      runNewBook(job);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jobId }));
    });
    return;
  }
  if (p.startsWith('/api/job/')) {
    const jobId = p.slice('/api/job/'.length);
    const job = jobs.get(jobId);
    if (!job) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(job));
    return;
  }
  if (p === '/pdf') {
    const f = `${OUT_DIR}/living_with_art.pdf`;
    serveFile(res, f, 'application/pdf');
    return;
  }
  res.writeHead(404); res.end('NF');
});

function runBuild(job) {
  job.status = 'running';
  job.progress = 0;
  job.message = 'Starting build';
  const spine = loadSpine();
  const allChapters = buildChapters();
  // Determine which spine indices to render
  let spineIndices;
  if (job.chapters && job.chapters.length) {
    // job.chapters is an array of chapter indices to include
    const selectedChapters = job.chapters.map(i => allChapters[i]).filter(Boolean);
    spineIndices = [];
    for (const ch of selectedChapters) {
      for (const s of ch.sections) spineIndices.push(s.spine);
    }
    spineIndices = [...new Set(spineIndices)].filter(i => i != null).sort((a, b) => a - b);
  } else {
    spineIndices = spine.map((_, i) => i);
  }
  job.total = spineIndices.length;
  job.spineIndices = spineIndices;

  // Run the python builder as a subprocess, streaming progress
  const py = spawn('python3', [`${VSB}/build_server.py`, JSON.stringify({ spine_indices: spineIndices, outDir: OUT_DIR, finalOut: job.out })], {
    env: { ...process.env, JOB_ID: job.id, VSB_DIR: VSB }
  });
  let buf = '';
  py.stdout.on('data', d => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'progress') {
          job.progress = msg.progress;
          job.message = msg.message;
        } else if (msg.type === 'done') {
          job.status = 'complete';
          job.progress = 100;
          job.message = 'Complete';
          job.pdf = msg.pdf;
          job.pdfName = msg.pdfName || 'living_with_art';
        } else if (msg.type === 'error') {
          job.status = 'error';
          job.message = msg.message;
        }
      } catch {}
    }
  });
  py.stderr.on('data', d => {
    job.message = 'Error: ' + d.toString().slice(0, 200);
  });
  py.on('close', code => {
    if (job.status !== 'complete' && job.status !== 'error') {
      job.status = code === 0 ? 'complete' : 'error';
      job.progress = job.status === 'complete' ? 100 : job.progress;
    }
  });
}

function runNewBook(job) {
  job.status = 'running';
  job.progress = 0;
  job.message = 'Starting new book extraction...';

  const extract = spawn('node', [`${VSB}/extract_new.js`, JSON.stringify({ url: job.url, jobId: job.id })], {
    env: { ...process.env, JOB_ID: job.id, VSB_DIR: VSB }
  });
  let buf = '';
  extract.stdout.on('data', d => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'progress') {
          job.progress = msg.progress;
          job.message = msg.message;
        } else if (msg.type === 'done') {
          job.status = 'complete';
          job.progress = 100;
          job.message = 'Extraction complete, starting build...';
          runBuild(job);
        } else if (msg.type === 'error') {
          job.status = 'error';
          job.message = msg.message;
        }
      } catch {}
    }
  });
  extract.stderr.on('data', d => {
    job.message = 'Error: ' + d.toString().slice(0, 200);
  });
  extract.on('close', code => {
    if (job.status !== 'complete' && job.status !== 'error') {
      job.status = code === 0 ? 'complete' : 'error';
    }
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
});

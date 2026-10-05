#!/usr/bin/env node
// Builds the self-hosted Pyodide bundle into pyodide-host/dist/v<VERSION>/.
// Node >= 18, no npm dependencies. Shells out to `tar` for .tar.bz2 extraction.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.29.5';
const ASSET = `pyodide-${VERSION}.tar.bz2`;
const ASSET_URL = `https://github.com/pyodide/pyodide/releases/download/${VERSION}/${ASSET}`;
const RELEASE_API = `https://api.github.com/repos/pyodide/pyodide/releases/tags/${VERSION}`;
const ALLOWLIST = ['numpy', 'pandas', 'matplotlib', 'scipy', 'scikit-learn', 'sympy', 'openpyxl', 'pillow', 'pyyaml', 'pytest'];
const CORE_FILES = ['pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
const VENDORED = [
  { name: 'et-xmlfile', version: '2.0.0', file: 'et_xmlfile-2.0.0-py3-none-any.whl',
    sha256: '7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa', imports: ['et_xmlfile'], depends: [] },
  { name: 'openpyxl', version: '3.1.5', file: 'openpyxl-3.1.5-py2.py3-none-any.whl',
    sha256: '5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2', imports: ['openpyxl'], depends: ['et-xmlfile'] },
];
const MAX_FILE = 25 * 1024 * 1024;
const MAX_COUNT = 20000;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostDir = path.join(root, 'pyodide-host');
const distDir = path.join(hostDir, 'dist');
const outDir = path.join(distDir, `v${VERSION}`);
const norm = (n) => n.toLowerCase().replace(/[-_.]+/g, '-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchBuf(url, tries = 3, opts = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'cognita-pyodide-build' }, ...opts });
      if (res.status === 404) { const e = new Error(`404 ${url}`); e.notFound = true; throw e; }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      last = e;
      if (e.notFound) throw e;
      console.warn(`attempt ${i}/${tries} failed: ${e.message}`);
      if (i < tries) await sleep(1500 * i);
    }
  }
  throw last;
}

async function downloadPyodide() {
  try {
    return await fetchBuf(ASSET_URL);
  } catch (e) {
    if (!e.notFound) throw e;
    console.warn('Hardcoded URL returned 404, querying release API');
    const rel = JSON.parse((await fetchBuf(RELEASE_API)).toString('utf8'));
    const asset = (rel.assets || []).find((a) => /^pyodide-0\.29\.5\.tar\.bz2$/.test(a.name))
      || (rel.assets || []).find((a) => /^pyodide-.*\.tar\.bz2$/.test(a.name) && !/core|debug/.test(a.name));
    if (!asset) throw new Error('No suitable tar.bz2 asset in release');
    console.log(`Using asset ${asset.name}`);
    return fetchBuf(asset.browser_download_url);
  }
}

function findFile(dir, name) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isFile() && ent.name === name) return dir;
    if (ent.isDirectory()) { const r = findFile(p, name); if (r) return r; }
  }
  return null;
}

function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc); else acc.push(p);
  }
  return acc;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pyodide-build-'));
  try {
    console.log(`Downloading ${ASSET}`);
    const tarBuf = await downloadPyodide();
    const tarPath = path.join(tmp, ASSET);
    fs.writeFileSync(tarPath, tarBuf);
    console.log(`Downloaded ${(tarBuf.length / 1048576).toFixed(1)} MB, extracting`);
    const ex = path.join(tmp, 'x');
    fs.mkdirSync(ex);
    execFileSync('tar', ['-xjf', tarPath, '-C', ex], { stdio: 'inherit' });
    const src = findFile(ex, 'pyodide-lock.json');
    if (!src) throw new Error('pyodide-lock.json not found in archive');

    const lock = JSON.parse(fs.readFileSync(path.join(src, 'pyodide-lock.json'), 'utf8'));
    const pkgs = lock.packages;
    const byNorm = new Map(Object.entries(pkgs).map(([k, v]) => [norm(k), k]));
    const vendoredNames = new Set(VENDORED.map((v) => norm(v.name)));

    const keep = new Set();
    const visit = (n) => {
      const nn = norm(n);
      if (keep.has(nn)) return;
      keep.add(nn);
      if (vendoredNames.has(nn)) return;
      const key = byNorm.get(nn);
      if (!key) throw new Error(`Package ${n} not in lock file`);
      for (const d of pkgs[key].depends || []) visit(d);
    };
    ALLOWLIST.forEach(visit);

    fs.rmSync(distDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of CORE_FILES.filter((f) => f !== 'pyodide-lock.json')) {
      fs.copyFileSync(path.join(src, f), path.join(outDir, f));
    }

    const newPkgs = {};
    for (const nn of [...keep].sort()) {
      if (vendoredNames.has(nn)) continue;
      const key = byNorm.get(nn);
      const entry = pkgs[key];
      fs.copyFileSync(path.join(src, entry.file_name), path.join(outDir, entry.file_name));
      newPkgs[key] = entry;
    }

    for (const v of VENDORED) {
      const meta = JSON.parse((await fetchBuf(`https://pypi.org/pypi/${v.name}/${v.version}/json`)).toString('utf8'));
      const f = (meta.urls || []).find((u) => u.filename === v.file);
      if (!f) throw new Error(`${v.file} not on PyPI`);
      const buf = await fetchBuf(f.url);
      const sum = createHash('sha256').update(buf).digest('hex');
      if (sum !== v.sha256) throw new Error(`sha256 mismatch for ${v.file}: ${sum}`);
      fs.writeFileSync(path.join(outDir, v.file), buf);
      newPkgs[v.name] = {
        name: v.name, version: v.version, file_name: v.file, install_dir: 'site', sha256: v.sha256,
        package_type: 'package', imports: v.imports, depends: v.depends,
        unvendored_tests: false, shared_library: false,
      };
      console.log(`Vendored ${v.file} (sha256 ok)`);
    }

    const newNorm = new Set(Object.keys(newPkgs).map(norm));
    for (const [k, p] of Object.entries(newPkgs)) {
      for (const d of p.depends || []) if (!newNorm.has(norm(d))) throw new Error(`${k} depends on missing ${d}`);
      if (!fs.existsSync(path.join(outDir, p.file_name))) throw new Error(`missing file ${p.file_name}`);
    }
    fs.writeFileSync(path.join(outDir, 'pyodide-lock.json'), JSON.stringify({ info: lock.info, packages: newPkgs }));

    const headers = path.join(hostDir, '_headers');
    if (!fs.existsSync(headers)) throw new Error('pyodide-host/_headers missing');
    fs.copyFileSync(headers, path.join(distDir, '_headers'));

    const files = walk(distDir).map((p) => ({ p, s: fs.statSync(p).size }));
    const total = files.reduce((a, f) => a + f.s, 0);
    const big = files.reduce((a, f) => (f.s > a.s ? f : a), files[0]);
    console.log(`Packages kept (${Object.keys(newPkgs).length}): ${Object.keys(newPkgs).sort().join(', ')}`);
    console.log(`Total size: ${(total / 1048576).toFixed(2)} MB`);
    console.log(`File count: ${files.length}`);
    console.log(`Biggest file: ${path.relative(distDir, big.p)} (${(big.s / 1048576).toFixed(2)} MB)`);
    let bad = false;
    if (files.some((f) => f.s >= MAX_FILE)) { console.error('ERROR: a file is >= 25 MiB'); bad = true; }
    if (files.length > MAX_COUNT) { console.error('ERROR: more than 20000 files'); bad = true; }
    if (bad) process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

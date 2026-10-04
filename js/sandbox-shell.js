/* js/sandbox-shell.js
 * The workspace filesystem and the small built-in shell used by the Tier 1
 * (browser) agent sandbox. Plain JavaScript with no dependencies, written as a
 * classic script that also works under Node, so it can be tested without a
 * browser. In the browser it runs inside the sandboxed iframe
 * (sandbox-frame.html), never in the main Cognita page.
 *
 * What this is, honestly: real file operations on a real (in-memory) file
 * tree, and a real command interpreter for the commands listed in COMMANDS.
 * It is not Bash. There is no git, npm, curl or background process here, and
 * the shell says so (exit code 127) instead of pretending. Python and
 * JavaScript are run by the frame through the hooks the caller passes in
 * (ctx.runPython / ctx.runJs / ctx.pipInstall).
 */
(function (root) {
  'use strict';

  var ROOT = '/workspace';
  var enc = new TextEncoder();
  var dec = new TextDecoder('utf-8', { fatal: false });

  // ── Paths ──────────────────────────────────────────────────────────
  // Returns a clean absolute path inside /workspace, or null if it would escape.
  function resolvePath(p, cwd) {
    if (typeof p !== 'string' || p.length === 0 || p.length > 300 || p.indexOf('\0') !== -1) return null;
    var base = cwd && (cwd === ROOT || cwd.indexOf(ROOT + '/') === 0) ? cwd : ROOT;
    if (p === '~' || p.indexOf('~/') === 0) p = ROOT + p.slice(1);
    var joined = p.charAt(0) === '/' ? p : base + '/' + p;
    var out = [];
    var parts = joined.split('/');
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part === '' || part === '.') continue;
      if (part === '..') { if (out.length === 0) return null; out.pop(); continue; }
      out.push(part);
    }
    var full = '/' + out.join('/');
    if (full !== ROOT && full.indexOf(ROOT + '/') !== 0) return null;
    return full;
  }
  function dirname(p) { var i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
  function basename(p) { return p.slice(p.lastIndexOf('/') + 1); }

  // ── Virtual filesystem ─────────────────────────────────────────────
  // files: path -> { data: Uint8Array, version: number }
  // dirs:  Set of directory paths (always contains ROOT)
  function VFS(limits) {
    this.files = new Map();
    this.dirs = new Set([ROOT]);
    this.version = 0;
    this.limits = limits || { maxFileBytes: 2 * 1024 * 1024, maxWorkspaceBytes: 10 * 1024 * 1024 };
  }
  VFS.prototype.setLimits = function (l) { if (l) this.limits = l; };
  VFS.prototype.totalBytes = function () {
    var n = 0; this.files.forEach(function (f) { n += f.data.length; }); return n;
  };
  VFS.prototype.isFile = function (p) { return this.files.has(p); };
  VFS.prototype.isDir = function (p) { return this.dirs.has(p); };
  VFS.prototype.exists = function (p) { return this.files.has(p) || this.dirs.has(p); };
  VFS.prototype.mkdirp = function (p) {
    if (this.files.has(p)) throw fsError('EEXIST', p + ': a file exists with that name');
    var parts = p.split('/').filter(Boolean), cur = '';
    for (var i = 0; i < parts.length; i++) {
      cur += '/' + parts[i];
      if (this.files.has(cur)) throw fsError('ENOTDIR', cur + ': not a directory');
      if (cur.length >= ROOT.length) this.dirs.add(cur);
    }
  };
  VFS.prototype.writeFile = function (p, data) {
    var bytes = typeof data === 'string' ? enc.encode(data) : data;
    if (bytes.length > this.limits.maxFileBytes) {
      throw fsError('EFBIG', p + ': file is too large (limit ' + Math.round(this.limits.maxFileBytes / 1048576) + ' MB)');
    }
    var existing = this.files.get(p);
    var delta = bytes.length - (existing ? existing.data.length : 0);
    if (this.totalBytes() + delta > this.limits.maxWorkspaceBytes) {
      throw fsError('ENOSPC', 'workspace is full (limit ' + Math.round(this.limits.maxWorkspaceBytes / 1048576) + ' MB)');
    }
    if (this.dirs.has(p)) throw fsError('EISDIR', p + ': is a directory');
    this.mkdirp(dirname(p));
    this.files.set(p, { data: bytes, version: ++this.version });
  };
  VFS.prototype.readBytes = function (p) {
    var f = this.files.get(p);
    if (!f) throw fsError(this.dirs.has(p) ? 'EISDIR' : 'ENOENT', p + (this.dirs.has(p) ? ': is a directory' : ': no such file'));
    return f.data;
  };
  VFS.prototype.readText = function (p) { return dec.decode(this.readBytes(p)); };
  VFS.prototype.list = function (dir) {
    var prefix = dir === '/' ? '/' : dir + '/';
    var seen = new Map();
    var self = this;
    this.dirs.forEach(function (d) {
      if (d !== dir && d.indexOf(prefix) === 0 && d.slice(prefix.length).indexOf('/') === -1) seen.set(d.slice(prefix.length), { name: d.slice(prefix.length), type: 'dir', size: 0 });
    });
    this.files.forEach(function (f, path) {
      if (path.indexOf(prefix) === 0 && path.slice(prefix.length).indexOf('/') === -1) seen.set(path.slice(prefix.length), { name: path.slice(prefix.length), type: 'file', size: f.data.length });
    });
    var out = Array.from(seen.values());
    out.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    return out;
  };
  // Every file path at or below dir.
  VFS.prototype.walk = function (dir) {
    var prefix = dir === '/' ? '/' : dir + '/';
    var out = [];
    this.files.forEach(function (_f, path) { if (path.indexOf(prefix) === 0) out.push(path); });
    out.sort();
    return out;
  };
  VFS.prototype.allDirsUnder = function (dir) {
    var prefix = dir + '/';
    var out = [];
    this.dirs.forEach(function (d) { if (d.indexOf(prefix) === 0) out.push(d); });
    out.sort();
    return out;
  };
  VFS.prototype.remove = function (p, recursive) {
    if (p === ROOT) throw fsError('EBUSY', 'cannot remove the workspace root');
    if (this.files.has(p)) { this.files.delete(p); return; }
    if (!this.dirs.has(p)) throw fsError('ENOENT', p + ': no such file or directory');
    var kids = this.walk(p), subdirs = this.allDirsUnder(p);
    if (!recursive && (kids.length || subdirs.length)) throw fsError('ENOTEMPTY', p + ': is a directory (use rm -r)');
    var self = this;
    kids.forEach(function (k) { self.files.delete(k); });
    subdirs.forEach(function (d) { self.dirs.delete(d); });
    this.dirs.delete(p);
  };
  VFS.prototype.copy = function (from, to, recursive) {
    if (this.files.has(from)) {
      var target = this.dirs.has(to) ? to + '/' + basename(from) : to;
      this.writeFile(target, this.files.get(from).data.slice());
      return;
    }
    if (!this.dirs.has(from)) throw fsError('ENOENT', from + ': no such file or directory');
    if (!recursive) throw fsError('EISDIR', from + ': is a directory (use cp -r)');
    var dest = this.dirs.has(to) ? to + '/' + basename(from) : to;
    if (dest === from || dest.indexOf(from + '/') === 0) throw fsError('EINVAL', 'cannot copy a folder into itself');
    this.mkdirp(dest);
    var self = this;
    this.allDirsUnder(from).forEach(function (d) { self.mkdirp(dest + d.slice(from.length)); });
    this.walk(from).forEach(function (f) { self.writeFile(dest + f.slice(from.length), self.files.get(f).data.slice()); });
  };
  VFS.prototype.move = function (from, to) {
    if (!this.exists(from)) throw fsError('ENOENT', from + ': no such file or directory');
    var dest = this.dirs.has(to) ? to + '/' + basename(from) : to;
    if (dest === from) return;
    if (this.dirs.has(from) && (dest + '/').indexOf(from + '/') === 0) throw fsError('EINVAL', 'cannot move a folder into itself');
    this.copy(from, dest, true);
    this.remove(from, true);
  };
  // Path -> version, for working out what a command changed.
  VFS.prototype.versions = function () {
    var m = new Map(); this.files.forEach(function (f, p) { m.set(p, f.version + ':' + f.data.length); }); return m;
  };
  VFS.prototype.diffSince = function (before) {
    var changes = [], self = this;
    this.files.forEach(function (f, p) {
      var prev = before.get(p), now = f.version + ':' + f.data.length;
      if (prev === undefined) changes.push({ path: p, size: f.data.length, change: 'created' });
      else if (prev !== now) changes.push({ path: p, size: f.data.length, change: 'modified' });
    });
    before.forEach(function (_v, p) { if (!self.files.has(p)) changes.push({ path: p, size: 0, change: 'deleted' }); });
    changes.sort(function (a, b) { return a.path < b.path ? -1 : 1; });
    return changes;
  };
  VFS.prototype.reset = function () { this.files.clear(); this.dirs = new Set([ROOT]); };

  function fsError(code, message) { var e = new Error(message); e.code = code; return e; }

  // ── Tokenising ─────────────────────────────────────────────────────
  // Splits a command line into [{ words:[{text, quoted}], op }] statements
  // joined by ; && ||, each with pipeline stages split on |.
  function tokenize(line) {
    var tokens = [], cur = '', quoted = false, inWord = false, i = 0, ch;
    function pushWord() { if (inWord) { tokens.push({ t: 'w', text: cur, quoted: quoted }); } cur = ''; quoted = false; inWord = false; }
    while (i < line.length) {
      ch = line.charAt(i);
      if (ch === "'") {
        var j = line.indexOf("'", i + 1);
        if (j === -1) throw new Error('unterminated quote');
        cur += line.slice(i + 1, j); quoted = true; inWord = true; i = j + 1; continue;
      }
      if (ch === '"') {
        var k = i + 1, buf = '';
        while (k < line.length && line.charAt(k) !== '"') {
          if (line.charAt(k) === '\\' && k + 1 < line.length && '"\\$`'.indexOf(line.charAt(k + 1)) !== -1) { buf += line.charAt(k + 1); k += 2; continue; }
          buf += line.charAt(k); k++;
        }
        if (k >= line.length) throw new Error('unterminated quote');
        cur += buf; quoted = true; inWord = true; i = k + 1; continue;
      }
      if (ch === '\\' && i + 1 < line.length) { cur += line.charAt(i + 1); inWord = true; i += 2; continue; }
      if (ch === ' ' || ch === '\t' || ch === '\n') { pushWord(); i++; continue; }
      if (ch === '#' && !inWord) break;
      if (ch === ';') { pushWord(); tokens.push({ t: 'op', text: ';' }); i++; continue; }
      if (ch === '&' && line.charAt(i + 1) === '&') { pushWord(); tokens.push({ t: 'op', text: '&&' }); i += 2; continue; }
      if (ch === '|' && line.charAt(i + 1) === '|') { pushWord(); tokens.push({ t: 'op', text: '||' }); i += 2; continue; }
      if (ch === '|') { pushWord(); tokens.push({ t: 'op', text: '|' }); i++; continue; }
      if (ch === '&') { throw new Error('background jobs (&) are not supported in the browser sandbox'); }
      if (ch === '>' || (ch === '2' && line.charAt(i + 1) === '>' && !inWord)) {
        pushWord();
        var fd = 1; if (ch === '2') { fd = 2; i++; }
        var op = '>'; i++;
        if (line.charAt(i) === '>') { op = '>>'; i++; }
        if (fd === 2 && line.charAt(i) === '&' && line.charAt(i + 1) === '1') { tokens.push({ t: 'redir', fd: 2, op: '2>&1' }); i += 2; continue; }
        tokens.push({ t: 'redir', fd: fd, op: op });
        continue;
      }
      if (ch === '<') throw new Error('input redirection (<) is not supported; use cat file | command');
      cur += ch; inWord = true; i++;
    }
    pushWord();
    return tokens;
  }

  function parse(tokens) {
    // statements: [{ pipeline: [stage], joiner }]; stage: { argv:[{text,quoted}], redirs:[] }
    var stmts = [], pipeline = [], stage = { argv: [], redirs: [] }, joiner = null, pendingRedir = null;
    function endStage() { if (stage.argv.length === 0 && stage.redirs.length === 0) throw new Error('syntax error near unexpected token'); pipeline.push(stage); stage = { argv: [], redirs: [] }; }
    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i];
      if (pendingRedir) {
        if (tk.t !== 'w') throw new Error('syntax error: missing file after redirect');
        pendingRedir.target = tk.text; stage.redirs.push(pendingRedir); pendingRedir = null; continue;
      }
      if (tk.t === 'w') stage.argv.push({ text: tk.text, quoted: tk.quoted });
      else if (tk.t === 'redir') { if (tk.op === '2>&1') stage.redirs.push({ fd: 2, op: '2>&1' }); else pendingRedir = { fd: tk.fd, op: tk.op }; }
      else if (tk.text === '|') endStage();
      else { // ; && ||
        endStage(); stmts.push({ pipeline: pipeline, joiner: joiner }); pipeline = []; joiner = tk.text;
      }
    }
    if (pendingRedir) throw new Error('syntax error: missing file after redirect');
    if (stage.argv.length || stage.redirs.length) { pipeline.push(stage); }
    if (pipeline.length) stmts.push({ pipeline: pipeline, joiner: joiner });
    else if (joiner && joiner !== ';') throw new Error('syntax error near unexpected token');
    return stmts;
  }

  // Unquoted * ? [..] in an argument expands against the filesystem.
  function globToRegExp(pat) {
    var re = '^';
    for (var i = 0; i < pat.length; i++) {
      var c = pat.charAt(i);
      if (c === '*') re += '[^/]*'; else if (c === '?') re += '[^/]'; else if (c === '[') { var j = pat.indexOf(']', i + 1); if (j === -1) { re += '\\['; } else { re += '[' + pat.slice(i + 1, j).replace(/\\/g, '\\\\') + ']'; i = j; } }
      else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
    return new RegExp(re + '$');
  }
  function expandArgs(argv, ctx) {
    var out = [];
    argv.forEach(function (a) {
      var text = a.text;
      if (!a.quoted) text = text.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, function (_m, name) { return ctx.env[name] !== undefined ? ctx.env[name] : ''; });
      if (!a.quoted && /[*?\[]/.test(text)) {
        var slash = text.lastIndexOf('/');
        var dirPart = slash === -1 ? '' : text.slice(0, slash + 1), filePart = text.slice(slash + 1);
        var dirAbs = resolvePath(dirPart === '' ? '.' : dirPart, ctx.cwd);
        if (dirAbs && ctx.fs.isDir(dirAbs) && !/[*?\[]/.test(dirPart)) {
          var re = globToRegExp(filePart), hits = [];
          ctx.fs.list(dirAbs).forEach(function (e) { if ((filePart.charAt(0) === '.' || e.name.charAt(0) !== '.') && re.test(e.name)) hits.push(dirPart + e.name); });
          if (hits.length) { out.push.apply(out, hits); return; }
        }
      }
      out.push(text);
    });
    return out;
  }

  // ── Commands ───────────────────────────────────────────────────────
  // Each command: async function (args, io, ctx) -> exit code.
  // io: { stdin: string|null, out(text), err(text) }
  var UNAVAILABLE = {
    git: 'git is not available in the browser sandbox. Use the GitHub connector tools to read a repository.',
    npm: 'npm is not available in the browser sandbox.', npx: 'npx is not available in the browser sandbox.',
    yarn: 'yarn is not available in the browser sandbox.', pnpm: 'pnpm is not available in the browser sandbox.',
    curl: 'curl is not available: the sandbox has no internet access.', wget: 'wget is not available: the sandbox has no internet access.',
    ssh: 'ssh is not available: the sandbox has no internet access.', sudo: 'sudo is not available: there is no root here and none is needed.',
    apt: 'apt is not available in the browser sandbox.', 'apt-get': 'apt-get is not available in the browser sandbox.',
    docker: 'docker is not available in the browser sandbox.', make: 'make is not available in the browser sandbox.',
    sed: 'sed is not available. Use python, or grep with a pipe.', awk: 'awk is not available. Use python for text processing.',
    bash: 'bash is not available; this is a built-in shell. Run the commands directly.', sh: 'sh is not available; this is a built-in shell. Run the commands directly.',
    vim: 'Interactive editors are not available. Use write_file or echo with a redirect.', nano: 'Interactive editors are not available. Use write_file or echo with a redirect.',
    kill: 'There are no background processes in the browser sandbox.', ps: 'There are no background processes in the browser sandbox.',
  };

  function fmtSize(n) { return String(n); }

  function lines(text) { if (text === '') return []; var l = text.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; }
  function parseFlags(args, withValue) {
    // returns { flags:Set, values:{}, rest:[] } for short flags like -la, -n 5
    var flags = new Set(), values = {}, rest = [], i = 0, done = false;
    while (i < args.length) {
      var a = args[i];
      if (!done && a === '--') { done = true; i++; continue; }
      if (!done && a.length > 1 && a.charAt(0) === '-' && !/^-\d+$/.test(a)) {
        if (withValue && withValue.indexOf(a) !== -1) { values[a] = args[i + 1]; i += 2; continue; }
        for (var k = 1; k < a.length; k++) flags.add(a.charAt(k));
        i++; continue;
      }
      rest.push(a); i++;
    }
    return { flags: flags, values: values, rest: rest };
  }
  function pathOrErr(p, ctx, io, cmd) {
    var abs = resolvePath(p, ctx.cwd);
    if (!abs) { io.err(cmd + ': ' + p + ': outside the workspace\n'); return null; }
    return abs;
  }
  function wrap(fn) {
    return async function (args, io, ctx) {
      try { return await fn(args, io, ctx); }
      catch (e) { io.err(((e && e.message) || String(e)) + '\n'); return 1; }
    };
  }

  var COMMANDS = {
    pwd: wrap(async function (_a, io, ctx) { io.out(ctx.cwd + '\n'); return 0; }),

    cd: wrap(async function (a, io, ctx) {
      var target = a[0] === undefined ? ROOT : a[0];
      if (target === '-') target = ctx.env.OLDPWD || ROOT;
      var abs = pathOrErr(target, ctx, io, 'cd'); if (!abs) return 1;
      if (!ctx.fs.isDir(abs)) { io.err('cd: ' + target + (ctx.fs.isFile(abs) ? ': not a directory' : ': no such directory') + '\n'); return 1; }
      ctx.env.OLDPWD = ctx.cwd; ctx.cwd = abs; ctx.env.PWD = abs; return 0;
    }),

    ls: wrap(async function (a, io, ctx) {
      var p = parseFlags(a), long = p.flags.has('l'), all = p.flags.has('a'), rec = p.flags.has('R');
      var targets = p.rest.length ? p.rest : ['.'], code = 0;
      function show(abs, label, header) {
        if (header) io.out(label + ':\n');
        var entries = ctx.fs.list(abs).filter(function (e) { return all || e.name.charAt(0) !== '.'; });
        entries.forEach(function (e) { io.out(long ? (e.type === 'dir' ? 'd ' : '- ') + fmtSize(e.size).padStart(9) + ' ' + e.name + (e.type === 'dir' ? '/' : '') + '\n' : e.name + (e.type === 'dir' ? '/' : '') + '\n'); });
        if (rec) entries.forEach(function (e) { if (e.type === 'dir') { io.out('\n'); show(abs + '/' + e.name, label + '/' + e.name, true); } });
      }
      targets.forEach(function (t, idx) {
        var abs = pathOrErr(t, ctx, io, 'ls'); if (!abs) { code = 1; return; }
        if (ctx.fs.isFile(abs)) { io.out((long ? '- ' + fmtSize(ctx.fs.readBytes(abs).length).padStart(9) + ' ' : '') + t + '\n'); return; }
        if (!ctx.fs.isDir(abs)) { io.err('ls: ' + t + ': no such file or directory\n'); code = 1; return; }
        if (targets.length > 1 && idx > 0) io.out('\n');
        show(abs, t, targets.length > 1 || rec);
      });
      return code;
    }),

    tree: wrap(async function (a, io, ctx) {
      var abs = pathOrErr(a[0] || '.', ctx, io, 'tree'); if (!abs) return 1;
      if (!ctx.fs.isDir(abs)) { io.err('tree: ' + (a[0] || '.') + ': no such directory\n'); return 1; }
      io.out((a[0] || '.') + '\n');
      var nd = 0, nf = 0;
      (function walk(dir, prefix) {
        var es = ctx.fs.list(dir).filter(function (e) { return e.name.charAt(0) !== '.'; });
        es.forEach(function (e, i) {
          var last = i === es.length - 1;
          io.out(prefix + (last ? '\u2514\u2500\u2500 ' : '\u251c\u2500\u2500 ') + e.name + '\n');
          if (e.type === 'dir') { nd++; walk(dir + '/' + e.name, prefix + (last ? '    ' : '\u2502   ')); } else nf++;
        });
      })(abs, '');
      io.out('\n' + nd + ' directories, ' + nf + ' files\n'); return 0;
    }),

    cat: wrap(async function (a, io, ctx) {
      var p = parseFlags(a), code = 0, n = 0;
      if (p.rest.length === 0) { var t = io.stdin || ''; io.out(p.flags.has('n') ? lines(t).map(function (l) { return String(++n).padStart(6) + '\t' + l; }).join('\n') + '\n' : t); return 0; }
      p.rest.forEach(function (f) {
        var abs = pathOrErr(f, ctx, io, 'cat'); if (!abs) { code = 1; return; }
        try {
          var text = ctx.fs.readText(abs);
          io.out(p.flags.has('n') ? lines(text).map(function (l) { return String(++n).padStart(6) + '\t' + l; }).join('\n') + '\n' : text);
        } catch (e) { io.err('cat: ' + f + ': ' + (e.code === 'EISDIR' ? 'is a directory' : 'no such file') + '\n'); code = 1; }
      });
      return code;
    }),

    head: wrap(async function (a, io, ctx) { return headTail(a, io, ctx, true); }),
    tail: wrap(async function (a, io, ctx) { return headTail(a, io, ctx, false); }),

    wc: wrap(async function (a, io, ctx) {
      var p = parseFlags(a), want = { l: p.flags.has('l'), w: p.flags.has('w'), c: p.flags.has('c') };
      if (!want.l && !want.w && !want.c) want = { l: true, w: true, c: true };
      function count(text, label) {
        var parts = [];
        if (want.l) parts.push(String(text === '' ? 0 : (text.match(/\n/g) || []).length).padStart(7));
        if (want.w) parts.push(String((text.trim() === '' ? [] : text.trim().split(/\s+/)).length).padStart(7));
        if (want.c) parts.push(String(enc.encode(text).length).padStart(7));
        io.out(parts.join('') + (label ? ' ' + label : '') + '\n');
      }
      if (p.rest.length === 0) { count(io.stdin || '', ''); return 0; }
      var code = 0;
      p.rest.forEach(function (f) { var abs = pathOrErr(f, ctx, io, 'wc'); if (!abs) { code = 1; return; } try { count(ctx.fs.readText(abs), f); } catch (_e) { io.err('wc: ' + f + ': no such file\n'); code = 1; } });
      return code;
    }),

    grep: wrap(async function (a, io, ctx) {
      var p = parseFlags(a, ['-e']), ic = p.flags.has('i'), num = p.flags.has('n'), rec = p.flags.has('r') || p.flags.has('R'), inv = p.flags.has('v'), cnt = p.flags.has('c'), listOnly = p.flags.has('l'), fixed = p.flags.has('F');
      var rest = p.rest.slice(), pattern = p.values['-e'];
      if (pattern === undefined) pattern = rest.shift();
      if (pattern === undefined) { io.err('usage: grep [-ivnclrF] pattern [file ...]\n'); return 2; }
      var re;
      try { re = new RegExp(fixed ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern, ic ? 'i' : ''); } catch (_e) { io.err('grep: invalid pattern\n'); return 2; }
      var files = [];
      if (rest.length === 0 && !rec) files = [null];
      else (rest.length ? rest : ['.']).forEach(function (f) {
        var abs = pathOrErr(f, ctx, io, 'grep'); if (!abs) return;
        if (ctx.fs.isDir(abs)) { if (rec) ctx.fs.walk(abs).forEach(function (x) { files.push(x); }); else io.err('grep: ' + f + ': is a directory\n'); }
        else files.push(abs);
      });
      var multi = files.length > 1 || rec, matched = false, code = 0;
      files.forEach(function (abs) {
        var text;
        if (abs === null) text = io.stdin || '';
        else { try { text = ctx.fs.readText(abs); } catch (_e) { io.err('grep: ' + abs + ': no such file\n'); code = 2; return; } }
        var hits = 0;
        lines(text).forEach(function (line, idx) {
          if (re.test(line) !== inv) { hits++; matched = true; if (!cnt && !listOnly) io.out((multi && abs ? displayPath(abs, ctx) + ':' : '') + (num ? (idx + 1) + ':' : '') + line + '\n'); }
        });
        if (cnt) io.out((multi && abs ? displayPath(abs, ctx) + ':' : '') + hits + '\n');
        if (listOnly && hits > 0) io.out(displayPath(abs, ctx) + '\n');
      });
      return code || (matched ? 0 : 1);
    }),

    find: wrap(async function (a, io, ctx) {
      var start = '.', i = 0, namePat = null, type = null, maxDepth = Infinity, iname = false;
      if (a.length && a[0].charAt(0) !== '-') { start = a[0]; i = 1; }
      for (; i < a.length; i++) {
        if (a[i] === '-name' || a[i] === '-iname') { iname = a[i] === '-iname'; namePat = a[++i]; }
        else if (a[i] === '-type') type = a[++i];
        else if (a[i] === '-maxdepth') maxDepth = parseInt(a[++i], 10);
        else { io.err('find: unsupported option ' + a[i] + '\n'); return 1; }
      }
      var abs = pathOrErr(start, ctx, io, 'find'); if (!abs) return 1;
      if (!ctx.fs.exists(abs)) { io.err('find: ' + start + ': no such file or directory\n'); return 1; }
      var re = namePat ? new RegExp(globToRegExp(namePat).source, iname ? 'i' : '') : null, results = [];
      function consider(path, isDir) {
        var depth = path === abs ? 0 : path.slice(abs.length).split('/').length - 1;
        if (depth > maxDepth) return;
        if (type === 'f' && isDir) return; if (type === 'd' && !isDir) return;
        if (re && !re.test(basename(path))) return;
        results.push(path === abs ? start : (start === '.' ? '.' + path.slice(abs.length) : start.replace(/\/$/, '') + path.slice(abs.length)));
      }
      consider(abs, true);
      ctx.fs.allDirsUnder(abs).forEach(function (d) { consider(d, true); });
      ctx.fs.walk(abs).forEach(function (f) { consider(f, false); });
      if (ctx.fs.isFile(abs)) { results.length = 0; consider(abs, false); }
      results.sort().forEach(function (r) { io.out(r + '\n'); });
      return 0;
    }),

    mkdir: wrap(async function (a, io, ctx) {
      var p = parseFlags(a), code = 0;
      if (!p.rest.length) { io.err('usage: mkdir [-p] dir ...\n'); return 1; }
      p.rest.forEach(function (d) {
        var abs = pathOrErr(d, ctx, io, 'mkdir'); if (!abs) { code = 1; return; }
        if (!p.flags.has('p') && ctx.fs.exists(abs)) { io.err('mkdir: ' + d + ': already exists\n'); code = 1; return; }
        if (!p.flags.has('p') && !ctx.fs.isDir(dirname(abs))) { io.err('mkdir: ' + d + ': parent folder does not exist (use -p)\n'); code = 1; return; }
        try { ctx.fs.mkdirp(abs); } catch (e) { io.err('mkdir: ' + e.message + '\n'); code = 1; }
      });
      return code;
    }),

    touch: wrap(async function (a, io, ctx) {
      var code = 0;
      a.forEach(function (f) {
        var abs = pathOrErr(f, ctx, io, 'touch'); if (!abs) { code = 1; return; }
        if (ctx.fs.isDir(abs)) return;
        ctx.fs.writeFile(abs, ctx.fs.isFile(abs) ? ctx.fs.readBytes(abs).slice() : '');
      });
      return code;
    }),

    cp: wrap(async function (a, io, ctx) {
      var p = parseFlags(a), rec = p.flags.has('r') || p.flags.has('R');
      if (p.rest.length < 2) { io.err('usage: cp [-r] source ... dest\n'); return 1; }
      var dest = pathOrErr(p.rest[p.rest.length - 1], ctx, io, 'cp'); if (!dest) return 1;
      var srcs = p.rest.slice(0, -1);
      if (srcs.length > 1 && !ctx.fs.isDir(dest)) { io.err('cp: target is not a directory\n'); return 1; }
      var code = 0;
      srcs.forEach(function (s) { var abs = pathOrErr(s, ctx, io, 'cp'); if (!abs) { code = 1; return; } try { ctx.fs.copy(abs, dest, rec); } catch (e) { io.err('cp: ' + e.message + '\n'); code = 1; } });
      return code;
    }),

    mv: wrap(async function (a, io, ctx) {
      if (a.length < 2) { io.err('usage: mv source ... dest\n'); return 1; }
      var dest = pathOrErr(a[a.length - 1], ctx, io, 'mv'); if (!dest) return 1;
      var srcs = a.slice(0, -1);
      if (srcs.length > 1 && !ctx.fs.isDir(dest)) { io.err('mv: target is not a directory\n'); return 1; }
      var code = 0;
      srcs.forEach(function (s) { var abs = pathOrErr(s, ctx, io, 'mv'); if (!abs) { code = 1; return; } try { ctx.fs.move(abs, dest); } catch (e) { io.err('mv: ' + e.message + '\n'); code = 1; } });
      return code;
    }),

    rm: wrap(async function (a, io, ctx) {
      var p = parseFlags(a), rec = p.flags.has('r') || p.flags.has('R'), force = p.flags.has('f'), code = 0;
      if (!p.rest.length && !force) { io.err('usage: rm [-rf] file ...\n'); return 1; }
      p.rest.forEach(function (f) {
        var abs = pathOrErr(f, ctx, io, 'rm'); if (!abs) { code = 1; return; }
        if (abs === ROOT) { io.err('rm: refusing to remove the workspace root\n'); code = 1; return; }
        if (!ctx.fs.exists(abs)) { if (!force) { io.err('rm: ' + f + ': no such file or directory\n'); code = 1; } return; }
        try { ctx.fs.remove(abs, rec); } catch (e) { io.err('rm: ' + e.message + '\n'); code = 1; }
        if (ctx.cwd === abs || ctx.cwd.indexOf(abs + '/') === 0) ctx.cwd = ROOT;
      });
      return code;
    }),

    echo: wrap(async function (a, io) {
      var nl = true, args = a.slice();
      if (args[0] === '-n') { nl = false; args.shift(); }
      io.out(args.join(' ') + (nl ? '\n' : '')); return 0;
    }),

    sort: wrap(async function (a, io, ctx) {
      var p = parseFlags(a), text = '';
      if (p.rest.length) p.rest.forEach(function (f) { var abs = pathOrErr(f, ctx, io, 'sort'); if (abs) text += ctx.fs.readText(abs); }); else text = io.stdin || '';
      var l = lines(text);
      l.sort(p.flags.has('n') ? function (x, y) { return (parseFloat(x) || 0) - (parseFloat(y) || 0); } : function (x, y) { return x < y ? -1 : x > y ? 1 : 0; });
      if (p.flags.has('r')) l.reverse();
      if (p.flags.has('u')) l = l.filter(function (x, i) { return i === 0 || x !== l[i - 1]; });
      if (l.length) io.out(l.join('\n') + '\n'); return 0;
    }),

    uniq: wrap(async function (a, io, ctx) {
      var p = parseFlags(a), text = '';
      if (p.rest.length) { var abs = pathOrErr(p.rest[0], ctx, io, 'uniq'); if (abs) text = ctx.fs.readText(abs); } else text = io.stdin || '';
      var out = [], prev = null, n = 0;
      lines(text).forEach(function (l) { if (l === prev) n++; else { if (prev !== null) out.push(p.flags.has('c') ? String(n).padStart(7) + ' ' + prev : prev); prev = l; n = 1; } });
      if (prev !== null) out.push(p.flags.has('c') ? String(n).padStart(7) + ' ' + prev : prev);
      if (out.length) io.out(out.join('\n') + '\n'); return 0;
    }),

    true: async function () { return 0; },
    false: async function () { return 1; },
    exit: async function (a) { var n = parseInt(a[0], 10); return isNaN(n) ? 0 : n; },
    clear: async function () { return 0; },
    help: async function (_a, io) { io.out('Built-in commands: ' + Object.keys(COMMANDS).filter(function (c) { return ['true', 'false', 'help'].indexOf(c) === -1; }).concat(['python', 'python3', 'node', 'pip']).sort().join(', ') + '\n'); return 0; },

    python: wrap(async function (a, io, ctx) { return runPythonCmd(a, io, ctx); }),
    python3: wrap(async function (a, io, ctx) { return runPythonCmd(a, io, ctx); }),
    pytest: wrap(async function (a, io, ctx) { return runPythonCmd(['-m', 'pytest'].concat(a), io, ctx); }),

    node: wrap(async function (a, io, ctx) {
      if (!ctx.runJs) { io.err('node: JavaScript is not available here\n'); return 127; }
      var p = parseFlags(a, ['-e']);
      if (p.values['-e'] !== undefined) return ctx.runJs({ code: p.values['-e'] }, io);
      if (!p.rest.length) { io.err('node: interactive mode is not available; give a file or -e "code"\n'); return 1; }
      var abs = pathOrErr(p.rest[0], ctx, io, 'node'); if (!abs) return 1;
      if (!ctx.fs.isFile(abs)) { io.err('node: ' + p.rest[0] + ': no such file\n'); return 1; }
      return ctx.runJs({ code: ctx.fs.readText(abs) }, io);
    }),

    pip: wrap(async function (a, io, ctx) { return pipCmd(a, io, ctx); }),
    pip3: wrap(async function (a, io, ctx) { return pipCmd(a, io, ctx); }),
  };

  function displayPath(abs, ctx) { return abs.indexOf(ctx.cwd + '/') === 0 ? abs.slice(ctx.cwd.length + 1) : abs; }

  function headTail(a, io, ctx, isHead) {
    var n = 10, args = a.slice(), files = [];
    for (var i = 0; i < args.length; i++) {
      if (args[i] === '-n') { n = parseInt(args[++i], 10); }
      else if (/^-\d+$/.test(args[i])) n = parseInt(args[i].slice(1), 10);
      else files.push(args[i]);
    }
    if (isNaN(n) || n < 0) { io.err('invalid line count\n'); return 1; }
    function pick(text) { var l = lines(text); var s = isHead ? l.slice(0, n) : l.slice(Math.max(0, l.length - n)); if (s.length) io.out(s.join('\n') + '\n'); }
    if (!files.length) { pick(io.stdin || ''); return 0; }
    var code = 0;
    files.forEach(function (f, idx) {
      var abs = pathOrErr(f, ctx, io, isHead ? 'head' : 'tail'); if (!abs) { code = 1; return; }
      try { if (files.length > 1) io.out((idx ? '\n' : '') + '==> ' + f + ' <==\n'); pick(ctx.fs.readText(abs)); } catch (_e) { io.err((isHead ? 'head' : 'tail') + ': ' + f + ': no such file\n'); code = 1; }
    });
    return code;
  }

  async function runPythonCmd(a, io, ctx) {
    if (!ctx.runPython) { io.err('python: Python is not available here\n'); return 127; }
    var args = a.slice();
    if (args[0] === '-c') return ctx.runPython({ mode: 'code', code: args[1] || '', args: args.slice(2) }, io);
    if (args[0] === '-m') {
      if (!args[1]) { io.err('python: -m needs a module name\n'); return 2; }
      return ctx.runPython({ mode: 'module', code: args[1], args: args.slice(2) }, io);
    }
    if (!args.length) { io.err('python: interactive mode is not available; give a file or -c "code"\n'); return 1; }
    var abs = pathOrErr(args[0], ctx, io, 'python'); if (!abs) return 1;
    if (!ctx.fs.isFile(abs)) { io.err('python: can\'t open file \'' + args[0] + '\': no such file\n'); return 2; }
    return ctx.runPython({ mode: 'file', file: abs, args: args.slice(1) }, io);
  }

  async function pipCmd(a, io, ctx) {
    if (a[0] !== 'install' && a[0] !== 'list' && a[0] !== '--version') { io.err('pip: only "pip install <package>" and "pip list" are available in the browser sandbox\n'); return 1; }
    if (a[0] === '--version') { io.out('pip (browser sandbox)\n'); return 0; }
    if (!ctx.pipInstall) { io.err('pip: not available here\n'); return 127; }
    var pkgs = a.slice(1).filter(function (x) { return x.charAt(0) !== '-'; });
    if (a[0] === 'list') return ctx.pipInstall([], io, true);
    if (!pkgs.length) { io.err('pip install: give at least one package name\n'); return 1; }
    return ctx.pipInstall(pkgs, io, false);
  }

  // ── Running a command line ─────────────────────────────────────────
  // ctx: { fs, cwd, env, runPython, runJs, pipInstall, maxOutput }
  // Returns { stdout, stderr, exitCode, cwd, truncated }.
  async function runShell(line, ctx) {
    var out = '', errOut = '', truncated = false, budget = ctx.maxOutput || 12000;
    function emit(isErr, text) {
      if (truncated) return;
      var room = budget - out.length - errOut.length;
      if (text.length > room) { text = text.slice(0, Math.max(0, room)); truncated = true; }
      if (isErr) errOut += text; else out += text;
      if (ctx.onOutput && text) ctx.onOutput(isErr ? 'stderr' : 'stdout', text);
    }
    var stmts;
    try { stmts = parse(tokenize(String(line))); }
    catch (e) { emit(true, 'syntax error: ' + e.message + '\n'); return { stdout: out, stderr: errOut, exitCode: 2, cwd: ctx.cwd, truncated: truncated }; }

    var last = 0;
    for (var s = 0; s < stmts.length; s++) {
      var st = stmts[s];
      if (st.joiner === '&&' && last !== 0) continue;
      if (st.joiner === '||' && last === 0) continue;
      last = await runPipeline(st.pipeline, ctx, emit);
      if (ctx.exitRequested) break;
    }
    return { stdout: out, stderr: errOut, exitCode: last, cwd: ctx.cwd, truncated: truncated };
  }

  async function runPipeline(stages, ctx, emit) {
    var input = null, code = 0;
    for (var i = 0; i < stages.length; i++) {
      var stage = stages[i], isLast = i === stages.length - 1, argv;
      try { argv = expandArgs(stage.argv, ctx); } catch (e) { emit(true, e.message + '\n'); return 2; }
      var stdoutBuf = '', stderrToOut = stage.redirs.some(function (r) { return r.op === '2>&1'; });
      var redirOut = stage.redirs.filter(function (r) { return r.fd === 1 && r.op !== '2>&1'; })[0];
      var redirErr = stage.redirs.filter(function (r) { return r.fd === 2 && r.op !== '2>&1'; })[0];
      var errBuf = '';
      var io = {
        stdin: input,
        out: function (t) { if (redirOut || !isLast) stdoutBuf += t; else emit(false, t); },
        err: function (t) {
          if (stderrToOut) { if (redirOut || !isLast) stdoutBuf += t; else emit(false, t); }
          else if (redirErr) errBuf += t; else emit(true, t);
        },
      };
      if (argv.length === 0) { code = 0; input = ''; continue; }
      var name = argv[0], handler = COMMANDS[name];
      if (!Object.prototype.hasOwnProperty.call(COMMANDS, name)) handler = null;
      if (!handler) {
        io.err(name + (UNAVAILABLE[name] ? ': ' + UNAVAILABLE[name] : ': command not found. Type "help" to list the built-in commands.') + '\n');
        code = 127;
      } else {
        code = await handler(argv.slice(1), io, ctx);
        if (name === 'exit') ctx.exitRequested = true;
      }
      var writeRedir = function (r, text) {
        var target = resolvePath(r.target, ctx.cwd);
        if (r.target === '/dev/null') return;
        if (!target) { emit(true, r.target + ': outside the workspace\n'); code = 1; return; }
        try { ctx.fs.writeFile(target, (r.op === '>>' && ctx.fs.isFile(target) ? ctx.fs.readText(target) : '') + text); }
        catch (e) { emit(true, e.message + '\n'); code = 1; }
      };
      if (redirOut) { writeRedir(redirOut, stdoutBuf); input = ''; } else input = stdoutBuf;
      if (redirErr) writeRedir(redirErr, errBuf);
    }
    return code;
  }

  var api = {
    ROOT: ROOT, VFS: VFS, resolvePath: resolvePath, dirname: dirname, basename: basename,
    runShell: runShell, COMMANDS: COMMANDS, tokenize: tokenize, parse: parse, UNAVAILABLE: UNAVAILABLE,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CognitaShell = api;
})(typeof self !== 'undefined' ? self : this);

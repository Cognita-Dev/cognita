#!/usr/bin/env python3
"""Cognita terminal helper.

Runs INSIDE a user's own GitHub Codespace and lets Cognita run shell commands
there on the user's behalf. Uses only the Python standard library.

How it stays safe:
  * Only /exec runs commands, and every /exec call must carry the caller's
    GitHub token. The helper asks GitHub itself ("does this token belong to the
    owner of THIS codespace?") before running anything. A stranger, or Cognita
    with the wrong user's token, is refused.
  * The port is also private by default in Codespaces (GitHub checks the caller
    before traffic ever reaches this file). This check does not rely on that.
  * Commands run with every environment variable containing "TOKEN" removed, so
    the codespace's own GitHub token is never visible to what runs.
  * One command at a time, with a time limit, and output is size-capped.

Nothing here talks to Cognita's servers. It only listens for requests.
"""
import hashlib
import json
import os
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1"
PORT = int(os.environ.get("COGNITA_AGENT_PORT", "8787"))
CODESPACE = os.environ.get("CODESPACE_NAME", "")
GITHUB_API = os.environ.get("COGNITA_GITHUB_API", "https://api.github.com").rstrip("/")

MAX_BODY = 1_000_000          # bytes accepted per request
MAX_COMMAND_CHARS = 20_000
DEFAULT_TIMEOUT = 60          # seconds
MAX_TIMEOUT = 120
MAX_OUT = 30_000              # characters kept per output stream

STATE = {"cwd": os.environ.get("COGNITA_START_DIR") or os.getcwd()}
RUN_LOCK = threading.Lock()
AUTH_CACHE = {}               # sha256(token) -> (ok, expires_at)
AUTH_CACHE_LOCK = threading.Lock()


def _clean_env():
    """The environment commands run in: ours, minus anything that looks like a token."""
    return {k: v for k, v in os.environ.items() if "TOKEN" not in k.upper()}


def _token_from(headers):
    for name in ("X-Cognita-Token", "X-Github-Token"):
        value = headers.get(name)
        if value:
            return value.strip()
    auth = headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return ""


def _verify(token):
    """True only if GitHub says this token's user owns this codespace."""
    if not token or not CODESPACE:
        return False
    key = hashlib.sha256(token.encode()).hexdigest()
    now = time.time()
    with AUTH_CACHE_LOCK:
        hit = AUTH_CACHE.get(key)
        if hit and hit[1] > now:
            return hit[0]
    ok = False
    req = urllib.request.Request(
        GITHUB_API + "/user/codespaces/" + CODESPACE,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "cognita-terminal-agent",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status == 200:
                data = json.loads(resp.read().decode("utf-8", "replace"))
                ok = data.get("name") == CODESPACE
    except (urllib.error.URLError, ValueError, OSError):
        ok = False
    # Remember a yes for a minute (saves a GitHub call per command), a no for 5s.
    with AUTH_CACHE_LOCK:
        AUTH_CACHE[key] = (ok, now + (60 if ok else 5))
        if len(AUTH_CACHE) > 200:
            AUTH_CACHE.clear()
    return ok


def _clip(text):
    if len(text) <= MAX_OUT:
        return text, False
    head = text[: MAX_OUT * 6 // 10]
    tail = text[-(MAX_OUT * 4 // 10):]
    return head + "\n...[output cut]...\n" + tail, True


def run_command(command, cwd, timeout):
    fd, cwd_file = tempfile.mkstemp(prefix="cognita-cwd-")
    os.close(fd)
    # After the user's command, record where the shell ended up, so the next
    # command starts in the same folder (a plain `cd` then sticks).
    wrapper = command + "\n__cognita_rc=$?\npwd > " + shlex.quote(cwd_file) + "\nexit $__cognita_rc\n"
    started = time.time()
    proc = subprocess.Popen(
        ["bash", "-lc", wrapper],
        cwd=cwd,
        env=_clean_env(),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        start_new_session=True,
    )
    timed_out = False
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            out, err = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            out, err = "", ""
    try:
        with open(cwd_file, "r", encoding="utf-8", errors="replace") as fh:
            new_cwd = fh.read().strip()
        if new_cwd and os.path.isdir(new_cwd):
            STATE["cwd"] = new_cwd
    except OSError:
        pass
    finally:
        try:
            os.unlink(cwd_file)
        except OSError:
            pass
    out, cut_out = _clip(out or "")
    err, cut_err = _clip(err or "")
    return {
        "exitCode": None if timed_out else proc.returncode,
        "stdout": out,
        "stderr": err,
        "timedOut": timed_out,
        "truncated": cut_out or cut_err,
        "cwd": STATE["cwd"],
        "durationMs": int((time.time() - started) * 1000),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "CognitaTerminalAgent/" + VERSION

    def log_message(self, fmt, *args):  # never log headers or bodies
        sys.stderr.write("[agent] %s %s\n" % (self.command, self.path.split("?")[0]))

    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            self._send(200, {"ok": True, "agent": "cognita-terminal", "version": VERSION, "codespace": CODESPACE})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/exec":
            self._send(404, {"error": "not found"})
            return
        if not _verify(_token_from(self.headers)):
            self._send(401, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._send(400, {"error": "bad request size"})
            return
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8", "replace"))
        except ValueError:
            self._send(400, {"error": "body must be JSON"})
            return
        command = data.get("command")
        if not isinstance(command, str) or not command.strip() or len(command) > MAX_COMMAND_CHARS:
            self._send(400, {"error": "command must be a non-empty string under %d characters" % MAX_COMMAND_CHARS})
            return
        try:
            timeout = int(data.get("timeoutSeconds") or DEFAULT_TIMEOUT)
        except (TypeError, ValueError):
            timeout = DEFAULT_TIMEOUT
        timeout = max(1, min(timeout, MAX_TIMEOUT))
        cwd = STATE["cwd"]
        if data.get("cwd"):
            wanted = os.path.expanduser(str(data["cwd"]))
            if not os.path.isdir(wanted):
                self._send(400, {"error": "folder does not exist: " + str(data["cwd"])[:200]})
                return
            cwd = wanted
        if not RUN_LOCK.acquire(blocking=False):
            self._send(409, {"error": "another command is still running"})
            return
        try:
            result = run_command(command, cwd, timeout)
        finally:
            RUN_LOCK.release()
        self._send(200, result)


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    sys.stderr.write("[agent] listening on %d for codespace %r\n" % (PORT, CODESPACE))
    server.serve_forever()


if __name__ == "__main__":
    main()

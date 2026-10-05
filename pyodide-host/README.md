# pyodide-host

Self-hosted Pyodide 0.29.5 runtime for the Cognita sandbox iframe, so the iframe never contacts cdn.jsdelivr.net.

The repo holds only the build script (`scripts/build-pyodide-bundle.mjs`) and the Cloudflare Pages headers (`pyodide-host/_headers`). No binaries are committed. The build downloads `pyodide-0.29.5.tar.bz2` from GitHub releases, keeps the core runtime files and a package allowlist (numpy, pandas, matplotlib, scipy, scikit-learn, sympy, openpyxl, pillow, pyyaml, pytest) with their full dependency closure, and writes a pruned `pyodide-lock.json`. openpyxl and et-xmlfile are not in the Pyodide distribution, so two pure-Python wheels are fetched from PyPI (pinned versions, sha256 checked) and added to the lock file.

Output goes to `pyodide-host/dist/v0.29.5/`, plus `pyodide-host/dist/_headers`. The build fails (exit code 1) if any file is 25 MiB or larger, or if there are more than 20000 files, matching Cloudflare Pages limits.

## Cloudflare Pages settings

- Connect the GitHub repo.
- Root directory: repo root
- Build command: `node scripts/build-pyodide-bundle.mjs`
- Build output directory: `pyodide-host/dist`
- Environment variable: `NODE_VERSION=20`
- Custom domain: `pyodide.cognita.com.ng`

Base URL for `loadPyodide({ indexURL })`: `https://pyodide.cognita.com.ng/v0.29.5/`

## Headers

The sandbox iframe has an opaque origin and sends `Origin: null`, so responses carry `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`. Files under `/v0.29.5/` are cached as immutable for one year, so a version bump must use a new path.

## Local build

`node scripts/build-pyodide-bundle.mjs` (Node 18 or newer, no npm install needed).

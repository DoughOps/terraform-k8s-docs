---
name: run-docs-site
description: Build, run, and drive the docs/ static documentation site (the terraform-k8s tech-detail wiki). Use when asked to start/serve the docs site, screenshot a docs page, verify a docs edit renders correctly, or click through its navigation/dark-mode toggle.
---

`docs/` is a plain static HTML/CSS/JS site (no build step, no framework) —
serve it with any static file server, then drive it headlessly via the
`driver.mjs` Playwright REPL in this skill directory
(`docs/.claude/skills/run-docs-site/driver.mjs`).

This is documentation only — it is **not** the primary deliverable of this
repo (that's the Terraform/Ansible infra itself; see `../../../CLAUDE.md`).
`docs/` is what gets deployed in-cluster by `ansible/roles/docs_site` and
mirrored to GitHub Pages by `.github/workflows/sync-docs.yml` — this skill
only covers previewing it locally, not that deployment.

All paths below are relative to `docs/` (i.e. `<repo-root>/docs/`).

## Prerequisites

Already present in a standard dev container — nothing to install if
`python3`, `node`/`npx`, and `google-chrome` are on PATH:

```bash
which python3 npx google-chrome
```

If `google-chrome` is missing, `driver.mjs` can be pointed at Playwright's
own bundled Chromium instead — see Gotchas.

## Setup

The driver's dependency (`playwright`, npm package) is installed once,
locally inside the skill directory (already committed: `package.json` +
`package-lock.json`; `node_modules/` is gitignored):

```bash
cd docs/.claude/skills/run-docs-site
npm install --no-audit --no-fund
```

## Run (agent path)

1. Serve `docs/` as static files (from the `docs/` directory itself — the
   pages use root-relative paths like `assets/style.css`):

```bash
cd docs
nohup python3 -m http.server 8642 --bind 127.0.0.1 > /tmp/docs-server.log 2>&1 &
timeout 15 bash -c 'until curl -sf http://127.0.0.1:8642/index.html >/dev/null; do sleep 0.3; done'
```

2. Drive it with `driver.mjs` — pipe it a newline-delimited command script
   on stdin:

```bash
cd docs/.claude/skills/run-docs-site
node driver.mjs <<'EOF'
nav http://127.0.0.1:8642/index.html
wait-for .sidebar
screenshot index
click a.nav-link[href="network-architecture.html"]
wait-for text=網路架構總覽
screenshot network-architecture
console-errors
quit
EOF
```

Screenshots land in `docs/.claude/skills/run-docs-site/screenshots/<name>.png`
(gitignored — regenerate them, don't commit them).

| command | what it does |
|---|---|
| `nav <url>` | navigate |
| `wait-for <css-selector>` | wait for element visible; `text=...` also works |
| `click <css-selector>` | click an element |
| `screenshot <name>` | save `screenshots/<name>.png` (viewport, not full-page) |
| `console-errors` | print any `console.error`/`pageerror` seen so far, or `ok: no console errors` |
| `eval <js>` | evaluate JS in the page, print the result |
| `quit` | close the browser and exit |

3. Stop the server when done:

```bash
lsof -ti:8642 -sTCP:LISTEN | xargs -r kill
```

## Run (human path)

```bash
cd docs && python3 -m http.server 8642   # → http://localhost:8642/index.html, Ctrl-C to stop
```

## Test

No test suite — `docs/` is static content. "Passing" means: the server
answers, the driver's `nav`/`click`/`wait-for` steps succeed, and
`console-errors` reports clean (aside from the known favicon 404, see
Gotchas).

---

## Gotchas

- **A `console.error` for `favicon.ico` (404) is expected, not a bug.**
  `docs/` has no `favicon.ico`; Chrome auto-requests it on every page load
  and logs the miss to the console. `driver.mjs`'s `console-errors` command
  will report this one issue on a totally healthy page — read the message
  text, don't just check the count is zero.
- **`chromium-cli` is not installed in this container** — `driver.mjs`
  exists specifically to fill that gap. It uses the `playwright` npm
  package with `channel: "chrome"` so it drives the system's already-installed
  `google-chrome` binary instead of downloading Playwright's own Chromium
  (which needs `npx playwright install` and a large download). If
  `google-chrome` isn't available in some other environment, drop the
  `channel: "chrome"` option in `driver.mjs`'s `chromium.launch(...)` call
  and run `npx playwright install chromium` once first.
- **Serve from inside `docs/`, not the repo root.** Pages reference
  `assets/style.css` / `assets/site.js` as root-relative paths; serving
  from the repo root 404s every asset on every page.
- **`text=` locators in `driver.mjs` are substring matches** (`getByText`
  with `exact: false`), same as `chromium-cli`'s convention — a `wait-for
  text=網路架構總覽` matches the breadcrumb, the nav link, and the `<h1>`
  simultaneously; that's fine, `wait-for` only needs the first match visible.

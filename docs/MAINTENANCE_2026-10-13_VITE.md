# Vite security refresh — October 13, 2026

The frontend now requires `vite@^8.3.4`, locked to 8.3.4. Vite 8.3.1 was
affected by the October 6 development-server advisories
[GHSA-rq7h-c2jc-7f22](https://github.com/vitejs/vite/security/advisories/GHSA-rq7h-c2jc-7f22)
and [GHSA-vfpm-58rq-9qcg](https://github.com/vitejs/vite/security/advisories/GHSA-vfpm-58rq-9qcg),
both fixed in 8.3.3. Vite's compatible PostCSS/Nanoid dependencies also refresh.
No runtime application dependencies change.

The isolated maintenance branch starts at remote `main`
`e77190365d459f493eb21359e58baa3012dd171a`, which Vercel production metadata
still reports READY with Node 24. This does not establish Render backend health.
The ESLint support migration is a separate logical commit.

Combined maintenance verification passes on Node 22.23.3 and 24.21.0:
clean installs in all four package trees, lint, types, six deterministic tests,
all package builds, widget verification/copy and built mock MCP smoke. Headless
Chromium renders the emitted widget assets with a synthetic order and expanded
items; no live OMS service or data is used.

Fresh audits report zero findings in root, frontend and MCP trees. Backend full
audit retains four high findings in the development watcher chain:
`braces`, `chokidar`, `nodemon`, and `ts-node-dev`. The underlying
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
affects Braces through 3.0.3 and has no patched version. The backend production-only
audit (`npm audit --omit=dev`) is clear. No override, downgrade or audit suppression
is applied. Keep the advisory on watch; replacement of watcher tooling would be
a separately scoped change.

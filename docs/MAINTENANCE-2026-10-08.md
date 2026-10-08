# Local maintenance — October 8, 2026

Daniel approved the October 5 proposals on October 8. Isolated local branch: `maintenance/2026-10-08-approved`. Base: `10f67071f04acfcaf2f2efa9365a9a56b8541258` from verified GitHub `main`; successful latest Vercel Production deployment record uses the same SHA. Original checkouts were not used as the maintenance base.

Pinned `@modelcontextprotocol/sdk` from the resolved 1.31.0 to exactly 1.32.1, the latest compatible v1 [registry release](https://registry.npmjs.org/@modelcontextprotocol/sdk/1.32.1). No v2 migration or architecture change. The lock diff changes only that package and its root spec.

Root build now installs backend dependencies before backend TypeScript. Frontend, MCP and backend build installs use `--include=dev` so production-mode build environments retain compiler tooling. CI runs `npm ci && npm run build` before tests, removing the pre-install that previously masked the clean Render build gap. Node 22/24 matrix covers the existing Node 22 CI lane and verified Vercel Node 24 frontend.

The untouched clean baseline failed at backend `tsc: command not found`. Final exact root `npm ci && npm run build` passes from absent root/child dependencies and build outputs on Node 22.22.1 and 24.21.0, including `NODE_ENV=production`. Six fixture tests, frontend lint, all typechecks, widget verification/copy, backend/MCP builds, built MCP initialization/tool lookup/widget-resource delivery, and compiled legacy backend health/healthz/invalid-input smokes pass on both majors. Lint retains five existing Fast Refresh warnings. No AI or live MCP backend calls.

Final all-scope npm audit: frontend 0, MCP 0, backend 4 high package entries, all attributable to unpatched [braces GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). No workaround, override or audit exception. Vercel frontend deployment metadata does not establish Render backend health; actual Render deployment SHA/runtime settings remain unverified.

Actions use verified official releases [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) and [setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0). GitHub-hosted `ubuntu-latest` is retained; Node 24 action runtime requires runner 2.327.1 or newer. Existing triggers, permissions, npm cache inputs, LFS and browser-install behavior are preserved. Parsed workflows and `git diff --check` pass. Workflows have not run remotely for these local changes.

No push, PR, merge, deploy, hosting-setting or permission change, live database, email, AI/Ollama call or media capture. Original dirty checkouts and unpublished branches were left untouched. Test inputs and local service smokes are synthetic.

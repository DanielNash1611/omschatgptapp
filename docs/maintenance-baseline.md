# Maintenance baseline

Prepared locally on 2026-09-30 from the assigned production commit on branch
`maintenance/secure-baseline`. Original checkouts and their uncommitted work were
preserved. No push, PR, deployment, live database, private credential, AI call,
email, or user-data transmission was performed. npm registry metadata and
`npm audit` supplied dependency/advisory evidence. CI uses Node 22 and locked
`npm ci`; local checks used Node 22.22.1. Browser QA used cached Chromium with
all external browser requests blocked. Remote deployment behavior is unverified.

Baseline: `1c57a68cb0cb16641290bad9bcc18ba4edaa13e9`.

Refreshed all three lockfiles; upgraded Vite 5 to stable 8.3.1 with React plugin
6.1.1, added the missing frontend lint dependencies, preserved the static widget
preview during library builds, and added Node runtime bounds. Existing React,
Express, OpenAI and MCP contracts remain intact.

Verified clean installs, three fixture-only order regression tests, frontend
lint (zero errors, five pre-existing Fast Refresh warnings), all typechecks,
frontend/widget/backend/MCP builds, copied widget, and built MCP initialization,
tool enumeration, mock lookup and UI-resource delivery. Local browser widget
preview renders without page errors. All three npm audits: zero vulnerabilities.

The root build now verifies the legacy backend as well as the deployed MCP and
widget. Tests exercise mock state only. The MCP service exposes a widget hosted
on Vercel; no assertion is made that Vercel hosts its long-lived MCP process.

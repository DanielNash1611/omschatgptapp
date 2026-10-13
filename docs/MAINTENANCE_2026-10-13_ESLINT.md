# ESLint support migration — October 13, 2026

The frontend moves from unsupported ESLint 9.39.5 to supported ESLint 10.12.0,
with `@eslint/js` 10.0.1, React Hooks 7.1.1 and React Refresh 0.5.7.
The existing TypeScript ESLint 8.71.0 packages already support ESLint 10 and
remain at the same versions. Upstream guidance:
[migration](https://eslint.org/docs/latest/use/migrate-to-10.0.0),
[support policy](https://eslint.org/version-support/).

The previous active rules remain enabled at their existing severities. ESLint 10
adds three recommended rules; they remain off to preserve this migration's
existing policy. `no-shadow-restricted-names` retains the previous
`reportGlobalThis: false` setting. No new React Compiler rules are enabled.
Effective configs were compared for App, entry point, Vite config and JS config.
The entire source lint result stays at zero errors and the same five React Refresh
warnings. Invalid hook ordering, missing effect dependencies, mixed exports,
explicit `any`, debugger statements, unused bindings and valid JSX probes retain
the same diagnostics and exit codes.

Root and frontend engine ranges now require Node 22.13+ or Node 24 to match
ESLint 10's supported runtime families. Clean installs and all deterministic
checks pass on Node 22.23.3 and 24.21.0; see the separate Vite maintenance note
for the validation and remaining backend Braces advisory.

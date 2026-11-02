# November 2 tooling audit follow-up

The frontend and backend minimatch findings are development dependencies. Scoped
overrides select released minimatch 11.0.4 only for ESLint, config-array,
typescript-estree, and nodemon. Their inspected call sites use the retained named
`minimatch` function or `Minimatch` class/match methods. No global override is used.
Remove these overrides when the consumers release compatible dependency ranges.

The unused ts-node-dev dependency was removed. The existing nodemon/ts-node
development command, lint rules, and application behavior are unchanged.

Regression coverage exercises glob options, partial traversal, TypeScript source
selection/build ignores, the advisory's preprocessing bound, and an actual
nodemon restart of a temporary TypeScript fixture. Full lint/type/build/MCP tests
and unsuppressed audits remain release checks. These checks do not measure model
answer accuracy.

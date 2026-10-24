# statechart

This skill is adapted from the statechart skill in upstream pstack
(`https://github.com/cursor/plugins`, `pstack/skills/statechart`), with its
`.mjs` scripts ported to TypeScript.

`vp run verify:statechart-scripts` type-checks the scripts and runs the tests
that need no TLC. Before you report a change, also run the TLC tests, which take
about 6 minutes:

```bash
cd agent/skills/statechart/scripts
TLA2TOOLS=<path to tla2tools.jar> JAVA=java node --test --test-reporter=dot test/statechart.test.ts
```

`.agents/skills/verify-subagent-run/scripts/check` downloads TLC 1.7.4 to
`~/.cache/pi-setup/tla2tools-1.7.4.jar`. All tests pass except three that skip:
one needs TLC from mise, and two need Type 1 fonts.

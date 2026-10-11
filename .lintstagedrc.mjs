// agent-test/ is the agent's template corpus (game scaffolding, template-skills,
// test cases) — vendored runtime fixtures, not maintained OpenGame source, so
// eslint.config.js globally ignores it. lint-staged's plain glob form had no
// matching exclusion, so eslint's own "file ignored by pattern" notice (raised
// as a warning) was failing --max-warnings 0 on every commit touching a .ts/.js
// file under agent-test/ — a config mismatch, not a real lint failure. Filter
// functions keep the two in sync explicitly instead of guessing a glob that does.
const isAgentTest = (f) => f.includes('/agent-test/');

export default {
  '*.{js,jsx,ts,tsx}': (files) => {
    const lintable = files.filter((f) => !isAgentTest(f));
    const cmds = [`prettier --write ${files.map((f) => JSON.stringify(f)).join(' ')}`];
    if (lintable.length) {
      cmds.push(`eslint --fix --max-warnings 0 ${lintable.map((f) => JSON.stringify(f)).join(' ')}`);
    }
    return cmds;
  },
  '*.{json,md}': (files) => `prettier --write ${files.map((f) => JSON.stringify(f)).join(' ')}`,
};

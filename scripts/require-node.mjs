// Test preflight: the repo requires Node >=24 (see package.json "engines.node"
// and .nvmrc). Running the suite on an older Node makes `doctor` (and anything
// that gates on the Node version) fail with noisy, confusing subtest errors.
// Fail fast here with one clear, actionable message instead.
const major = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(major) || major < 24) {
  process.stderr.write(
    `\nTurnkeyAI requires Node >= 24 (you are on ${process.version}).\n` +
      `Run \`nvm use\` (or fnm/nodenv — see .nvmrc / .node-version), then retry.\n\n`,
  );
  process.exit(1);
}

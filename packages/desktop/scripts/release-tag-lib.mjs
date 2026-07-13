const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function buildDesktopReleaseTag(version) {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`Desktop package version must be valid semver, received: ${version}`);
  }
  return `desktop-v${version}`;
}

export function parseDesktopReleaseArgs(args) {
  const result = {
    allowDirty: false,
    help: false,
    push: false,
    remote: "origin",
    skipChecks: false,
  };

  for (const arg of args) {
    if (arg === "--allow-dirty") result.allowDirty = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--push") result.push = true;
    else if (arg === "--skip-checks") result.skipChecks = true;
    else if (arg.startsWith("--remote=")) {
      const remote = arg.slice("--remote=".length);
      if (!REMOTE_NAME_PATTERN.test(remote)) {
        throw new Error("--remote requires a valid git remote name");
      }
      result.remote = remote;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return result;
}

export function parseRemoteTagTarget(output, tag) {
  let directTarget = null;
  for (const line of output.trim().split("\n")) {
    if (!line) continue;
    const [target, ref] = line.split("\t");
    if (!target || !ref) continue;
    if (ref === `refs/tags/${tag}^{}`) return target;
    if (ref === `refs/tags/${tag}`) directTarget = target;
  }
  return directTarget;
}

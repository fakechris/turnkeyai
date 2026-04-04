import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const passthroughArgs = process.argv.slice(2);
const commandArgs = [
  "run",
  "relay:smoke",
  "--",
  "--no-browser-action",
  ...passthroughArgs,
];

try {
  const { stdout, stderr } = await execFile("npm", commandArgs, {
    cwd: process.cwd(),
    maxBuffer: 16 * 1024 * 1024,
  });
  process.stdout.write(stdout);
  if (stderr) {
    process.stderr.write(stderr);
  }
} catch (error) {
  const failure = error as {
    stdout?: string;
    stderr?: string;
    message?: string;
    code?: number | string | null;
  };
  if (failure.stdout) {
    process.stdout.write(failure.stdout);
  }
  if (failure.stderr) {
    process.stderr.write(failure.stderr);
  } else if (failure.message) {
    process.stderr.write(`${failure.message}\n`);
  }
  process.exit(typeof failure.code === "number" ? failure.code : 1);
}

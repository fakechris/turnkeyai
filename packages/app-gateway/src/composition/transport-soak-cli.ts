// CLI shell-out helpers for browser transport soak. The validation route on
// the daemon's HTTP handler shells out to `npm run relay:smoke` or
// `npm run cdp:smoke` to drive real-browser smoke tests; these helpers wrap
// the child-process invocation and the argv construction.
//
// Lifted out of daemon.ts as part of P1.5c. The validation route only needs
// the top-level runBrowserTransportSoakViaCli function; the argv builders are
// exported as well so they can be unit-tested independently.

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type {
  BrowserTransportSoakOptions,
  BrowserTransportSoakResult,
} from "@turnkeyai/qc-runtime/browser-transport-soak";
import { runBrowserTransportSoak } from "@turnkeyai/qc-runtime/browser-transport-soak";

const execFile = promisify(execFileCallback);

export async function runBrowserTransportSoakViaCli(
  options: BrowserTransportSoakOptions = {}
): Promise<BrowserTransportSoakResult> {
  return runBrowserTransportSoak(options, {
    runner: runBrowserTransportSoakSmokeCommand,
  });
}

async function runBrowserTransportSoakSmokeCommand(input: {
  target: "relay" | "direct-cdp";
  timeoutMs: number;
  relayPeerCount: number;
  verifyReconnect: boolean;
  verifyWorkflowLog: boolean;
}): Promise<{
  exitCode: number;
  stdout: string;
  stderr?: string;
  durationMs?: number;
}> {
  const commandArgs =
    input.target === "relay"
      ? buildRelayTransportSoakArgs(
          input.timeoutMs,
          input.relayPeerCount,
          input.verifyReconnect,
          input.verifyWorkflowLog
        )
      : buildDirectCdpTransportSoakArgs(input.timeoutMs, input.verifyReconnect, input.verifyWorkflowLog);
  const runStartedAt = Date.now();
  try {
    const { stdout, stderr } = await execFile("npm", commandArgs, {
      cwd: process.cwd(),
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      exitCode: 0,
      stdout,
      stderr,
      durationMs: Date.now() - runStartedAt,
    };
  } catch (error) {
    const failure = error as {
      code?: string | number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? String(error),
      durationMs: Date.now() - runStartedAt,
    };
  }
}

export function buildRelayTransportSoakArgs(
  timeoutMs: number,
  relayPeerCount: number,
  verifyReconnect: boolean,
  verifyWorkflowLog: boolean
): string[] {
  const args = ["run", "relay:smoke", "--", "--timeout-ms", String(timeoutMs), "--peer-count", String(relayPeerCount)];
  if (verifyReconnect) {
    args.push("--verify-reconnect");
  }
  if (verifyWorkflowLog) {
    args.push("--verify-workflow-log");
  }
  return args;
}

export function buildDirectCdpTransportSoakArgs(
  timeoutMs: number,
  verifyReconnect: boolean,
  verifyWorkflowLog: boolean
): string[] {
  const args = ["run", "cdp:smoke", "--", "--timeout-ms", String(timeoutMs)];
  if (verifyReconnect) {
    args.push("--verify-reconnect");
  }
  if (verifyWorkflowLog) {
    args.push("--verify-workflow-log");
  }
  return args;
}

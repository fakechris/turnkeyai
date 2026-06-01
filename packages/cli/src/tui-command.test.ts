import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runTuiCommand } from "./tui-command";
import type { EnsureDaemonRunningResult } from "./daemon-commands";

describe("tui command", () => {
  it("auto-starts the daemon before launching the TUI", async () => {
    const calls: string[] = [];
    const stdout: string[] = [];

    await runTuiCommand(["mission", "msn.1"], {
      currentDir: "/tmp/cli-dist",
      ensureRunning: async () => {
        calls.push("ensure");
        return {
          kind: "started",
          pid: 42,
          baseUrl: "http://127.0.0.1:4100",
          logFile: "/tmp/daemon.log",
          configFile: "/tmp/config.json",
        };
      },
      spawnEntry: async (entryName, args, currentDir) => {
        calls.push(`spawn:${entryName}:${args.join(",")}:${currentDir}`);
      },
      stdout: { log: (line: string) => stdout.push(line) },
    });

    assert.deepEqual(calls, ["ensure", "spawn:tui:mission,msn.1:/tmp/cli-dist"]);
    assert.match(stdout.join("\n"), /daemon started \(pid 42\) at http:\/\/127\.0\.0\.1:4100/);
  });

  it("skips daemon auto-start when --no-start is passed", async () => {
    let ensured = false;
    const spawned: string[][] = [];

    await runTuiCommand(["--no-start", "exit"], {
      ensureRunning: async () => {
        ensured = true;
        return alreadyRunning();
      },
      spawnEntry: async (_entryName, args) => {
        spawned.push(args);
      },
    });

    assert.equal(ensured, false);
    assert.deepEqual(spawned, [["exit"]]);
  });

  it("does not auto-start for TUI help", async () => {
    let ensured = false;
    const spawned: string[][] = [];
    const stdout: string[] = [];

    await runTuiCommand(["--help"], {
      ensureRunning: async () => {
        ensured = true;
        return alreadyRunning();
      },
      spawnEntry: async (_entryName, args) => {
        spawned.push(args);
      },
      stdout: { log: (line: string) => stdout.push(line) },
    });

    assert.equal(ensured, false);
    assert.deepEqual(spawned, []);
    assert.match(stdout.join("\n"), /turnkeyai tui \[--no-start\]/);
    assert.match(stdout.join("\n"), /Starts the local daemon when needed/);
  });

  it("exits before launching the TUI when daemon startup fails", async () => {
    const stderr: string[] = [];
    let spawned = false;

    await assert.rejects(
      runTuiCommand([], {
        ensureRunning: async () => ({
          kind: "failed-to-start",
          baseUrl: "http://127.0.0.1:4100",
          logFile: "/tmp/daemon.log",
        }),
        spawnEntry: async () => {
          spawned = true;
        },
        stderr: { error: (line: string) => stderr.push(line) },
        exit: (code: number): never => {
          throw new Error(`exit:${code}`);
        },
      }),
      /exit:1/
    );

    assert.equal(spawned, false);
    assert.match(stderr.join("\n"), /daemon failed to become healthy within 10s/);
    assert.match(stderr.join("\n"), /check logs at \/tmp\/daemon\.log/);
  });

  it("exits before launching the TUI when the daemon port is stuck", async () => {
    const stderr: string[] = [];
    let spawned = false;

    await assert.rejects(
      runTuiCommand([], {
        ensureRunning: async () => ({
          kind: "stuck-daemon",
          pid: 99,
          baseUrl: "http://127.0.0.1:4100",
          logFile: "/tmp/daemon.log",
        }),
        spawnEntry: async () => {
          spawned = true;
        },
        stderr: { error: (line: string) => stderr.push(line) },
        exit: (code: number): never => {
          throw new Error(`exit:${code}`);
        },
      }),
      /exit:1/
    );

    assert.equal(spawned, false);
    assert.match(stderr.join("\n"), /pid 99 owns the daemon port/);
    assert.match(stderr.join("\n"), /turnkeyai daemon stop/);
  });
});

function alreadyRunning(): EnsureDaemonRunningResult {
  return {
    kind: "already-running",
    pid: 41,
    baseUrl: "http://127.0.0.1:4100",
    healthy: true,
  };
}

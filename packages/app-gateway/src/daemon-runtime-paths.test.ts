import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ensureDaemonAuthToken,
  ensureDaemonRuntimeDirs,
  getDaemonRuntimePaths,
  isProcessAlive,
  readDaemonRuntimeConfig,
  readPidFile,
  removePidFile,
  resolveDaemonDataDir,
  resolveDaemonPort,
  writeDaemonRuntimeConfig,
  writePidFile,
} from "./daemon-runtime-paths";

describe("daemon-runtime-paths", () => {
  let rootDir: string;
  let savedEnv: Record<string, string | undefined>;

  before(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "turnkeyai-paths-"));
    savedEnv = {
      TURNKEYAI_HOME: process.env.TURNKEYAI_HOME,
      TURNKEYAI_DAEMON_TOKEN: process.env.TURNKEYAI_DAEMON_TOKEN,
      TURNKEYAI_DAEMON_PORT: process.env.TURNKEYAI_DAEMON_PORT,
      TURNKEYAI_DATA_DIR: process.env.TURNKEYAI_DATA_DIR,
    };
    process.env.TURNKEYAI_HOME = rootDir;
    delete process.env.TURNKEYAI_DAEMON_TOKEN;
    delete process.env.TURNKEYAI_DAEMON_PORT;
    delete process.env.TURNKEYAI_DATA_DIR;
  });

  after(() => {
    rmSync(rootDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("derives paths under the configured root", () => {
    const paths = getDaemonRuntimePaths();
    assert.equal(paths.rootDir, rootDir);
    assert.equal(paths.dataDir, path.join(rootDir, "data"));
    assert.equal(paths.configFile, path.join(rootDir, "config.json"));
    assert.equal(paths.pidFile, path.join(rootDir, "daemon.pid"));
    assert.equal(paths.logFile, path.join(rootDir, "logs", "daemon.log"));
  });

  it("ensures directories", () => {
    const paths = getDaemonRuntimePaths();
    ensureDaemonRuntimeDirs(paths);
    assert.ok(existsSync(paths.dataDir));
    assert.ok(existsSync(paths.logsDir));
    assert.ok(existsSync(paths.extensionsDir));
    assert.ok(existsSync(paths.skillsDir));
  });

  it("generates a token on first call and reuses it after", () => {
    const paths = getDaemonRuntimePaths();
    const first = ensureDaemonAuthToken(paths);
    assert.equal(first.generated, true);
    assert.equal(typeof first.token, "string");
    assert.ok(first.token.length >= 32);
    assert.ok(existsSync(paths.configFile));

    const mode = statSync(paths.configFile).mode & 0o777;
    assert.equal(mode, 0o600);

    const config = readDaemonRuntimeConfig(paths);
    assert.equal(config?.token, first.token);

    const second = ensureDaemonAuthToken(paths);
    assert.equal(second.generated, false);
    assert.equal(second.token, first.token);
  });

  it("honors env var override for token", () => {
    process.env.TURNKEYAI_DAEMON_TOKEN = "explicit-env-token";
    const paths = getDaemonRuntimePaths();
    const result = ensureDaemonAuthToken(paths);
    assert.equal(result.generated, false);
    assert.equal(result.token, "explicit-env-token");
    delete process.env.TURNKEYAI_DAEMON_TOKEN;
  });

  it("resolves data dir precedence: env -> config -> default", () => {
    const paths = getDaemonRuntimePaths();
    assert.equal(resolveDaemonDataDir(paths), paths.dataDir);

    writeDaemonRuntimeConfig(paths, {
      port: 5555,
      token: "x",
      transportMode: null,
      dataDir: "/tmp/turnkeyai-custom-data",
      generatedAt: Date.now(),
    });
    assert.equal(resolveDaemonDataDir(paths), "/tmp/turnkeyai-custom-data");

    process.env.TURNKEYAI_DATA_DIR = "/tmp/turnkeyai-env-data";
    assert.equal(resolveDaemonDataDir(paths), "/tmp/turnkeyai-env-data");
    delete process.env.TURNKEYAI_DATA_DIR;
  });

  it("resolves port precedence: env -> config -> default", () => {
    const paths = getDaemonRuntimePaths();
    assert.equal(resolveDaemonPort(paths), 5555);

    process.env.TURNKEYAI_DAEMON_PORT = "4242";
    assert.equal(resolveDaemonPort(paths), 4242);
    delete process.env.TURNKEYAI_DAEMON_PORT;
  });

  it("writes, reads, and removes the pid file", () => {
    const paths = getDaemonRuntimePaths();
    writePidFile(paths, 12345);
    const raw = readFileSync(paths.pidFile, "utf8");
    assert.equal(raw.trim(), "12345");
    assert.equal(readPidFile(paths), 12345);
    removePidFile(paths);
    assert.equal(readPidFile(paths), null);
  });

  it("only removes a pid file for the expected owner when requested", () => {
    const paths = getDaemonRuntimePaths();
    writePidFile(paths, 22222);

    removePidFile(paths, 11111);
    assert.equal(readPidFile(paths), 22222);

    removePidFile(paths, 22222);
    assert.equal(readPidFile(paths), null);
  });

  it("detects live and dead pids", () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(2_000_000_000), false);
  });

  it("returns the persisted token on subsequent calls so auth stays enabled", () => {
    const paths = getDaemonRuntimePaths();
    // Seed a known token via the public writer (mirrors what first-start does).
    const persistedToken = "persisted-token-with-sufficient-length-1234567890";
    writeDaemonRuntimeConfig(paths, {
      port: 4100,
      token: persistedToken,
      transportMode: null,
      dataDir: null,
      generatedAt: Date.now(),
    });
    // Simulate a fresh process by clearing only the env var (config.json
    // still exists). This guards against the regression where a persisted
    // token would not be returned, causing the daemon to start unauthenticated.
    delete process.env.TURNKEYAI_DAEMON_TOKEN;
    const result = ensureDaemonAuthToken(paths);
    assert.equal(result.generated, false);
    assert.equal(result.token, persistedToken);
  });
});

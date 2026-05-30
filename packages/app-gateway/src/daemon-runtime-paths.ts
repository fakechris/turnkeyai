import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface DaemonRuntimePaths {
  rootDir: string;
  dataDir: string;
  logsDir: string;
  logFile: string;
  pidFile: string;
  configFile: string;
  extensionsDir: string;
  skillsDir: string;
}

export interface DaemonRuntimeConfig {
  port: number;
  token: string | null;
  transportMode: "local" | "relay" | "direct-cdp" | null;
  dataDir: string | null;
  generatedAt: number;
}

export const DEFAULT_DAEMON_PORT = 4100;

export function getDaemonRuntimePaths(overrides?: { rootDir?: string }): DaemonRuntimePaths {
  const rootDir =
    overrides?.rootDir?.trim() ||
    process.env.TURNKEYAI_HOME?.trim() ||
    path.join(homedir(), ".turnkeyai");
  return {
    rootDir,
    dataDir: path.join(rootDir, "data"),
    logsDir: path.join(rootDir, "logs"),
    logFile: path.join(rootDir, "logs", "daemon.log"),
    pidFile: path.join(rootDir, "daemon.pid"),
    configFile: path.join(rootDir, "config.json"),
    extensionsDir: path.join(rootDir, "extensions"),
    skillsDir: path.join(rootDir, "skills"),
  };
}

export function ensureDaemonRuntimeDirs(paths: DaemonRuntimePaths): void {
  mkdirSync(paths.rootDir, { recursive: true });
  mkdirSync(paths.dataDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  mkdirSync(paths.extensionsDir, { recursive: true });
  mkdirSync(paths.skillsDir, { recursive: true });
}

export function resolveDaemonDataDir(paths: DaemonRuntimePaths): string {
  const envValue = process.env.TURNKEYAI_DATA_DIR?.trim();
  if (envValue) {
    return path.resolve(envValue);
  }
  const config = readDaemonRuntimeConfig(paths);
  if (config?.dataDir) {
    return path.resolve(config.dataDir);
  }
  return paths.dataDir;
}

export function resolveDaemonPort(paths: DaemonRuntimePaths): number {
  const envValue = process.env.TURNKEYAI_DAEMON_PORT?.trim();
  if (envValue) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const config = readDaemonRuntimeConfig(paths);
  if (config?.port && Number.isFinite(config.port) && config.port > 0) {
    return config.port;
  }
  return DEFAULT_DAEMON_PORT;
}

export function readDaemonRuntimeConfig(paths: DaemonRuntimePaths): DaemonRuntimeConfig | null {
  if (!existsSync(paths.configFile)) {
    return null;
  }
  try {
    const raw = readFileSync(paths.configFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<DaemonRuntimeConfig> & Record<string, unknown>;
    return {
      port: typeof parsed.port === "number" ? parsed.port : DEFAULT_DAEMON_PORT,
      token: typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null,
      transportMode:
        parsed.transportMode === "local" ||
        parsed.transportMode === "relay" ||
        parsed.transportMode === "direct-cdp"
          ? parsed.transportMode
          : null,
      dataDir: typeof parsed.dataDir === "string" && parsed.dataDir.length > 0 ? parsed.dataDir : null,
      generatedAt: typeof parsed.generatedAt === "number" ? parsed.generatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function writeDaemonRuntimeConfig(
  paths: DaemonRuntimePaths,
  config: DaemonRuntimeConfig
): void {
  ensureDaemonRuntimeDirs(paths);
  writeFileSync(paths.configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function ensureDaemonAuthToken(paths: DaemonRuntimePaths): {
  token: string;
  generated: boolean;
  config: DaemonRuntimeConfig;
} {
  const envToken = process.env.TURNKEYAI_DAEMON_TOKEN?.trim();
  if (envToken) {
    const config = readDaemonRuntimeConfig(paths);
    return {
      token: envToken,
      generated: false,
      config: config ?? {
        port: DEFAULT_DAEMON_PORT,
        token: null,
        transportMode: null,
        dataDir: null,
        generatedAt: Date.now(),
      },
    };
  }
  const existing = readDaemonRuntimeConfig(paths);
  if (existing?.token) {
    return { token: existing.token, generated: false, config: existing };
  }
  const token = randomBytes(32).toString("hex");
  const next: DaemonRuntimeConfig = {
    port: existing?.port ?? DEFAULT_DAEMON_PORT,
    token,
    transportMode: existing?.transportMode ?? null,
    dataDir: existing?.dataDir ?? null,
    generatedAt: Date.now(),
  };
  writeDaemonRuntimeConfig(paths, next);
  return { token, generated: true, config: next };
}

export function readPidFile(paths: DaemonRuntimePaths): number | null {
  if (!existsSync(paths.pidFile)) {
    return null;
  }
  try {
    const raw = readFileSync(paths.pidFile, "utf8").trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function writePidFile(paths: DaemonRuntimePaths, pid: number): void {
  ensureDaemonRuntimeDirs(paths);
  writeFileSync(paths.pidFile, String(pid), { mode: 0o600 });
}

export function removePidFile(paths: DaemonRuntimePaths, expectedPid?: number): void {
  try {
    if (!existsSync(paths.pidFile)) {
      return;
    }
    if (expectedPid !== undefined && readPidFile(paths) !== expectedPid) {
      return;
    }
    unlinkSync(paths.pidFile);
  } catch {
    // best-effort cleanup
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

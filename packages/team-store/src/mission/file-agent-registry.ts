import path from "node:path";

import type { Agent, AgentRegistry } from "@turnkeyai/core-types/mission";
import {
  readJsonFile,
  writeJsonFileAtomic,
} from "@turnkeyai/shared-utils/file-store-utils";

interface FileAgentRegistryOptions {
  rootDir: string;
}

/**
 * Agent roster — a single JSON file with the full array.
 *
 * Different shape from the mission/event stores because the agent list
 * is small (single digits), changes infrequently (only when the user
 * connects/disconnects an agent), and is always read as a complete set
 * — there's no per-id read path the dashboard exercises.
 *
 * Bootstrap-demo populates this on first daemon start with the design's
 * fixture agents. K3's Agent Connect will mutate it through a proper
 * put/remove contract.
 */
export class FileAgentRegistry implements AgentRegistry {
  private readonly file: string;

  constructor(options: FileAgentRegistryOptions) {
    this.file = path.join(options.rootDir, "agents.json");
  }

  async list(): Promise<Agent[]> {
    const data = await readJsonFile<{ agents: Agent[] }>(this.file);
    return data?.agents ?? [];
  }

  async replaceAll(agents: Agent[]): Promise<void> {
    await writeJsonFileAtomic(this.file, { agents });
  }
}

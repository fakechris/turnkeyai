import path from "node:path";

import type { BrowserProfile, BrowserProfileOwnerType, BrowserProfileStore } from "@turnkeyai/core-types/team";
import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileBrowserProfileStoreOptions {
  rootDir: string;
}

export class FileBrowserProfileStore implements BrowserProfileStore {
  private readonly rootDir: string;

  constructor(options: FileBrowserProfileStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(profileId: string): Promise<BrowserProfile | null> {
    return readJsonFile<BrowserProfile>(this.filePath(profileId));
  }

  async put(profile: BrowserProfile): Promise<void> {
    await writeJsonFileAtomic(this.filePath(profile.profileId), profile);
  }

  async findByOwner(ownerType: BrowserProfileOwnerType, ownerId: string): Promise<BrowserProfile | null> {
    const profiles = await this.listAll();
    const directMatch = profiles.find((profile) => profile.ownerType === ownerType && profile.ownerId === ownerId);
    if (directMatch) {
      return directMatch;
    }

    const legacyMatch = profiles.find((profile) => {
      const legacyOwnerType = readLegacyString(profile, "scope");
      const legacyOwnerId = readLegacyString(profile, "scopeId");
      return legacyOwnerType === ownerType && legacyOwnerId === ownerId;
    });
    if (!legacyMatch) {
      return null;
    }

    const migrated: BrowserProfile = {
      ...legacyMatch,
      ownerType,
      ownerId,
    };
    await this.put(migrated);
    return migrated;
  }

  private async listAll(): Promise<BrowserProfile[]> {
    const filePaths = await listJsonFiles(this.rootDir);
    const profiles = await Promise.all(filePaths.map((filePath) => readJsonFile<BrowserProfile>(filePath)));
    return profiles.filter((profile): profile is BrowserProfile => profile !== null);
  }

  private filePath(profileId: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(profileId)}.json`);
  }
}

function readLegacyString(profile: BrowserProfile, key: "scope" | "scopeId"): string | null {
  const value = (profile as BrowserProfile & Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const TOOL_RESULT_ARTIFACT_PROTOCOL =
  "turnkeyai.tool_result_artifact.v1" as const;

export interface ToolResultArtifactRecord {
  protocol: typeof TOOL_RESULT_ARTIFACT_PROTOCOL;
  artifactId: string;
  threadId: string;
  runKey: string;
  toolCallId: string;
  toolName: string;
  sizeBytes: number;
  sha256: string;
  createdAt: number;
}

export interface ToolResultArtifactPage {
  record: ToolResultArtifactRecord;
  content: string;
  offsetBytes: number;
  nextOffsetBytes: number;
  eof: boolean;
}

export interface ToolResultArtifactStore {
  put(input: {
    threadId: string;
    runKey: string;
    toolCallId: string;
    toolName: string;
    content: string;
    createdAt: number;
  }): Promise<ToolResultArtifactRecord>;
  read(input: {
    artifactId: string;
    offsetBytes: number;
    limitBytes: number;
  }): Promise<ToolResultArtifactPage | null>;
}

export class FileToolResultArtifactStore implements ToolResultArtifactStore {
  private readonly rootDir: string;

  constructor(input: { rootDir: string }) {
    this.rootDir = input.rootDir;
  }

  async put(input: {
    threadId: string;
    runKey: string;
    toolCallId: string;
    toolName: string;
    content: string;
    createdAt: number;
  }): Promise<ToolResultArtifactRecord> {
    const contentBuffer = Buffer.from(input.content, "utf8");
    const sha256 = createHash("sha256").update(contentBuffer).digest("hex");
    const artifactId = `tool-result-${createHash("sha256")
      .update(
        [
          input.threadId,
          input.runKey,
          input.toolCallId,
          input.toolName,
          sha256,
        ].join("\0"),
      )
      .digest("hex")
      .slice(0, 32)}`;
    const record: ToolResultArtifactRecord = {
      protocol: TOOL_RESULT_ARTIFACT_PROTOCOL,
      artifactId,
      threadId: input.threadId,
      runKey: input.runKey,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      sizeBytes: contentBuffer.length,
      sha256,
      createdAt: input.createdAt,
    };
    await mkdir(this.rootDir, { recursive: true });
    const contentPath = this.contentPath(artifactId);
    const metadataPath = this.metadataPath(artifactId);
    await writeAtomic(contentPath, contentBuffer);
    await writeAtomic(
      metadataPath,
      Buffer.from(JSON.stringify(record, null, 2), "utf8"),
    );
    return record;
  }

  async read(input: {
    artifactId: string;
    offsetBytes: number;
    limitBytes: number;
  }): Promise<ToolResultArtifactPage | null> {
    try {
      const [metadataText, content] = await Promise.all([
        readFile(this.metadataPath(input.artifactId), "utf8"),
        readFile(this.contentPath(input.artifactId)),
      ]);
      const record = JSON.parse(metadataText) as ToolResultArtifactRecord;
      if (
        record.protocol !== TOOL_RESULT_ARTIFACT_PROTOCOL ||
        record.artifactId !== input.artifactId
      ) {
        return null;
      }
      const requestedOffset = clampInteger(
        input.offsetBytes,
        0,
        content.length,
      );
      const offsetBytes = advanceToUtf8Boundary(content, requestedOffset);
      const limitBytes = clampInteger(input.limitBytes, 1, 64 * 1024);
      const requestedEnd = Math.min(content.length, offsetBytes + limitBytes);
      const nextOffsetBytes = retreatToUtf8Boundary(
        content,
        offsetBytes,
        requestedEnd,
      );
      return {
        record,
        content: content.subarray(offsetBytes, nextOffsetBytes).toString("utf8"),
        offsetBytes,
        nextOffsetBytes,
        eof: nextOffsetBytes >= content.length,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private contentPath(artifactId: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(artifactId)}.txt`);
  }

  private metadataPath(artifactId: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(artifactId)}.json`);
  }
}

async function writeAtomic(filePath: string, content: Buffer): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, content);
  await rename(temporaryPath, filePath);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function advanceToUtf8Boundary(content: Buffer, offset: number): number {
  let next = offset;
  while (next < content.length && isUtf8ContinuationByte(content[next]!)) {
    next += 1;
  }
  return next;
}

function retreatToUtf8Boundary(
  content: Buffer,
  start: number,
  end: number,
): number {
  let next = end;
  while (next > start && next < content.length && isUtf8ContinuationByte(content[next]!)) {
    next -= 1;
  }
  if (next === start && start < content.length) {
    next = start + 1;
    while (next < content.length && isUtf8ContinuationByte(content[next]!)) {
      next += 1;
    }
  }
  return next;
}

function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

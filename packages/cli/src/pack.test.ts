import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPackWorkspace, runPackCommand, validatePackWorkspace } from "./pack";

test("pack creator builds a workspace and catalog entry", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-pack-default-"));
  try {
    await createPackWorkspace({
      rootDir,
      packId: "media-pack",
      displayName: "Media Pack",
      domain: "media",
      summary: "Produce media deliverables with explicit review gates.",
      owner: "turnkeyai",
      capabilities: [
        { id: "media-intake", summary: "Normalize the media brief and required assets." },
        { id: "asset-production", summary: "Produce the requested media outputs." },
      ],
      workflows: [
        { id: "brief-intake", summary: "Normalize the request before execution." },
        { id: "quality-gate", summary: "Review the final deliverables before handoff." },
      ],
      force: false,
    });

    const manifest = JSON.parse(await readFile(path.join(rootDir, "packs", "media-pack", "pack.json"), "utf8")) as {
      packId: string;
      domain: string;
      capabilities: Array<{ id: string }>;
      workflows: Array<{ id: string }>;
    };
    const catalog = JSON.parse(await readFile(path.join(rootDir, "packs", "catalog.json"), "utf8")) as {
      packs: Array<{
        packId: string;
        displayName: string;
        domain: string;
        summary: string;
        manifestPath: string;
      }>;
    };

    assert.equal(manifest.packId, "media-pack");
    assert.equal(manifest.domain, "media");
    assert.deepEqual(
      manifest.capabilities.map((section) => section.id),
      ["media-intake", "asset-production"]
    );
    assert.deepEqual(
      manifest.workflows.map((section) => section.id),
      ["brief-intake", "quality-gate"]
    );
    assert.deepEqual(catalog.packs, [
      {
        packId: "media-pack",
        displayName: "Media Pack",
        domain: "media",
        summary: "Produce media deliverables with explicit review gates.",
        manifestPath: "packs/media-pack/pack.json",
      },
    ]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("pack creator parses repeated CLI sections and writes the skeleton", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-pack-cli-"));
  try {
    await runPackCommand([
      "create",
      "--root-dir",
      rootDir,
      "--pack-id",
      "media pack",
      "--display-name",
      "Media Pack",
      "--domain",
      "media",
      "--summary",
      "Scaffold a media pack.",
      "--capability",
      "media-intake:Capture the target media deliverables and source assets.",
      "--capability",
      "delivery-qc:Validate packaging and review readiness.",
      "--workflow",
      "intake:Collect domain inputs and constraints.",
      "--workflow",
      "handoff:Summarize outputs and risks.",
    ]);

    const manifest = JSON.parse(await readFile(path.join(rootDir, "packs", "media-pack", "pack.json"), "utf8")) as {
      packId: string;
      owner: string;
      capabilities: Array<{ id: string }>;
      workflows: Array<{ id: string }>;
    };
    const executionRecipe = await readFile(path.join(rootDir, "packs", "media-pack", "recipes", "execution.md"), "utf8");

    assert.equal(manifest.packId, "media-pack");
    assert.equal(manifest.owner, "turnkeyai");
    assert.deepEqual(
      manifest.capabilities.map((section) => section.id),
      ["media-intake", "delivery-qc"]
    );
    assert.deepEqual(
      manifest.workflows.map((section) => section.id),
      ["intake", "handoff"]
    );
    assert.match(executionRecipe, /`intake` - Collect domain inputs and constraints\./);
    assert.match(executionRecipe, /`handoff` - Summarize outputs and risks\./);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("pack creator rejects overwrite without force", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-pack-overwrite-"));
  try {
    await createPackWorkspace({
      rootDir,
      packId: "media-pack",
      displayName: "Media Pack",
      domain: "media",
      summary: "Initial summary.",
      owner: "turnkeyai",
      capabilities: [{ id: "media-intake", summary: "Normalize the request." }],
      workflows: [{ id: "brief-intake", summary: "Review the inputs." }],
      force: false,
    });

    await assert.rejects(
      () =>
        createPackWorkspace({
          rootDir,
          packId: "media-pack",
          displayName: "Media Pack",
          domain: "media",
          summary: "Updated summary.",
          owner: "turnkeyai",
          capabilities: [{ id: "media-intake", summary: "Normalize the request." }],
          workflows: [{ id: "brief-intake", summary: "Review the inputs." }],
          force: false,
        }),
      /pack already exists: media-pack/
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("pack validate accepts generated packs and rejects missing required files", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-pack-validate-"));
  try {
    await createPackWorkspace({
      rootDir,
      packId: "media-pack",
      displayName: "Media Pack",
      domain: "media",
      summary: "Validation sample.",
      owner: "turnkeyai",
      capabilities: [{ id: "media-intake", summary: "Normalize the request." }],
      workflows: [{ id: "brief-intake", summary: "Review the inputs." }],
      force: false,
    });

    await validatePackWorkspace({ rootDir });

    await unlink(path.join(rootDir, "packs", "media-pack", "recipes", "execution.md"));

    await assert.rejects(
      () => validatePackWorkspace({ rootDir, packId: "media-pack" }),
      /missing required file/
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

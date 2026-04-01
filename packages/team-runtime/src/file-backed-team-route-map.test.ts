import assert from "node:assert/strict";
import test from "node:test";

import type { TeamThread, TeamThreadStore } from "@turnkeyai/core-types/team";

import { FileBackedTeamRouteMap } from "./file-backed-team-route-map";

test("team route map resolves participant bindings and rejects duplicates", async () => {
  let thread: TeamThread = {
    threadId: "thread-1",
    teamId: "team-1",
    teamName: "Demo",
    leadRoleId: "lead",
    roles: [{ roleId: "lead", name: "Lead", seat: "lead", runtime: "local" }],
    participantLinks: [],
    metadataVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  const store: TeamThreadStore = {
    async get(threadId) {
      return threadId === thread.threadId ? thread : null;
    },
    async list() {
      return [thread];
    },
    async create() {
      throw new Error("not used");
    },
    async update(threadId, patch) {
      assert.equal(threadId, thread.threadId);
      thread = {
        ...thread,
        ...(patch.participantLinks ? { participantLinks: patch.participantLinks } : {}),
      };
      return thread;
    },
    async delete() {},
  };

  const routeMap = new FileBackedTeamRouteMap({ teamThreadStore: store });
  await routeMap.attachParticipants("thread-1", [
    {
      channelId: "channel-1",
      userId: "user-1",
      enabled: true,
    },
  ]);

  const resolved = await routeMap.findByExternalActor("channel-1", "user-1");
  assert.equal(resolved?.threadId, "thread-1");

  await assert.rejects(() =>
    routeMap.assertParticipantUniqueness([
      {
        channelId: "channel-1",
        userId: "user-1",
        enabled: true,
      },
    ])
  );

  thread = {
    ...thread,
    participantLinks: [
      {
        channelId: "channel-2",
        userId: "user-2",
        enabled: false,
      },
    ],
  };

  await routeMap.attachParticipants("thread-1", [
    {
      channelId: "channel-2",
      userId: "user-2",
      enabled: true,
    },
    {
      channelId: "channel-2",
      userId: "user-2",
      enabled: true,
    },
  ]);

  assert.equal(thread.participantLinks.length, 1);
  assert.equal(thread.participantLinks[0]?.enabled, true);
});

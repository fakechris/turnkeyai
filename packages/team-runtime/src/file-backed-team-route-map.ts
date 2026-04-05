import type { ParticipantLink, TeamRouteMap, TeamThread, TeamThreadStore, ThreadId } from "@turnkeyai/core-types/team";
import { AsyncMutex } from "@turnkeyai/shared-utils/async-mutex";

export class FileBackedTeamRouteMap implements TeamRouteMap {
  private readonly teamThreadStore: TeamThreadStore;
  private readonly mutationMutex = new AsyncMutex();

  constructor(options: { teamThreadStore: TeamThreadStore }) {
    this.teamThreadStore = options.teamThreadStore;
  }

  async findByExternalActor(channelId: string, userId: string): Promise<TeamThread | null> {
    const threads = await this.teamThreadStore.list();
    return (
      threads.find((thread) =>
        thread.participantLinks.some(
          (link) => link.enabled && link.channelId === channelId && link.userId === userId
        )
      ) ?? null
    );
  }

  async assertParticipantUniqueness(bindings: ParticipantLink[]): Promise<void> {
    const threads = await this.teamThreadStore.list();
    for (const binding of bindings) {
      const conflict = threads.find((thread) =>
        thread.participantLinks.some(
          (link) => link.enabled && link.channelId === binding.channelId && link.userId === binding.userId
        )
      );
      if (conflict) {
        throw new Error(
          `participant already attached: channel=${binding.channelId} user=${binding.userId} thread=${conflict.threadId}`
        );
      }
    }
  }

  async attachParticipants(threadId: ThreadId, bindings: ParticipantLink[]): Promise<void> {
    await this.withMutationLock(async () => {
      const thread = await this.requireThread(threadId);
      const threads = await this.teamThreadStore.list();
      assertNoExternalConflicts(threads, threadId, bindings);

      const nextBindings = [...thread.participantLinks];
      const existingKeys = new Set(
        thread.participantLinks.filter((link) => link.enabled).map(toParticipantKey)
      );

      for (const binding of bindings) {
        const key = toParticipantKey(binding);
        const existingIndex = nextBindings.findIndex((link) => toParticipantKey(link) === key);
        if (existingIndex >= 0) {
          const existing = nextBindings[existingIndex];
          if (existing && !existing.enabled && binding.enabled) {
            nextBindings[existingIndex] = binding;
            existingKeys.add(key);
          }
          continue;
        }

        if (!existingKeys.has(key)) {
          nextBindings.push(binding);
          if (binding.enabled) {
            existingKeys.add(key);
          }
        }
      }

      await this.teamThreadStore.update(threadId, { participantLinks: nextBindings });
    });
  }

  async detachParticipants(threadId: ThreadId, bindings: ParticipantLink[]): Promise<void> {
    await this.withMutationLock(async () => {
      const thread = await this.requireThread(threadId);
      const bindingKeys = new Set(bindings.map(toParticipantKey));
      await this.teamThreadStore.update(threadId, {
        participantLinks: thread.participantLinks.filter((binding) => !bindingKeys.has(toParticipantKey(binding))),
      });
    });
  }

  private async requireThread(threadId: ThreadId): Promise<TeamThread> {
    const thread = await this.teamThreadStore.get(threadId);
    if (!thread) {
      throw new Error(`team thread not found: ${threadId}`);
    }
    return thread;
  }

  private async withMutationLock<T>(work: () => Promise<T>): Promise<T> {
    return this.mutationMutex.run(work);
  }
}

function toParticipantKey(link: ParticipantLink): string {
  return `${link.channelId}::${link.userId}`;
}

function assertNoExternalConflicts(threads: TeamThread[], threadId: ThreadId, bindings: ParticipantLink[]): void {
  for (const binding of bindings) {
    const conflict = threads.find(
      (thread) =>
        thread.threadId !== threadId &&
        thread.participantLinks.some(
          (link) => link.enabled && link.channelId === binding.channelId && link.userId === binding.userId
        )
    );
    if (conflict) {
      throw new Error(
        `participant already attached: channel=${binding.channelId} user=${binding.userId} thread=${conflict.threadId}`
      );
    }
  }
}

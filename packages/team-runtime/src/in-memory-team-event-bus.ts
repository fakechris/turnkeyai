import type { TeamEvent, TeamEventBus, ThreadId } from "@turnkeyai/core-types/team";

export class InMemoryTeamEventBus implements TeamEventBus {
  private readonly events: TeamEvent[] = [];
  private readonly listeners = new Set<(event: TeamEvent) => void | Promise<void>>();
  private readonly maxEvents: number;

  constructor(options?: { maxEvents?: number }) {
    this.maxEvents = options?.maxEvents ?? 500;
  }

  async publish(event: TeamEvent): Promise<void> {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }

    const listeners = [...this.listeners];
    await Promise.all(listeners.map((listener) => listener(event)));
  }

  subscribe(listener: (event: TeamEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async listRecent(threadId?: ThreadId, limit = 50): Promise<TeamEvent[]> {
    const filtered = threadId ? this.events.filter((event) => event.threadId === threadId) : this.events;
    return filtered.slice(-limit);
  }
}

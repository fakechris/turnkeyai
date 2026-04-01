import type { WorkerHandler, WorkerInvocationInput, WorkerRegistry } from "@turnkeyai/core-types/team";

export class DefaultWorkerRegistry implements WorkerRegistry {
  private readonly handlers: WorkerHandler[];

  constructor(handlers: WorkerHandler[]) {
    this.handlers = handlers;
  }

  async selectHandler(input: WorkerInvocationInput): Promise<WorkerHandler | null> {
    const capabilityInspection = input.packet.capabilityInspection;
    const allowedWorkers = new Set(capabilityInspection?.availableWorkers ?? []);
    const hasExplicitAllowlist = Array.isArray(capabilityInspection?.availableWorkers);
    const preferredWorkers = input.packet.preferredWorkerKinds ?? [];
    const sortedHandlers = [
      ...preferredWorkers.flatMap((kind) => this.handlers.filter((handler) => handler.kind === kind)),
      ...this.handlers.filter((handler) => !preferredWorkers.includes(handler.kind)),
    ];

    for (const handler of sortedHandlers) {
      if ((hasExplicitAllowlist && !allowedWorkers.has(handler.kind)) || (allowedWorkers.size > 0 && !allowedWorkers.has(handler.kind))) {
        continue;
      }

      if (await handler.canHandle(input)) {
        return handler;
      }
    }

    return null;
  }
}

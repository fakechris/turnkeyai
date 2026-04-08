import type {
  Clock,
  IdGenerator,
  ReplayStore,
  ScheduleTaskInput,
  ScheduledPromptCapsule,
  ScheduledTaskRecord,
  ScheduledTaskRuntime,
  ScheduledTaskStore,
  TriggeredScheduledTask,
} from "@turnkeyai/core-types/team";
import { normalizeScheduledTaskRecord } from "@turnkeyai/core-types/team";
import { classifyRuntimeError } from "@turnkeyai/qc-runtime/failure-taxonomy";

import type { CoordinationEngine } from "./coordination-engine";

interface DefaultScheduledTaskRuntimeOptions {
  scheduledTaskStore: ScheduledTaskStore;
  coordinationEngine: Pick<CoordinationEngine, "handleScheduledTask">;
  clock: Clock;
  idGenerator: Pick<IdGenerator, "taskId">;
  replayRecorder?: ReplayStore;
}

const CLAIM_LEASE_MS = 60_000;

export class DefaultScheduledTaskRuntime implements ScheduledTaskRuntime {
  private readonly scheduledTaskStore: ScheduledTaskStore;
  private readonly coordinationEngine: Pick<CoordinationEngine, "handleScheduledTask">;
  private readonly clock: Clock;
  private readonly idGenerator: Pick<IdGenerator, "taskId">;
  private readonly replayRecorder: ReplayStore | undefined;

  constructor(options: DefaultScheduledTaskRuntimeOptions) {
    this.scheduledTaskStore = options.scheduledTaskStore;
    this.coordinationEngine = options.coordinationEngine;
    this.clock = options.clock;
    this.idGenerator = options.idGenerator;
    this.replayRecorder = options.replayRecorder;
  }

  async schedule(input: ScheduleTaskInput): Promise<ScheduledTaskRecord> {
    const now = this.clock.now();
    const task = normalizeScheduledTaskRecord({
      taskId: this.idGenerator.taskId(),
      threadId: input.threadId,
      dispatch: {
        targetRoleId: input.targetRoleId,
        sessionTarget: input.sessionTarget ?? "main",
        ...(input.targetWorker ? { targetWorker: input.targetWorker } : {}),
        ...(input.continuity ? { continuity: input.continuity } : {}),
        ...(input.preferredWorkerKinds?.length
          ? { constraints: { preferredWorkerKinds: input.preferredWorkerKinds } }
          : {}),
      },
      capsule: input.capsule,
      schedule: {
        ...input.schedule,
        nextRunAt: computeNextRunAt(input.schedule.expr, input.schedule.tz, now),
      },
      createdAt: now,
      updatedAt: now,
    });
    await this.scheduledTaskStore.put(task);
    return (await this.scheduledTaskStore.get(task.taskId)) ?? task;
  }

  async listByThread(threadId: string): Promise<ScheduledTaskRecord[]> {
    return this.scheduledTaskStore.listByThread(threadId);
  }

  async triggerDue(now = this.clock.now()): Promise<TriggeredScheduledTask[]> {
    const dueTasks = await this.scheduledTaskStore.listDue(now);
    const dispatched: TriggeredScheduledTask[] = [];

    for (const task of dueTasks) {
      const leaseUntil = now + CLAIM_LEASE_MS;
      const claimedTask = await this.scheduledTaskStore.claimDue(task.taskId, task.updatedAt, leaseUntil, {
        expectedVersion: task.version,
      });
      if (!claimedTask) {
        continue;
      }
      const leasedTask = await this.scheduledTaskStore.get(task.taskId);
      if (!leasedTask) {
        continue;
      }

      let failure: ReturnType<typeof classifyRuntimeError> | undefined;
      try {
        await this.coordinationEngine.handleScheduledTask(leasedTask);
      } catch (error) {
        failure = classifyRuntimeError({
          layer: "scheduled",
          error,
          fallbackMessage: "scheduled task dispatch failed",
        });
        console.error(
          `scheduled task dispatch failed for ${leasedTask.taskId}:`,
          error instanceof Error ? error.message : error
        );
      }

      if (failure) {
        await this.recordReplay(leasedTask, now, failure);
        dispatched.push({
          task: leasedTask,
          dispatchedAt: now,
        });
        continue;
      }

      const nextRunAt = computeNextRunAt(leasedTask.schedule.expr, leasedTask.schedule.tz, now);
      const updatedTask = normalizeScheduledTaskRecord({
        ...leasedTask,
        schedule: {
          ...leasedTask.schedule,
          nextRunAt,
        },
        updatedAt: now,
      });
      await this.scheduledTaskStore.put(updatedTask, { expectedVersion: leasedTask.version });
      await this.recordReplay(updatedTask, now);
      dispatched.push({
        task: updatedTask,
        dispatchedAt: now,
      });
    }

    return dispatched;
  }

  private async recordReplay(
    task: ScheduledTaskRecord,
    dispatchedAt: number,
    failure?: ReturnType<typeof classifyRuntimeError>
  ): Promise<void> {
    if (!this.replayRecorder) {
      return;
    }

    const dispatch = getRequiredScheduledDispatch(task);
    const targetWorker = dispatch.targetWorker;
    await this.replayRecorder.record({
      replayId: `${task.taskId}:scheduled`,
      layer: "scheduled",
      status: failure ? "failed" : "completed",
      recordedAt: dispatchedAt,
      threadId: task.threadId,
      taskId: task.taskId,
      roleId: dispatch.targetRoleId,
      ...(targetWorker ? { workerType: targetWorker } : {}),
      summary: failure
        ? failure.message
        : `Scheduled task dispatched to ${dispatch.targetRoleId}${targetWorker ? ` via ${targetWorker}` : ""}.`,
      ...(failure ? { failure } : {}),
      metadata: {
        sessionTarget: dispatch.sessionTarget,
        schedule: task.schedule,
        capsule: task.capsule,
        ...(dispatch.continuity?.context?.recovery ? { recoveryContext: dispatch.continuity.context.recovery } : {}),
      },
    });
  }
}

function getRequiredScheduledDispatch(task: ScheduledTaskRecord): NonNullable<ScheduledTaskRecord["dispatch"]> {
  const normalized = task.dispatch ? task : normalizeScheduledTaskRecord(task);
  if (!normalized.dispatch) {
    throw new Error(`scheduled task is missing canonical dispatch payload: ${task.taskId}`);
  }
  return normalized.dispatch;
}

function computeNextRunAt(expr: string, tz: string, after: number): number {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`unsupported cron expression: ${expr}`);
  }

  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = parts;
  if (
    !minuteField ||
    !hourField ||
    !dayOfMonthField ||
    !monthField ||
    !dayOfWeekField ||
    /[*/,\-]/.test(minuteField) ||
    /[*/,\-]/.test(hourField) ||
    dayOfMonthField !== "*" ||
    monthField !== "*" ||
    /[\/,\-]/.test(dayOfWeekField)
  ) {
    throw new Error(`unsupported cron expression: ${expr}`);
  }

  const minute = Number(minuteField);
  const hour = Number(hourField);
  const dayOfWeek = dayOfWeekField;
  if (
    Number.isNaN(minute) ||
    Number.isNaN(hour) ||
    minute < 0 ||
    minute > 59 ||
    hour < 0 ||
    hour > 23
  ) {
    throw new Error(`unsupported cron expression: ${expr}`);
  }

  const desiredDay = dayOfWeek === "*" ? null : Number(dayOfWeek);
  if (desiredDay != null && (Number.isNaN(desiredDay) || desiredDay < 0 || desiredDay > 6)) {
    throw new Error(`unsupported cron expression: ${expr}`);
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
    weekday: "short",
  });

  for (let candidate = after + 60_000; candidate <= after + 8 * 24 * 60 * 60 * 1000; candidate += 60_000) {
    const partsMap = formatter.formatToParts(new Date(candidate)).reduce<Record<string, string>>((acc, part) => {
      if (part.type !== "literal") {
        acc[part.type] = part.value;
      }
      return acc;
    }, {});
    const candidateMinute = Number(partsMap.minute);
    const candidateHour = Number(partsMap.hour);
    const candidateDay = weekdayToNumber(partsMap.weekday);
    if (
      candidateMinute === minute &&
      candidateHour === hour &&
      (desiredDay == null || candidateDay === desiredDay) &&
      Number(partsMap.second) === 0
    ) {
      return candidate;
    }
  }

  throw new Error(`unable to compute next run for ${expr} in ${tz}`);
}

function weekdayToNumber(input: string | undefined): number {
  switch ((input ?? "").toLowerCase()) {
    case "sun":
      return 0;
    case "mon":
      return 1;
    case "tue":
      return 2;
    case "wed":
      return 3;
    case "thu":
      return 4;
    case "fri":
      return 5;
    case "sat":
      return 6;
    default:
      return -1;
  }
}

export interface WorkerResultNotification {
  notificationId: string;
  ownerScopeId: string;
  sourceScopeId: string;
  sourceVersion: number;
  resultRef: string;
  state: "pending" | "consumed";
  createdAt: number;
  consumedAt?: number;
  consumedByMessageId?: string;
}

export interface WorkerJoinRecord {
  joinId: string;
  ownerScopeId: string;
  sourceScopeId: string;
  state: "waiting" | "satisfied" | "abandoned";
  createdAt: number;
  expiresAt?: number;
  notificationId?: string;
  resolvedAt?: number;
}

export interface WorkerResultInboxStore {
  getNotification(notificationId: string): Promise<WorkerResultNotification | null>;
  putNotification(record: WorkerResultNotification): Promise<WorkerResultNotification>;
  listNotifications(input: {
    ownerScopeId: string;
    state?: WorkerResultNotification["state"];
  }): Promise<WorkerResultNotification[]>;
  consumeNotification(input: {
    notificationId: string;
    consumedAt: number;
    consumedByMessageId: string;
  }): Promise<WorkerResultNotification>;
  getJoin(joinId: string): Promise<WorkerJoinRecord | null>;
  putJoin(record: WorkerJoinRecord): Promise<WorkerJoinRecord>;
  satisfyWaitingJoins(input: {
    sourceScopeId: string;
    notificationId: string;
    resolvedAt: number;
  }): Promise<WorkerJoinRecord[]>;
  abandonExpiredJoins(input: {
    now: number;
    ownerScopeId?: string;
  }): Promise<WorkerJoinRecord[]>;
}

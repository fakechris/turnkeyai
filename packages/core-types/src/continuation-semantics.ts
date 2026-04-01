const CONTINUATION_SIGNAL_PATTERN =
  /\b(continue|resume|pick up|pending|waiting(?: on)?|blocked|blocker|next step|follow(?:-| )?up|remaining|outstanding|unresolved|approval|retry|fallback|inspect|merge|missing|conflict|duplicate|same worker|same browser)\b/i;
const CONTINUATION_BACKLOG_PATTERN =
  /\b(pending|waiting(?: on)?|blocked|blocker|next step|follow(?:-| )?up|remaining|outstanding|unresolved|approval|missing|conflict|duplicate|merge)\b/i;
const CONTINUATION_DIRECTIVE_PATTERN = /\b(continue|resume|pick up|follow(?:-| )?up|same worker|same browser)\b/i;
const CONTINUATION_ACTION_PATTERN = /\b(follow(?:-| )?up|retry|fallback|resume|continue|inspect)\b/i;
const MERGE_CONTINUATION_PATTERN = /\bmerge\b/i;
const MERGE_BLOCKER_PATTERN = /\b(missing|conflict|duplicate|follow(?:-| )?up|blocked|blocker|approval)\b/i;
const WAITING_DEPENDENCY_PATTERN = /\b(waiting on|blocked on|need input from|awaiting)\b/i;
const APPROVAL_PATTERN = /\b(approval|approve|manual|permission|review)\b/i;
const MERGE_PATTERN = /\b(merge|shard|missing|conflict|duplicate|follow(?:-| )?up|blocker)\b/i;

export function hasContinuationSignal(content: string): boolean {
  return CONTINUATION_SIGNAL_PATTERN.test(content);
}

export function hasContinuationBacklogSignal(content: string): boolean {
  return CONTINUATION_BACKLOG_PATTERN.test(content);
}

export function hasContinuationDirectiveSignal(content: string): boolean {
  return CONTINUATION_DIRECTIVE_PATTERN.test(content);
}

export function hasContinuationActionSignal(content: string): boolean {
  return CONTINUATION_ACTION_PATTERN.test(content);
}

export function hasMergeContinuationSignal(content: string): boolean {
  return MERGE_CONTINUATION_PATTERN.test(content) && MERGE_BLOCKER_PATTERN.test(content);
}

export function hasWaitingDependencySignal(content: string): boolean {
  return WAITING_DEPENDENCY_PATTERN.test(content);
}

export function hasApprovalSignal(content: string): boolean {
  return APPROVAL_PATTERN.test(content);
}

export function hasMergeSignal(content: string): boolean {
  return MERGE_PATTERN.test(content);
}

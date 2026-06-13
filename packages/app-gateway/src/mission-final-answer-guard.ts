const LIFECYCLE_STATUS_PATTERNS = [
  /^lead (?:started|finished|completed|picked up|prepared|resumed)(?: (?:this )?(?:turn|task|mission|work|context))?\.?$/i,
  /^lead (?:is |has )?(?:working|thinking|running|idle|waiting)\.?$/i,
  /^lead finished this turn\.?$/i,
  /^lead started working\.?$/i,
  /^lead picked up the task\.?$/i,
  /^lead prepared the task context\.?$/i,
  /^queued the task for [\w.:-]+\.?$/i,
  /^[\w.:-]+ accepted the task\.?$/i,
  /^woke [\w.:-]+ to start work\.?$/i,
  /^mission\.(?:stalled_no_final_answer|incomplete_final_answer|cancelled)\.?$/i,
] as const;

export function isLifecycleStatusText(text: string): boolean {
  const normalized = normalizeLifecycleStatusText(text);
  if (!normalized) return true;
  return LIFECYCLE_STATUS_PATTERNS.some((pattern) => pattern.test(normalized));
}

function normalizeLifecycleStatusText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^[\s"'`*_~-]+|[\s"'`*_~-]+$/g, "")
    .trim();
}

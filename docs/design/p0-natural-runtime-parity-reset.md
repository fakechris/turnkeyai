# Natural Runtime Acceptance Baseline

Updated: 2026-07-13

This document defines the product acceptance baseline for TurnkeyAI's natural
agent runtime. Historical experiments and detailed checkpoints remain available
in Git history; they are not part of the current product documentation.

## Evidence Rule

Progress must be classified before it is claimed.

| Class | Meaning | Supports a capability claim? |
| --- | --- | --- |
| Structural | Code paths, schemas, docs, or deterministic tests exist. | No |
| Visibility | Runtime truth is easier to inspect. | No |
| Capability | A natural end-to-end mission produced a useful result with evidence. | Yes |
| Unknown | Evidence is missing, stale, or only fixture-shaped. | No |

Natural acceptance uses user-like prompts. It must not require hidden markers,
exact answer templates, or instructions that force one implementation path.

## Product Acceptance Areas

### Mission execution

- A user goal remains available through planning, tool use, continuation, and
  final synthesis.
- A completed Mission has one clear terminal result.
- Active, waiting, blocked, failed, and cancelled states remain distinguishable.

### Tool and Agent coordination

- Tool calls and results use typed, matching identifiers.
- Delegated work has a durable lifecycle and cannot disappear silently.
- Parallel work converges through an explicit merge or closeout boundary.

### Context and memory

- Relevant goals, constraints, decisions, and evidence survive long runs.
- Context pressure is handled before required information is discarded.
- Corrected information replaces stale information in subsequent work.

### Approvals and control

- Sensitive actions pause before side effects occur.
- Approval, denial, timeout, and cancellation each produce an inspectable state.
- A denied or expired action cannot be reported as applied.

### Browser execution

- Browser work records the session, target, actions, and resulting evidence.
- Reconnect and recovery behavior is bounded and visible to the user.
- Browser failure produces an actionable closeout instead of silent success.

### Replay and recovery

- Mission Detail presents work in chronological order before the final result.
- Evidence and approvals can be traced back to the action that produced them.
- Interrupted work can be resumed, retried, or closed with an explicit reason.

## Release Gate

A release is ready only when:

1. focused contract tests pass for the changed runtime surface;
2. at least one natural end-to-end Mission covers the changed behavior;
3. failure and cancellation paths leave no hidden active work;
4. the user-visible timeline agrees with persisted runtime state;
5. unsupported or unverified behavior is described honestly.

These checks evaluate TurnkeyAI against its own product contract. External
products and market comparisons are not release criteria.

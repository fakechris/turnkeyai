import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateAgentWorkbenchLedger } from "./agent-workbench-ledger-check";

describe("agent workbench ledger check", () => {
  it("accepts dated checkpoints with direction and all required sections", () => {
    const result = validateAgentWorkbenchLedger(`
# G0

## YYYY-MM-DD HH:mm TZ - Template

Direction: converging | oscillating | blocked | unknown

## 24-Hour Review Rule

Policy text.

## 2026-05-30 22:36 CST - Mission-Level TUI Entry

Direction: converging

Execution Kernel:
- no runtime change

Result Quality:
- no answer synthesis change

Workbench UX:
- terminal entry improved

Browser Reliability:
- no transport change

Acceptance Evidence:
- focused checks passed

Regression Risk:
- formatting risk only
`);

    assert.equal(result.checkpoints, 1);
    assert.deepEqual(result.issues, []);
  });

  it("rejects invalid directions and missing required sections", () => {
    const result = validateAgentWorkbenchLedger(`
# G0

## 2026-05-30 22:36 CST - Bad Checkpoint

Direction: drifting

Execution Kernel:
- changed something

Result Quality:
- unknown
`);

    assert.equal(result.checkpoints, 1);
    assert.deepEqual(
      result.issues.map((issue) => issue.message),
      [
        "invalid Direction 'drifting'",
        "missing or empty Workbench UX section",
        "missing or empty Browser Reliability section",
        "missing or empty Acceptance Evidence section",
        "missing or empty Regression Risk section",
      ]
    );
  });

  it("rejects empty required sections", () => {
    const result = validateAgentWorkbenchLedger(`
# G0

## 2026-05-30 22:36 CST - Empty Evidence

Direction: unknown

Execution Kernel:
- no runtime change

Result Quality:
- no answer synthesis change

Workbench UX:
- terminal entry improved

Browser Reliability:
- no transport change

Acceptance Evidence:

Regression Risk:
- formatting risk only
`);

    assert.equal(result.checkpoints, 1);
    assert.deepEqual(result.issues, [
      {
        checkpoint: "2026-05-30 22:36 CST - Empty Evidence",
        message: "missing or empty Acceptance Evidence section",
      },
    ]);
  });

  it("requires a dated 24-hour review once checkpoints span at least one day", () => {
    const result = validateAgentWorkbenchLedger(`
# G0

## 2026-05-30 09:00 CST - First Checkpoint

Direction: converging

Execution Kernel:
- no runtime change

Result Quality:
- no answer synthesis change

Workbench UX:
- terminal entry improved

Browser Reliability:
- no transport change

Acceptance Evidence:
- focused checks passed

Regression Risk:
- formatting risk only

## 2026-05-31 09:01 CST - Next Checkpoint

Direction: unknown

Execution Kernel:
- no runtime change

Result Quality:
- no answer synthesis change

Workbench UX:
- no UI change

Browser Reliability:
- no transport change

Acceptance Evidence:
- no real acceptance ran

Regression Risk:
- governance risk only
`);

    assert.equal(result.checkpoints, 2);
    assert.deepEqual(result.issues, [
      {
        checkpoint: "ledger",
        message: "missing dated 24-Hour Goal Review within a 24-hour ledger window",
      },
    ]);
  });

  it("rejects stale 24-hour reviews that leave an earlier unreviewed window", () => {
    const result = validateAgentWorkbenchLedger(`
# G0

## 2026-05-30 09:00 CST - First Checkpoint

Direction: converging

Execution Kernel:
- no runtime change

Result Quality:
- no answer synthesis change

Workbench UX:
- terminal entry improved

Browser Reliability:
- no transport change

Acceptance Evidence:
- focused checks passed

Regression Risk:
- formatting risk only

## 2026-05-31 09:30 CST - 24-Hour Goal Review

Direction: oscillating

Repeated Issue Classes:
- execution loops or stuck work: repeated

E2E Trend:
- No better real outcome.

Decision:
- Pause feature PRs and start methodology review.

Methodology Review Trigger:
- Triggered? yes

## 2026-05-31 09:31 CST - Next Checkpoint

Direction: unknown

Execution Kernel:
- no runtime change

Result Quality:
- no answer synthesis change

Workbench UX:
- no UI change

Browser Reliability:
- no transport change

Acceptance Evidence:
- no real acceptance ran

Regression Risk:
- governance risk only
`);

    assert.deepEqual(result.issues, [
      {
        checkpoint: "ledger",
        message: "missing dated 24-Hour Goal Review within a 24-hour ledger window",
      },
    ]);
  });

  it("accepts a dated 24-hour review with the required review sections", () => {
    const result = validateAgentWorkbenchLedger(`
# G0

## 2026-05-30 09:00 CST - First Checkpoint

Direction: converging

Execution Kernel:
- no runtime change

Result Quality:
- no answer synthesis change

Workbench UX:
- terminal entry improved

Browser Reliability:
- no transport change

Acceptance Evidence:
- focused checks passed

Regression Risk:
- formatting risk only

## 2026-05-31 08:59 CST - 24-Hour Goal Review

Direction: converging

Repeated Issue Classes:
- execution loops or stuck work: not repeated
- weak or unsupported final answers: improved in real E2E
- browser/session/transport instability: still watch
- UI state mismatch or missing recovery action: no recurrence
- acceptance environment drift: no recurrence

E2E Trend:
- Real mission acceptance remains green.

Decision:
- Continue feature PRs.

Methodology Review Trigger:
- Triggered? no

## 2026-05-31 09:01 CST - Next Checkpoint

Direction: unknown

Execution Kernel:
- no runtime change

Result Quality:
- no answer synthesis change

Workbench UX:
- no UI change

Browser Reliability:
- no transport change

Acceptance Evidence:
- no real acceptance ran

Regression Risk:
- governance risk only
`);

    assert.equal(result.checkpoints, 3);
    assert.deepEqual(result.issues, []);
  });
});

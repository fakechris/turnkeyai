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
});

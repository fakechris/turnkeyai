import assert from "node:assert/strict";
import test from "node:test";

import { importLegacyTraceFacts } from "./legacy-trace-importer";

test("legacy trace importer is the only runtime-facing detector runner", () => {
  assert.deepEqual(
    importLegacyTraceFacts({
      text: "permission_result: approval_wait_timeout and still pending",
      detectorIds: ["approval_wait_timeout_text", "approval_denied_text"],
    }),
    {
      facts: [
        {
          id: "approval_wait_timeout_text",
          matched: true,
          fact: "approval_wait_timeout",
        },
      ],
    },
  );
});

# Raw CDP Expert Lane Runbook

This runbook defines how agents should use the `direct-cdp` expert lane when the normal browser action schema is too restrictive for real pages.

## When To Use It

Use the raw CDP expert lane when a page failure is caused by browser structure rather than task logic:

- Cross-origin iframes or out-of-process iframe targets.
- Shadow DOM components where selectors must be evaluated inside the attached target.
- Popups, detached targets, or target reconnects that need explicit `Target.*` handling.
- Coordinate-level input that should go through Chrome compositor events.
- Page-specific probes where `Runtime.evaluate`, `DOM.*`, `Page.*`, `Network.*`, or `Input.*` is the clearest primitive.

For simple pages, keep using normal `spawn / send / resume` browser actions. The expert lane is not a thick wrapper replacement; it is the escape hatch when the model needs Chrome's native primitives.

## Agent Flow

1. Start or resume a browser session with `transportMode=direct-cdp`.
2. List targets:

```http
GET /browser-sessions/:browserSessionId/expert/targets?threadId=:threadId
```

3. Attach to the exact Chrome target, not a guessed DOM frame:

```http
POST /browser-sessions/:browserSessionId/expert/attach
{
  "threadId": "thread-1",
  "targetId": "chrome-target-id"
}
```

4. Send raw CDP commands through the returned `expertSessionId`:

```http
POST /browser-sessions/:browserSessionId/expert/send
{
  "threadId": "thread-1",
  "expertSessionId": "session-id",
  "method": "Runtime.evaluate",
  "params": {
    "expression": "document.querySelector('#host').shadowRoot.querySelector('button').textContent",
    "returnByValue": true,
    "awaitPromise": true
  },
  "timeoutMs": 5000
}
```

5. Drain target events when diagnosing detach, popup, dialog, or lifecycle issues:

```http
GET /browser-sessions/:browserSessionId/expert/events?threadId=:threadId&expertSessionId=:expertSessionId&limit=50
```

6. Detach when finished:

```http
POST /browser-sessions/:browserSessionId/expert/detach
{
  "threadId": "thread-1",
  "expertSessionId": "session-id"
}
```

## Failure Buckets

Replay/operator/validation surfaces should preserve these raw CDP buckets:

- `target_not_found`: expected Chrome target was not discoverable.
- `attach_failed`: `Target.attachToTarget` failed or did not return a session.
- `expert_session_detached`: the attached expert session disappeared before completion.
- `cdp_command_timeout`: Chrome did not return a command response within the timeout.
- `browser_cdp_unavailable`: the direct CDP endpoint is unavailable.
- `protocol_mode_mismatch`: the command used the wrong session/protocol mode.

These buckets are intentionally concrete. They should tell the next operator or agent whether to relist targets, reattach, reconnect the browser, retry with a different timeout, or fix the CDP session mode.

## Recovery Policy

The direct-CDP adapter applies conservative runtime recovery:

- Attach failures relist Chrome targets once. If the target disappeared, the failure is reported as `target_not_found`; if the target is still present, it is reported as `attach_failed`.
- In-flight attached commands that fail because the expert session detached are reattached to the same target and retried once. A successful retry returns the replacement `expertSessionId`.
- Command timeouts are not automatically retried. The command may already have executed in Chrome, so `cdp_command_timeout` is surfaced to replay/operator for an explicit retry or alternate action.
- Browser disconnects and connection failures clear root/expert session state and surface `browser_cdp_unavailable`.

## Relay Boundary

`relay` remains the extension-backed high-level browser transport. It can run the normal browser action contract and long-chain relay smoke, but it does not currently expose same-level raw Chrome target attach/send/detach.

When a task requires raw target attach for cross-origin iframe, popup, or Chrome target lifecycle control:

- Prefer `direct-cdp` expert lane.
- Record the fallback as direct-CDP-required, not as an ambiguous browser failure.
- Do not open an arbitrary Chrome debugging port to the agent. The daemon owns the CDP endpoint and exposes only the authenticated browser session expert routes.

The boundary is a product contract: relay is not silently pretending to support raw target control, and direct-cdp is the explicit low-level lane for complex Chrome primitives.

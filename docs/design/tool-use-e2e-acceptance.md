# Tool-Use E2E Acceptance

## Purpose

This acceptance flow validates the native LLM tool-use path before high-risk releases. It is intentionally separate from the normal unit suite so it can be run at key milestones without making every local test require a browser.

## Mock Provider Path

Run:

```bash
npm run tooluse:e2e
```

The mock path uses a scripted provider-native tool call and verifies:

- tool schemas include session, permission, memory, and task tools
- the model emits `sessions_spawn`
- browser side-effect governance emits `permission.query`, waits for approval, applies it, and then continues the same tool call
- the worker receives the original `toolCallId`
- the second LLM round receives a real `role=tool` result message
- native assistant/tool messages and `toolProgress` are persisted

## Browser Transport Path

Run:

```bash
npm run tooluse:e2e -- --with-browser --cdp-timeout-ms 45000
```

The browser path first runs the mock provider acceptance above, then runs the direct-CDP smoke suite. This validates the tool-use runtime contract and the real browser transport in the same release gate.

If the daemon requires auth, export `TURNKEYAI_DAEMON_TOKEN` or rely on the token in `~/.turnkeyai/config.json` as supported by `npm run cdp:smoke`.

## When To Run

Run the mock path for every tool-runtime or provider-adapter PR. Run the browser path before merging changes that affect browser worker execution, permission gating, direct-CDP transport, or release candidates.

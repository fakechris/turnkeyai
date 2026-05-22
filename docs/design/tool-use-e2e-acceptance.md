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

## Real LLM Path

Run:

```bash
npm run tooluse:e2e -- --real-llm --model-catalog models.local.json
```

The real LLM path runs the mock acceptance first, then calls the configured
model through the provider-native tool schema. It verifies:

- the model emits `sessions_spawn` instead of answering directly
- the lead receives a real `role=tool` result
- the final answer contains the release marker from tool evidence

The command needs a configured model catalog and the referenced provider key
environment variable. It is intentionally not part of the normal unit suite.

## Real LLM + Browser Path

Run:

```bash
npm run tooluse:e2e -- --real-llm --with-browser --model-catalog models.local.json --cdp-timeout-ms 45000
```

The browser path first runs the mock provider acceptance above, then asks the
real configured model to delegate to a browser sub-agent. It verifies:

- the lead model emits `sessions_spawn(browser)`
- the browser sub-agent uses its private browser tool surface
- child transcript entries are persisted
- the final answer includes the browser-observed release marker
- direct-CDP browser smoke passes in the same release gate

If the daemon requires auth, export `TURNKEYAI_DAEMON_TOKEN` or rely on the token in `~/.turnkeyai/config.json` as supported by `npm run cdp:smoke`.

## When To Run

Run the mock path for every tool-runtime or provider-adapter PR. Run the real
LLM path before high-risk tool runtime changes. Run the real LLM + browser path
before merging changes that affect browser worker execution, permission gating,
direct-CDP transport, replay, cancellation, or release candidates.

Latest local acceptance on 2026-05-22:

- `npm run tooluse:e2e`
- `npm run tooluse:e2e -- --real-llm --model-catalog models.local.json`
- `npm run tooluse:e2e -- --real-llm --with-browser --model-catalog models.local.json --cdp-timeout-ms 45000`

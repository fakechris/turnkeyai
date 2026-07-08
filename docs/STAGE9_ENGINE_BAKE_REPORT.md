# Stage 9 Engine Bake Report

Date: 2026-07-07
Branch: `feat/stage9-engine-default`

## Current Status

Engine is the default runtime. The legacy inline path is now an escape hatch, not
an equivalence oracle for engine-only bake fixes.

The current local checkpoint fixes the deterministic red items from the first
bake audit:

- Typecheck error in terminal closeout assembly is resolved.
- React-engine terminal closeout handoff regression is resolved.
- The four non-parity `llm-response-generator` failures are resolved.
- Slow-source continuation lookup is constrained to the correct `explore`
  session family instead of looping on stale browser sessions.

## Known Inline Divergence

The full `llm-response-generator` suite now has 32 explicit skipped cutover
parity tests. These are known Stage 9 divergences caused by engine-only
hardening. They are not backported to inline.

The skipped group covers:

- completed closeout synthesis and completed closeout repair parity;
- missing browser evidence, browser recovery visibility, and browser failure
  bucket parity;
- approval repair and permission progress parity;
- independent stream continuation parity;
- oversized session evidence compaction parity;
- natural-finish and final T2 continuation parity.

These skips should be deleted with the inline path in Task 4. Until then, they
make the divergence explicit while keeping the deterministic engine/default
suite runnable.

## Harness Review

Reviewed harness relaxations from the bake regression commit:

- OpenRouter search-support pattern widening: accepted. It still requires
  OpenRouter plus search/web_search support and preserves the negative checks for
  Together and Fireworks. This handles natural answer phrasing, not unsupported
  claims.
- `natural-memory-recall` remains natural seeded. The `memory-recall`
  contract scenario uses `markerMode: "contract"` to stabilize the older
  contract row; it does not weaken the natural row.
- Memory recall `maxToolResults` 5 to 6: accepted as bounded tool-use slack for
  one extra memory inspection step. The scenario still requires native memory
  evidence and still rejects missing recall.

## Gate Results

Deterministic gates completed in this environment:

- `npm run typecheck`: pass.
- `npx -y -p node@24 node --test --import tsx packages/role-runtime/src/react-engine/*.test.ts`: pass, 352 / 352.
- `npx -y -p node@24 node --test --import tsx packages/role-runtime/src/llm-response-generator.test.ts`: pass, 247 pass / 32 skip / 0 fail.
- Focused slow-source continuation regression set: pass, 7 / 7.
- Focused non-parity `llm-response-generator` regression set: pass, 6 / 6.
- `npx -y -p node@24 node --test --import tsx packages/agent-core/src/*.test.ts`: pass, 53 / 53.
- `npm run parity:inline`: pass, 279 / 279.
- `npm run parity:engine`: pass, 279 / 279, all 14 chunks completed.
- `git diff --check`: pass.

Real LLM bake gates are not completed in this environment because no model
catalog is available. Attempted command:

```bash
npm run mission:e2e -- --natural --natural-scenario natural-timeout-followup-continuation --json /tmp/natural-timeout-followup-after-fix.json
```

Result:

```text
Error: mission E2E requires --model-catalog, TURNKEYAI_MODEL_CATALOG, models.local.json, or models.json
```

Required external bake gates before declaring the branch fully baked:

```bash
npm run mission:e2e:natural:core
npm run soak:ci
npm run acceptance:real
```

## Remaining Landing Line

Do not spend time restoring inline parity. The next structural step after the
real LLM bake passes is Task 4: delete the inline runtime path and retire the
cutover parity block.

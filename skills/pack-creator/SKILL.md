---
name: pack-creator
description: Create or update a reusable domain pack under packs/. Use when the task is to define a new pack, scaffold a pack from a domain brief, refine a generated pack into a real domain contract, or validate that a pack can be reused for another domain example.
---

# Pack Creator

Use this skill when a new domain should become a reusable pack instead of ad hoc instructions.

## Outputs

- a pack directory under `packs/<pack-id>/`
- a manifest at `packs/<pack-id>/pack.json`
- operating guidance in `PACK.md`
- reusable intake/execution recipes
- domain references and one concrete example request

## Workflow

1. Normalize the domain brief.
2. Scaffold the pack with `turnkeyai pack create`.
3. Refine the generated files into domain-specific contracts.
4. Validate the pack with `turnkeyai pack validate`.
5. Prove the pack can handle one realistic example without creator-only context.

## Domain Intake

Capture:
- domain boundary
- intended users or operators
- artifact types the pack owns
- hard constraints, policy boundaries, and non-goals
- one realistic example request

Stop if the domain cannot be described with explicit artifacts and acceptance criteria.

## Scaffolding

Run:

```bash
turnkeyai pack create \
  --pack-id <id> \
  --display-name "<name>" \
  --domain <domain> \
  --summary "<summary>" \
  --capability "<id:summary>" \
  --workflow "<id:summary>"
```

Use repeated `--capability` and `--workflow` flags when the defaults are too generic.

## Refinement

After generation, replace placeholder language with domain-specific content:
- `PACK.md`: boundary, when to use, operating contract, acceptance
- `recipes/intake.md`: inputs, checklist, required outputs
- `recipes/execution.md`: workflow order, execution rules, handoff fields
- `references/domain-model.md`: actors, artifact types, constraints, review rubric
- `examples/request.md`: one realistic request

Do not leave the pack as a generic skeleton.

## Validation

Run:

```bash
turnkeyai pack validate --pack-id <id>
```

The validation pass should be followed by one manual example check:
- restate the example request
- map it to the pack workflows
- confirm the pack files contain enough information to execute and hand off the work

## References

- For the pack file contract and CLI behavior, read `references/pack-contract.md`.
- For a concrete example of a refined pack, read `references/media-pack-pattern.md`.

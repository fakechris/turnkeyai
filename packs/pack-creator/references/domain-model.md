# Pack Creator Domain Model

## Pack Schema

- `pack.json`: machine-readable manifest for id, domain, summary, owner, capabilities, and workflows
- `PACK.md`: human-readable operating contract and boundary
- `recipes/`: repeatable intake and execution paths
- `references/`: domain vocabulary, schemas, and review rules
- `examples/`: at least one concrete request that proves the pack is usable

## Creation Sequence

1. Normalize the domain brief.
2. Generate the skeleton with `turnkeyai pack create`.
3. Refine the generated files for domain specifics.
4. Validate against one concrete request.
5. Update the pack until the example can run without creator-only context.

## Quality Bar

- Clear domain boundary
- Stable capability map
- Reusable workflows
- Explicit acceptance criteria
- No hidden assumptions from the first example

## Domain Notes

- Use `media-pack` as the reference example for how a generated skeleton should mature into a real pack.
- New packs should prefer stable artifact and constraint language over tool-specific jargon in the top-level contract.

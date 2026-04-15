# Pack Creator Execution

## Workflow Order

1. `domain-intake` - Normalize domain boundaries, users, artifacts, and quality bars before scaffolding.
2. `skeleton-generation` - Create the pack manifest, operating contract, starter recipes, and domain references.
3. `example-pack-validation` - Use one concrete pack request to verify the pack is reusable outside the initial example.
4. `handoff` - Summarize what the new pack covers, what remains domain-specific, and what to extend next.

## Execution Rules

- Start from `turnkeyai pack create` so every new pack follows the same file contract and catalog update path.
- Refine generated placeholders into domain-specific language before claiming the pack is usable.
- Validate with one realistic example request and patch the pack where the example exposes ambiguity.
- Keep the pack generic enough to reuse in a new domain without leaking details from the first example.

## Required Handoff Fields

- normalized pack brief
- generated pack path
- manifest and file changes
- validation example and result
- remaining gaps
- extension ideas

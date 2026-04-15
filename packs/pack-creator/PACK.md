# Pack Creator

## Summary

Scaffold, validate, and harden new domain packs from reusable contracts, recipes, and examples.

## Domain

- domain: `meta-tooling`
- owner: `turnkeyai`
- creator: `turnkeyai pack create`

## Capability Map

- `domain-intake`: Capture the target domain, deliverables, constraints, and acceptance contract for a new pack.
- `pack-scaffolding`: Generate a new pack skeleton with manifest, recipes, references, and example requests.
- `contract-hardening`: Review the pack structure, naming, and workflows so another agent can reuse it safely.
- `example-validation`: Validate the generated pack against at least one concrete domain example and close any gaps.

## Workflow Map

- `domain-intake`: Normalize domain boundaries, users, artifacts, and quality bars before scaffolding.
- `skeleton-generation`: Create the pack manifest, operating contract, starter recipes, and domain references.
- `example-pack-validation`: Use one concrete pack request to verify the pack is reusable outside the initial example.
- `handoff`: Summarize what the new pack covers, what remains domain-specific, and what to extend next.

## Use This Pack When

- A new domain is repeating often enough that it should become a reusable pack instead of ad hoc instructions.
- The domain can be described with a stable boundary, artifact types, and acceptance criteria.
- You want a generated skeleton plus one validated example that proves the pack is reusable.

## Do Not Use This Pack When

- The request is a one-off workflow that has not stabilized into repeatable capabilities or handoff rules.
- The team cannot yet identify what artifacts, constraints, or users the future pack should own.
- The work requires inventing a new runtime feature instead of packaging an existing domain contract.

## Operating Contract

1. Start from a domain brief with pack boundary, target users, artifacts, and review bar.
2. Generate the initial skeleton with `turnkeyai pack create`, then refine the pack with domain-specific details.
3. Validate the pack against at least one concrete example, not just the abstract schema.
4. End with a handoff that states what the pack now covers, what remains out of scope, and what to extend next.

## Acceptance

- The new pack has a manifest, recipes, references, example request, and catalog entry.
- Another agent can use the pack to execute one realistic request without hidden creator context.
- The example validation closes the main gaps discovered during the first generated draft.

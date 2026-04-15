# Media Pack

## Summary

Produce media assets and delivery packages across image, video, audio, and adaptation workflows.

## Domain

- domain: `media`
- owner: `turnkeyai`
- creator: `turnkeyai pack create`

## Capability Map

- `media-intake`: Turn a media request into an executable brief, asset inventory, and acceptance contract.
- `asset-production`: Produce the requested media assets with tool choices, source tracking, and output targets.
- `format-adaptation`: Adapt source assets into derived sizes, aspect ratios, cuts, and delivery formats.
- `delivery-qc`: Review media outputs for quality, compliance, packaging, and handoff readiness.

## Workflow Map

- `brief-intake`: Normalize goals, audience, deliverables, references, and policy constraints.
- `asset-plan`: Choose tools, source assets, shot lists, and production order before execution.
- `production`: Create the primary media outputs and intermediate artifacts.
- `quality-gate`: Check technical quality, policy compliance, and packaging before handoff.

## Use This Pack When

- The request needs one or more explicit media deliverables such as image, video, audio, or resized variants.
- The caller can define output formats, channels, or acceptance criteria before production starts.
- Source assets, references, or brand constraints need to stay traceable through editing or generation.

## Do Not Use This Pack When

- The work is primarily owned by another domain pack and media is only an incidental by-product.
- The request is still exploratory and not ready to be normalized into a concrete deliverable matrix.
- The team needs bespoke live production planning, vendor management, or legal review outside pack scope.

## Operating Contract

1. Start from a normalized brief with modality, target surfaces, and explicit acceptance criteria.
2. Track source provenance, tool choices, and irreversible transforms for every deliverable.
3. Keep masters and derived outputs separate so later packs can reuse the highest-fidelity artifact.
4. End with a technical and policy review that marks every artifact as confirmed, inferred, or blocked.

## Acceptance

- Every media request produces a brief, asset inventory, production plan, and artifact manifest.
- Each delivered file can be traced back to its prompt, source asset, or transform chain.
- Output packaging is concrete enough for another agent to publish, adapt, or review without hidden context.

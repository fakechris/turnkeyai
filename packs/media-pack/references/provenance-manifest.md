# Media Pack Provenance Manifest

Every media handoff should capture:

- `artifactId`
- `artifactType`
- `sourceInputs`
- `productionPath`: generation, edit, adaptation, or mixed
- `toolsUsed`
- `modelOrSoftwareVersion`
- `transformSteps`
- `outputFormat`
- `reviewStatus`
- `knownRisks`

## Rules

- Keep provenance at artifact level, not only at package level.
- Record irreversible transforms in order.
- Keep prompts and source asset references together when generation is involved.
- Mark guessed or reconstructed metadata as inferred, not confirmed.

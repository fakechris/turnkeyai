# Pack Contract

Every pack lives under `packs/<pack-id>/` and must contain:

- `pack.json`
- `PACK.md`
- `recipes/intake.md`
- `recipes/execution.md`
- `references/domain-model.md`
- `examples/request.md`

## Manifest Fields

- `schemaVersion`
- `packId`
- `displayName`
- `domain`
- `summary`
- `owner`
- `creator`
- `capabilities`
- `workflows`

## Quality Bar

A pack is only ready when:
- the domain boundary is explicit
- the artifacts and constraints are named
- the recipes tell another agent what to collect and what to hand off
- one example request can be explained using only the pack files

## CLI

Scaffold:

```bash
turnkeyai pack create --pack-id <id> --display-name "<name>" --domain <domain> --summary "<summary>"
```

Validate:

```bash
turnkeyai pack validate --pack-id <id>
```

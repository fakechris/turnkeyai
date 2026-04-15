# Media Pack Domain Model

## Pack Manifest

- packId: stable machine id for the pack
- displayName: human-facing label
- domain: domain boundary for the pack
- capabilities: repeatable domain abilities
- workflows: repeatable execution paths

## Actors

- request owner
- media operator
- reviewer or publisher

## Artifact Types

- source inputs: brand assets, recordings, images, copy, reference links
- masters: highest-fidelity outputs before adaptation
- derived outputs: crops, cuts, resized exports, alternate codecs
- review evidence: qc notes, issue lists, acceptance signoff

## Constraint Types

- technical: dimensions, duration, fps, bitrate, codec, file size
- rights: usage scope, licensing, ownership, attribution
- policy: brand rules, moderation, safety, disclosure
- delivery: naming, packaging, destination channel, publish window

## Review Rubric

- Does each artifact match the requested format and surface constraints?
- Can another agent trace the artifact back to the source asset or generation step?
- Are edits, generations, and unsupported assumptions clearly separated?
- Is the delivery package complete enough for publish or downstream adaptation?

## Domain Notes

- This pack covers generation, editing, adaptation, and packaging of media assets.
- It does not cover offline vendor management, live production logistics, or legal approval workflows.

# Documentation

The public documents describe the accepted `0.1.0` contract. Status banners
identify work that is designed but not implemented. Repository plans are the
source of truth for implementation progress.

## Canonical documents

| Document                                    | Owns                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| [README](../README.md)                      | Product summary, release status, and first routes into the docs              |
| [Product requirements](PRODUCT.md)          | User jobs, release scope, non-goals, and success criteria                    |
| [CLI contract](CLI.md)                      | Commands, flags, logical results, errors, channels, and exit behavior        |
| [Domain language](../CONTEXT.md)            | Canonical names for serving, review, feedback, and private state             |
| [Architecture](../ARCHITECTURE.md)          | Implemented system shape, accepted additions, flows, ownership, and code map |
| [Threat model](THREAT_MODEL.md)             | Assets, trust boundaries, required controls, and residual risks              |
| [Security evidence](SECURITY_VALIDATION.md) | Implemented and pending validation evidence plus enforced resource bounds    |
| [Install and remove](INSTALL.md)            | Consumer installation, upgrade, recovery, and removal operations             |
| [Interoperability](INTEROPERABILITY.md)     | Browser-neutral URL handoff and externally supplied controller workflows     |
| [Decision index](decisions/README.md)       | ADR status, current applicability, and relationships                         |

The [browser-origin evidence](validation/browser-origin.md) records why every
live surface receives a fresh `.localhost` authority.

## Repository-only maintenance documents

The npm package excludes work plans. In the repository, use:

- [the implementation plan](https://github.com/sjunepark/htmlview/blob/main/PLAN.md)
  for current milestones, validation, blockers, and the next action;
- [the Effect v4 plan](https://github.com/sjunepark/htmlview/blob/main/docs/plans/effect-v4-adoption.md)
  for the remaining CLI/logging migration; and
- [the annotation MVP plan](https://github.com/sjunepark/htmlview/blob/main/docs/plans/annotation-mvp.md)
  for implementation sequencing and completion gates.

## Ownership rules

- Put exact public syntax and data shapes only in the CLI contract.
- Put product intent in Product, security claims in the Threat Model, and test
  evidence in Security Validation.
- Keep Architecture about stable responsibilities and flows; keep rationale in
  ADRs and mutable implementation sequencing in plans.
- Preserve accepted decision history. Record later applicability through ADR
  relationship metadata and concise applicability notes.
- Update current state in place. Do not copy progress logs into public docs.

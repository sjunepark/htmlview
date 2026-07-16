# Architecture decision index

ADRs record why a durable choice was made; they are not the current product or
CLI specification. Later decisions retain the earlier record and declare
relationships through metadata or current-applicability notes; this index
summarizes the complete graph. Amendments may strengthen an accepted constraint
in place when the original boundary remains intact.

| ADR                                                           | Status               | Current scope                                                                         | Relationships                                   |
| ------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------- |
| [0001](0001-separate-serving-from-browser-control.md)         | Accepted             | Browser-neutral raw serving remains the core boundary                                 | Extended by 0008                                |
| [0002](0002-per-user-loopback-supervisor.md)                  | Accepted             | One per-user supervisor owns live raw sessions                                        | Related to 0006 and extended by 0008            |
| [0003](0003-adopt-an-axi-output-contract.md)                  | Partially superseded | TOON/JSON domain values, minimal schemas, and content-first home remain active        | Native CLI behavior superseded by 0009          |
| [0004](0004-treat-the-serving-root-as-a-disclosure-grant.md)  | Accepted, amended    | The canonical root is the complete grant and must be disjoint from private state      | Strengthened for 0008 and 0009                  |
| [0005](0005-use-node-typescript-pnpm-and-the-npm-registry.md) | Partially superseded | Node, TypeScript, pnpm, npm distribution, and external browser boundary remain active | Packaging/test details superseded by 0007       |
| [0006](0006-use-a-private-control-socket.md)                  | Accepted             | Supervisor control remains on a user-private Unix-domain socket                       | Complements 0002 and 0008                       |
| [0007](0007-adopt-effect-v4.md)                               | Partially superseded | Effect execution, ownership, exact pins, native leaves, and packaging remain active   | CLI choice superseded and logging added by 0009 |
| [0008](0008-separate-raw-serving-from-instrumented-review.md) | Accepted             | Separate review origins, element/freeform feedback, and durable cursor delivery       | Extends 0001; uses 0009 CLI boundary            |
| [0009](0009-adopt-effect-cli-and-logging.md)                  | Accepted             | Effect CLI is authoritative; logs are isolated diagnostics                            | Partially supersedes 0003 and 0007              |

The [CLI contract](../CLI.md), [Product requirements](../PRODUCT.md), and
[Threat Model](../THREAT_MODEL.md) are authoritative when an ADR's historical
wording differs from the current accepted contract.

# 009 — Situation Action Board (SAB): runtime observation and controlled actions

SAB is the operator-facing **Situation Action Board**. It implements the separate **R::Runtime Ontology** of live instances rather than treating a capability diagram as an execution trace. The abstract **C::Capability Ontology** defines permissible behavior and state transitions. The two are joined by explicit `capabilityRef` values, not by assuming that a type-level method already executed.

This implementation extends the DeepSeek SuperAgent Prototype without replacing its Ticket/Engine/Executor/Session architecture. It does **not** change the core Ticket schema. It is a working first vertical slice, not a claim that unobserved provider invocations or tool traces are observable.

## Data and identity

- **R::Ticket** — authoritative persisted Ticket aggregate in `Store.tickets`: stable `ticketId`, stage, Assignment, Report, pending Inputs, created/updated/end timestamps. Ticket is a durable business state machine, **not** a Packet.
- **R::Worker** — logical owner for a ticket, containing a distinct WorkerLLM context. The technical locator `worker-<ticketId>` follows `workerSessionId`. Its observed `turn` comes from the current DSH Agent registry; `unknown` means no confirmed live observation, **not** proof that no Session exists.
- **R::AssignmentRecord** and **R::PacketInstance** — retain their own IDs and associations; an Assignment's `startedAt` is not evidence that an LLM request succeeded.
- **R::EvidenceRef** — points to persisted Ticket/Assignment/Report/Input facts. A tool result, model invocation or message ID must not be invented from a logical step or derived session ID.
- **R::PendingAction** — a proposed operation with a `C::` capability reference and eligibility metadata; this is not an executed action. Actual Engine commands and their result must be checked against the next snapshot.
- **DSH::Effects** is an async implementation queue, not the same object as a C::HighLevelEffect.

Implementation: [runtime projection](../src/app/sab.ts), [bounded durable archive](../src/app/sab-history.ts), [HTTP host](../src/app/http.ts), [SAB panel](../src/client/sab.tsx).

## Read paths

1. Open the existing SuperAgent management panel and select **SAB / 态势行动板**. This panel polls `GET /orchestrator/api/sab` every 2.5 seconds while mounted.
2. `GET /orchestrator/api/sab` reads open Ticket aggregates and currently loaded DSH worker Agents. The response includes `R::SAB` typed state, associated Worker/Assignment/Inputs, `lastConfirmed` and `evidence`, `next`, `allowed`, an evidence-distinguishing Mermaid description, and the current archive version and DIFF.
3. `GET /orchestrator/api/sab/history` lists version, timestamp and semantic DIFF. `GET /orchestrator/api/sab/history/:version` retrieves a historical snapshot. History is **read-only**, not Ticket rollback.
4. In the Main LLM session, call **`orchestrator_sab`** to retrieve the same state model. The model's orchestration prompt instructs it to consult SAB when a new relevant report, candidate, follow-up or manual request requires cross-Worker coordination, rather than polling continuously. Results can be paged/limited; the archive always captures the complete open-Ticket state.

## Controlled action paths

`POST /orchestrator/api/sab/tickets/:id/control`

Example body:

```json
{ "action": "request-status", "expectedUpdatedAt": "2026-11-08T10:00:00.000Z" }
```

Actions: `request-status`, `note` (additional `text`), `retry`, `stop`. HTTP management is loopback and same-origin guarded by the existing host. `expectedUpdatedAt` prevents acting on a stale Ticket observation (HTTP 409). The Engine must pass its own lifecycle / Mandate checks. A successful API response means **accepted by the Engine**, not that the worker finished.

- Main LLM can use its existing **`orchestrator_ticket_request_status`** and **`orchestrator_ticket_note`** tools; `note` passes a fact without changing task authorization.
- Explicit operator confirmation in SAB panel is required for **retry** and **stop**. Main LLM is not granted a general autonomous stop operation.
- `request-status` returns `accepted=false` if no report request was appropriate. The panel then reloads authoritative state.
- Historical snapshots never authorize a new command. Control always supplies the live Ticket's last-seen `updatedAt`.

The original Engine remains the source of truth. No direct SQL mutation of Ticket business state and no sending raw unguarded messages to random Session IDs.

## Versioning, DIFF and failure recovery

`SabArchive` adds an **`sab_archive`** SQLite table alongside existing tables. It records at most 100 semantic snapshots by default, with a monotonically increasing archive version and DIFF fields `added`, `removed`, `changed`, `workerTurnsChanged`. Captures happen on committed domain events, observed DSH worker status transitions, Main LLM board reads and management board reads. Two observations with the same semantic content produce one archive version.

A failed committed-state capture logs a warning; it must not invalidate a previously committed domain transaction. On restart, a new capture re-observes the persisted Tickets. A prior history version can be opened for diagnosis, but there is **no rewind of an Engine transaction**. A full operational rollback would require a separate safe recovery protocol.

## Limits / next validation layer

This release distinguishes DSH worker Agent turns, shell background-job counts, slot occupancy, background settlement, and transient-retry backoff from Ticket business stages, but it **does not yet prove exact model invocation, tool-call IDs, detailed subagent and shell job lifecycles, or provider token usage**. Those require separate runtime observers and persisted correlation IDs. In particular, `working` may include background jobs while the agent's turn is `idle` — the board warns instead of falsifying a running model call.

A full test/deployment check requires installing this repository's DSH peer dependencies and running `pnpm check` (TypeScript + Vitest + build), followed by a controlled multi-Worker run. GitHub Actions are not required and are not invoked by this feature implementation. See also [007 Architecture](007-architecture.md) and [003 Execution](003-execution.md).

## Source-led acceptance

- A queued Ticket can appear without a confirmed Worker invocation.
- Real Report, Input-read and Assignment records have their own evidence references.
- A stop/retry remains an operator action, subject to Engine guard and version check.
- A committed state change yields a semantic archive DIFF and a new snapshot, while a refresh without changes does not.
- A Main LLM can observe multiple Workers and pass verified facts to another Worker with `note` without broadening that Ticket's mandate.

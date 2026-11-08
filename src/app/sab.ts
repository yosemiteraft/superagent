/** Evidence-oriented runtime projection for Situation Action Board (R::SAB).
 * A snapshot is derived from authoritative Ticket aggregates and the observed DSH agent-turn state.
 * It is not an event log: no model invocation, tool-call receipt, or worker liveness is invented.
 */
import { canRetry, latestAssignment, ticketStage, type Ticket } from '../core/index.ts'

export type WorkerTurn = 'running' | 'idle' | 'unknown'
export interface SabWorkerDetails { backgroundJobCount: number; watchingBackground: boolean; retryBackoff: boolean; holdsSlot: boolean }
export type SabEvidence = {
  source: 'ticket' | 'assignment' | 'report' | 'input' | 'worker-agent'
  ref: string
  at: string
  fact: string
}
export type SabInput = { id: string; kind: Ticket['inputs'][number]['kind']; at: string; delivery: 'pending' | 'handed-off' | 'read' | 'unknown'; evidence: SabEvidence }
export type SabAction = {
  capabilityRef: string
  operation: 'observe' | 'request-status' | 'note' | 'retry' | 'stop' | 'operator-review' | 'resume-processing' | 'none'
  actor: 'main' | 'operator' | 'system'
  reason: string
  eligible: boolean
}
export type SabTicket = {
  ticketId: string
  title: string
  ticket: { state: string; action?: string; updatedAt: string; ended?: Ticket['ended'] }
  assignment: { id: string; state: string; startedAt?: string; endedAt?: string; report?: { state: string; at: string; summary: string } } | null
  worker: { instanceId: string; sessionId: string; turn: WorkerTurn; observedAt: string; llmInvocation: 'unknown'; details?: SabWorkerDetails }
  inputs: SabInput[]
  pendingInputIds: string[]
  lastConfirmed: SabEvidence
  evidence: SabEvidence[]
  next: SabAction
  allowed: SabAction[]
  warnings: string[]
}
export type SabSnapshot = {
  ontology: 'R::SAB'
  schemaVersion: 1
  observedAt: string
  processingPaused: boolean
  summary: { openTickets: number; workerTurnsRunning: number; awaitingPerson: number; queuedAssignments: number; unknownWorkerTurns: number }
  tickets: SabTicket[]
  mermaid: string
}

export type WorkerStatus = (ticketId: string) => WorkerTurn
export type WorkerDetailStatus = (ticketId: string) => SabWorkerDetails | undefined

function event(source: SabEvidence['source'], ref: string, at: string, fact: string): SabEvidence {
  return { source, ref, at, fact }
}
function newest(events: SabEvidence[]): SabEvidence {
  // All events are persisted facts; a report timestamp does not prove an LLM request was made then.
  return events.reduce((best, next) => next.at > best.at ? next : best, events[0]!)
}
function note(capabilityRef: string, operation: SabAction['operation'], actor: SabAction['actor'], reason: string,
  eligible = true): SabAction {
  return { capabilityRef, operation, actor, reason, eligible }
}
export function sabTicket(ticket: Ticket, paused: boolean, turn: WorkerTurn, observedAt: string, details?: SabWorkerDetails): SabTicket {
  const stage = ticketStage(ticket)
  const assignment = latestAssignment(ticket)
  const events = [event('ticket', `ticket:${ticket.id}`, ticket.createdAt, 'created')]
  for (const a of ticket.assignments) {
    events.push(event('assignment', `assignment:${ticket.id}:${a.id}`, a.createdAt, 'created'))
    if (a.startedAt) events.push(event('assignment', `assignment:${ticket.id}:${a.id}`, a.startedAt, 'started'))
    if (a.endedAt) events.push(event('assignment', `assignment:${ticket.id}:${a.id}`, a.endedAt, 'ended'))
    if (a.report) events.push(event('report', `assignment:${ticket.id}:${a.id}:report`, a.report.at, `report:${a.report.state}`))
  }
  if (ticket.ended) events.push(event('ticket', `ticket:${ticket.id}:end`, ticket.ended.at, `ended:${ticket.ended.outcome}`))
  if (ticket.delivery) events.push(event('ticket', `ticket:${ticket.id}:delivery`, ticket.delivery.at, 'delivery-failed'))
  const inputs: SabInput[] = ticket.inputs.map(input => {
    const pending = ticket.undelivered.includes(input.id)
    const delivery = pending ? 'pending' : input.kind === 'trigger' && input.readAt ? 'read'
      : input.kind === 'trigger' && input.readAt === null ? 'handed-off'
      : input.kind === 'trigger' && input.deliveredAt ? 'handed-off'
      : 'unknown'
    if (input.kind === 'trigger' && input.readAt) events.push(event('input', `input:${input.id}`, input.readAt, 'read-by-worker'))
    return { id: input.id, kind: input.kind, at: input.at, delivery,
      evidence: event('input', `input:${input.id}`, input.at, 'recorded') }
  })
  const lastConfirmed = newest(events)
  const worker = { instanceId: `worker-${ticket.id}`, sessionId: `worker-${ticket.id}`, turn, observedAt,
    llmInvocation: 'unknown' as const, ...details ? { details } : {} }
  const allowed: SabAction[] = [
    note('C::Worker.Observe', 'observe', 'system', 'Read persisted state and live agent-turn status'),
    note('C::Worker.Report', 'request-status', 'main', 'Ask for a report only when Engine policy permits', stage.stage === 'idle'),
    note('C::Engine.AddNote', 'note', 'main', 'Supply context, never additional authority', !ticket.ended),
    note('C::Ticket.ResumePolicy', 'retry', 'operator', 'Retry requires the original human authority and Engine guard', canRetry(ticket)),
    note('C::Engine.StopTicket', 'stop', 'operator', 'Explicit operator action, never autonomous main-LLM action', !ticket.ended),
  ]
  let next: SabAction
  if (ticket.ended) next = note('C::Ticket.Lifecycle', 'none', 'system', 'Terminal Ticket; retain evidence')
  else if (paused) next = note('C::Executor.Resume', 'resume-processing', 'operator', 'Processing is paused')
  else if (stage.stage === 'person') next = note('C::Ticket.Review', 'operator-review', 'operator',
    `Human action required: ${stage.action}`)
  else if (stage.stage === 'working') next = note('C::Executor.ObserveWorker', 'observe', 'system',
    stage.action === 'queued' ? 'Assignment queued; do not assert a worker session exists' : 'Observe worker turn and background jobs')
  else next = note('C::Worker.Report', 'request-status', 'main',
    'Verify whether a status request is appropriate; an idle worker may be waiting for new input')
  const warnings: string[] = []
  if (turn === 'unknown') warnings.push('Worker turn is unobserved; persisted Assignment state is not proof of current execution')
  if (ticket.delivery) warnings.push('Recorded input delivery failure')
  if (details?.backgroundJobCount && turn !== 'running') warnings.push('Background shell jobs continue while the main Worker turn is not running')
  if (stage.stage === 'working' && turn === 'idle' && stage.action !== 'queued')
    warnings.push('Ticket working while the agent turn is idle; background work or pending reconciliation may explain this')
  return { ticketId: ticket.id, title: ticket.title,
    ticket: { state: stage.stage, ...('action' in stage && stage.action ? { action: stage.action } : {}), updatedAt: ticket.updatedAt,
      ...ticket.ended ? { ended: ticket.ended } : {} },
    assignment: assignment ? { id: assignment.id, state: assignment.state,
      ...assignment.startedAt ? { startedAt: assignment.startedAt } : {},
      ...assignment.endedAt ? { endedAt: assignment.endedAt } : {},
      ...assignment.report ? { report: { state: assignment.report.state, at: assignment.report.at,
        summary: assignment.report.summary.slice(0, 500) } } : {} } : null,
    worker, inputs, pendingInputIds: [...ticket.undelivered], evidence: events, lastConfirmed, next, allowed, warnings }
}
function safe(value: string): string { return value.replace(/[\r\n"'\\\[\]{}()|%;#]/g, ' ').replace(/[<>]/g, '').slice(0, 100) }
/** Mermaid represents derived state only; arrows with solid evidence require a real persisted association or start. */
export function sabMermaid(tickets: SabTicket[]): string {
  const lines = ['flowchart LR', '  %% R::SAB: actual persisted records; worker-turn observations are ephemeral',
    '  O["R::Orchestrator · contains MainLLM"]']
  tickets.forEach((t, i) => {
    const ticket = `T${i}`, assignment = `A${i}`, worker = `W${i}`, llm = `L${i}`, execution = `X${i}`
    lines.push(`  ${ticket}[["R::Ticket ${safe(t.ticketId)} · ${safe(t.ticket.state)}"]]`)
    if (t.assignment) {
      lines.push(`  ${assignment}["R::Assignment ${safe(t.assignment.id)} · ${safe(t.assignment.state)}"]`)
      lines.push(`  ${ticket} ==>|persisted association| ${assignment}`)
    }
    lines.push(`  subgraph ${worker}["R::Worker ${safe(t.worker.sessionId)} · turn=${t.worker.turn}"]`,
      `    ${llm}["R::WorkerLLM · owned context"]`, `    ${execution}["R::Worker runtime · ${t.worker.turn}"]`, '  end')
    if (t.assignment) lines.push(t.assignment.startedAt
      ? `  ${assignment} ==>|recorded startedAt| ${execution}`
      : `  ${assignment} -.->|launch pending or unverified| ${execution}`)
    lines.push(`  O -.->|coordination · not a trace| ${ticket}`)
  })
  if (!tickets.length) lines.push('  E["No open Ticket · no Worker inferred"]', '  O -.-> E')
  return lines.join('\n')
}
export function sabSnapshot(tickets: Ticket[], paused: boolean, status: WorkerStatus,
  observedAt = new Date().toISOString(), details?: WorkerDetailStatus): SabSnapshot {
  const items = tickets.map(ticket => sabTicket(ticket, paused, status(ticket.id), observedAt, details?.(ticket.id)))
  return { ontology: 'R::SAB', schemaVersion: 1, observedAt, processingPaused: paused,
    summary: { openTickets: tickets.filter(ticket => !ticket.ended).length,
      workerTurnsRunning: items.filter(item => item.worker.turn === 'running').length,
      awaitingPerson: items.filter(item => item.ticket.state === 'person').length,
      queuedAssignments: items.filter(item => item.ticket.action === 'queued').length,
      unknownWorkerTurns: items.filter(item => item.worker.turn === 'unknown').length },
    tickets: items, mermaid: sabMermaid(items) }
}

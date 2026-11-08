import { describe, expect, it } from 'vitest'
import { sabSnapshot, sabTicket, sabMermaid } from '../src/app/sab.ts'
import type { Ticket } from '../src/core/index.ts'

const date = (min: number) => new Date(Date.UTC(2026, 10, 8, 10, min)).toISOString()
const sample = (patch: Partial<Ticket> = {}): Ticket => ({
  id: 'T-1', title: 'Implement SAB', createdAt: date(0), updatedAt: date(3), inputs: [],
  undelivered: [], assignments: [{ id: 'A-1', state: 'pending', createdAt: date(1) }],
  ...patch,
} as Ticket)

describe('R::SAB evidence and control boundaries', () => {
  it('does not invent a Worker session, tool execution or LLM invocation for a queued Ticket', () => {
    const board = sabSnapshot([sample()], false, () => 'unknown', date(5))
    expect(board.ontology).toBe('R::SAB')
    expect(board.summary).toEqual({ openTickets: 1, workerTurnsRunning: 0,
      awaitingPerson: 0, queuedAssignments: 1, unknownWorkerTurns: 1 })
    expect(board.tickets[0]?.worker.llmInvocation).toBe('unknown')
    expect(board.tickets[0]?.lastConfirmed).toMatchObject({ source: 'assignment', fact: 'created' })
    expect(board.mermaid).toContain('launch pending or unverified')
    expect(board.mermaid).not.toContain('recorded startedAt')
  })

  it('uses recorded report and read receipts without conflating business report with an LLM invocation', () => {
    const ticket = sample({
      assignments: [{ id: 'A-1', state: 'running', createdAt: date(1), startedAt: date(2),
        report: { state: 'progress', summary: 'Building', at: date(3) } }],
      inputs: [{ id: 'I-1', kind: 'trigger', triggerId: 'TR-1', at: date(1), readAt: date(4) }],
      updatedAt: date(4),
    })
    const shown = sabTicket(ticket, false, 'running', date(5))
    expect(shown.lastConfirmed).toMatchObject({ source: 'input', ref: 'input:I-1', fact: 'read-by-worker' })
    expect(shown.inputs[0]?.delivery).toBe('read')
    expect(shown.worker.llmInvocation).toBe('unknown')
    expect(shown.worker.turn).toBe('running')
    expect(shown.assignment?.report?.state).toBe('progress')
  })

  it('does not authorize MainLLM to stop a Ticket and respects retry eligibility', () => {
    const shown = sabTicket(sample({ assignments: [{ id: 'A-1', state: 'running', createdAt: date(1), startedAt: date(2),
      report: { state: 'failed', summary: 'Failure', at: date(3) } }] }), false, 'idle', date(5))
    expect(shown.ticket.state).toBe('person')
    expect(shown.next.actor).toBe('operator')
    expect(shown.allowed.find(a => a.operation === 'retry')).toMatchObject({ actor: 'operator', eligible: true })
    expect(shown.allowed.find(a => a.operation === 'stop')).toMatchObject({ actor: 'operator', eligible: true })
    expect(shown.allowed.some(a => a.operation === 'stop' && a.actor === 'main')).toBe(false)
  })

  it('keeps a persisted end terminal and notes unknown Worker turn separately', () => {
    const shown = sabTicket(sample({ ended: { at: date(5), by: 'human', outcome: 'stopped' } }), false, 'unknown', date(6))
    expect(shown.ticket.state).toBe('ended')
    expect(shown.next.operation).toBe('none')
    expect(shown.allowed.find(a => a.operation === 'stop')?.eligible).toBe(false)
    expect(shown.lastConfirmed.fact).toBe('ended:stopped')
  })

  it('Mermaid node IDs are generated rather than using untrusted Ticket IDs as syntax', () => {
    const item = sabTicket(sample({ id: 'T-1\"\nC --> D' }), false, 'unknown', date(5))
    const chart = sabMermaid([item])
    expect(chart).toContain('T0[[')
    expect(chart).not.toContain('\nC --> D')
    expect(chart).toContain('R::Ticket')
  })

  it('empty board reports no Worker and still yields a parseable Mermaid skeleton', () => {
    const board = sabSnapshot([], false, () => { throw new Error('should not query worker') }, date(0))
    expect(board.tickets).toEqual([])
    expect(board.mermaid).toContain('No open Ticket')
  })
})

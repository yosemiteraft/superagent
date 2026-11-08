/** Durable, bounded SAB snapshot archive. History is observational: restoring a view does not undo Engine state. */
import { createHash } from 'node:crypto'
import type { Store } from './store.ts'
import type { SabSnapshot, SabTicket } from './sab.ts'

export interface SabDiff { added: string[]; removed: string[]; changed: string[]; workerTurnsChanged: string[] }
export interface SabArchiveEntry { version: number; at: string; diff: SabDiff }
export interface SabArchiveSnapshot extends SabArchiveEntry { snapshot: SabSnapshot }
function semantic(ticket: SabTicket) {
  return { ticketId: ticket.ticketId, ticket: ticket.ticket, assignment: ticket.assignment, inputs: ticket.inputs,
    pendingInputIds: ticket.pendingInputIds, workerTurn: ticket.worker.turn, workerDetails: ticket.worker.details, next: ticket.next, lastConfirmed: ticket.lastConfirmed,
    warnings: ticket.warnings }
}
function fingerprint(snapshot: SabSnapshot): string {
  // Strip observation times, Mermaid and evidence presentation; only material state changes create a new archive version.
  return createHash('sha256').update(JSON.stringify({ paused: snapshot.processingPaused,
    tickets: snapshot.tickets.map(semantic).sort((a, b) => a.ticketId.localeCompare(b.ticketId)) })).digest('hex')
}
export function sabDiff(before: SabSnapshot | undefined, after: SabSnapshot): SabDiff {
  const previous = new Map((before?.tickets ?? []).map(item => [item.ticketId, item]))
  const current = new Map(after.tickets.map(item => [item.ticketId, item]))
  const added = [...current.keys()].filter(id => !previous.has(id))
  const removed = [...previous.keys()].filter(id => !current.has(id))
  const changed = [...current].filter(([id, value]) => {
    const old = previous.get(id)
    return old && JSON.stringify(semantic(old)) !== JSON.stringify(semantic(value))
  }).map(([id]) => id)
  const workerTurnsChanged = [...current].filter(([id, value]) =>
    previous.has(id) && previous.get(id)?.worker.turn !== value.worker.turn).map(([id]) => id)
  return { added, removed, changed, workerTurnsChanged }
}
/** Creates only an additive table. Does not mutate the authoritative Ticket or core schema version. */
export class SabArchive {
  constructor(private readonly store: Pick<Store, 'db'>, private readonly keep = 100) {
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS sab_archive (
      version INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      diff TEXT NOT NULL,
      snapshot TEXT NOT NULL
    )`)
  }
  latest(): SabArchiveEntry | undefined {
    const row = this.store.db.prepare('SELECT version, at, diff FROM sab_archive ORDER BY version DESC LIMIT 1').get()
    return row ? { version: Number(row.version), at: String(row.at), diff: JSON.parse(String(row.diff)) as SabDiff } : undefined
  }
  list(limit = 25): SabArchiveEntry[] {
    const size = Math.max(1, Math.min(100, Math.trunc(limit)))
    return this.store.db.prepare('SELECT version, at, diff FROM sab_archive ORDER BY version DESC LIMIT ?').all(size)
      .map(row => ({ version: Number(row.version), at: String(row.at), diff: JSON.parse(String(row.diff)) as SabDiff }))
  }
  get(version: number): SabArchiveSnapshot | undefined {
    const row = this.store.db.prepare('SELECT version, at, diff, snapshot FROM sab_archive WHERE version=?').get(version)
    return row ? { version: Number(row.version), at: String(row.at), diff: JSON.parse(String(row.diff)) as SabDiff,
      snapshot: JSON.parse(String(row.snapshot)) as SabSnapshot } : undefined
  }
  /** Idempotent on semantic state; a read at a later time does not alone create a version. */
  capture(snapshot: SabSnapshot): SabArchiveEntry {
    const hash = fingerprint(snapshot)
    const last = this.store.db.prepare('SELECT version, at, fingerprint, diff, snapshot FROM sab_archive ORDER BY version DESC LIMIT 1')
      .get()
    if (last?.fingerprint === hash) return { version: Number(last.version), at: String(last.at),
      diff: JSON.parse(String(last.diff)) as SabDiff }
    const before = last ? JSON.parse(String(last.snapshot)) as SabSnapshot : undefined
    const diff = sabDiff(before, snapshot)
    const result = this.store.db.prepare('INSERT INTO sab_archive(at,fingerprint,diff,snapshot) VALUES (?,?,?,?)')
      .run(snapshot.observedAt, hash, JSON.stringify(diff), JSON.stringify(snapshot))
    if (this.keep > 0) this.store.db.prepare('DELETE FROM sab_archive WHERE version NOT IN '
      + '(SELECT version FROM sab_archive ORDER BY version DESC LIMIT ?)').run(this.keep)
    return { version: Number(result.lastInsertRowid), at: snapshot.observedAt, diff }
  }
}

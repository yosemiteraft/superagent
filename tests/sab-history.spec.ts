import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { SabArchive, sabDiff } from '../src/app/sab-history.ts'
import { sabSnapshot } from '../src/app/sab.ts'
import type { Ticket } from '../src/core/index.ts'

const at = (n: number) => new Date(Date.UTC(2026, 10, 8, 10, n)).toISOString()
const ticket = (id: string, running = false): Ticket => ({
  id, title: id, createdAt: at(0), updatedAt: running ? at(2) : at(1),
  inputs: [], undelivered: [], assignments: [{ id: 'A1', state: running ? 'running' : 'pending',
    createdAt: at(1), ...(running ? { startedAt: at(2) } : {}) }],
} as Ticket)

describe('SAB SQLite semantic snapshot history', () => {
  it('records DIFF and ignores observation-only changes', () => {
    const db = new DatabaseSync(':memory:')
    try {
      const history = new SabArchive({ db } as never)
      const one = sabSnapshot([ticket('T1')], false, () => 'unknown', at(3))
      const v1 = history.capture(one)
      expect(v1.version).toBe(1)
      expect(v1.diff.added).toEqual(['T1'])
      expect(history.capture(sabSnapshot([ticket('T1')], false, () => 'unknown', at(4))).version).toBe(1)
      expect(history.list()).toHaveLength(1)
      const two = sabSnapshot([ticket('T1', true), ticket('T2')], false,
        id => id === 'T1' ? 'running' : 'unknown', at(5))
      const v2 = history.capture(two)
      expect(v2.version).toBe(2)
      expect(v2.diff).toMatchObject({ added: ['T2'], changed: ['T1'], workerTurnsChanged: ['T1'] })
      expect(history.get(1)?.snapshot.tickets).toHaveLength(1)
      expect(history.get(2)?.snapshot.tickets).toHaveLength(2)
      expect(history.latest()?.version).toBe(2)
      expect(sabDiff(two, sabSnapshot([], false, () => 'unknown', at(6))).removed).toEqual(['T1', 'T2'])
    } finally { db.close() }
  })

  it('retains bounded history without corrupting current Ticket state', () => {
    const db = new DatabaseSync(':memory:')
    try {
      const archive = new SabArchive({ db } as never, 2)
      archive.capture(sabSnapshot([ticket('T1')], false, () => 'unknown', at(0)))
      archive.capture(sabSnapshot([ticket('T2')], false, () => 'unknown', at(1)))
      archive.capture(sabSnapshot([ticket('T3')], false, () => 'unknown', at(2)))
      expect(archive.list().map(x => x.version)).toEqual([3, 2])
      expect(archive.get(1)).toBeUndefined()
    } finally { db.close() }
  })
})

/** Situation Action Board: live, evidence-labelled Ticket/Worker projections and guarded operator controls. */
import { useState } from 'react'
import type { SabTicket } from '../app/sab.ts'
import type { SabArchiveSnapshot } from '../app/sab-history.ts'
import { usePoll } from './api.ts'
import { Button, Icon, Tag } from './controls.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { ConfirmButton, Hint, LoadState, SessionButton } from './widgets.tsx'

const tone = (ticket: SabTicket): 'success' | 'warning' | 'danger' | 'info' | 'quiet' => {
  if (ticket.ticket.state === 'person') return 'warning'
  if (ticket.worker.turn === 'running') return 'success'
  if (ticket.worker.turn === 'unknown') return 'quiet'
  if (ticket.ticket.state === 'ended') return 'quiet'
  return 'info'
}
function TicketNode({ value, refresh }: { value: SabTicket; refresh: () => Promise<void> }) {
  const { call, notify, navigate } = usePanel()
  const [text, setText] = useState('')
  const [expanded, setExpanded] = useState(false)
  const control = async (action: 'request-status' | 'note' | 'stop' | 'retry') => {
    const result = await call('POST sab/tickets/:id/control', { id: value.ticketId, body: {
      action, expectedUpdatedAt: value.ticket.updatedAt, ...action === 'note' ? { text } : {} } })
    notify(result.reason)
    if (action === 'note' && result.accepted) setText('')
    await refresh()
  }
  const send = useAction(control)
  const enabled = (action: string) => !!value.allowed.find(item => item.operation === action && item.eligible)
  return <article className="dt-sab-lane">
    <div className="dt-sab-ticket">
      <div className="dt-sab-top">
        <div><strong>R::Ticket</strong> <code>{value.ticketId}</code><h3>{value.title}</h3></div>
        <Tag tone={tone(value)}>{value.ticket.state}{value.ticket.action ? ` · ${value.ticket.action}` : ''}</Tag>
      </div>
      <div className="dt-sab-sub">Last confirmed: {value.lastConfirmed.fact} · {value.lastConfirmed.at}</div>
      <div className="dt-sab-sub">Evidence: <code>{value.lastConfirmed.ref}</code></div>
    </div>
    <span className="dt-sab-arrow" aria-hidden="true">→</span>
    <div className="dt-sab-worker">
      <div className="dt-sab-top"><strong>R::Worker</strong><Tag tone={value.worker.turn === 'running' ? 'success'
        : value.worker.turn === 'unknown' ? 'warning' : 'quiet'}>{value.worker.turn}</Tag></div>
      <div className="dt-sab-sub"><code>{value.worker.sessionId}</code></div>
      <div className="dt-sab-inset">WorkerLLM · invocation <strong>unknown</strong></div>
      {value.worker.details && <div className="dt-sab-sub">Background jobs: {value.worker.details.backgroundJobCount}
        {' · '}Slot: {value.worker.details.holdsSlot ? 'held' : 'free'}
        {value.worker.details.watchingBackground ? ' · settling' : ''}
        {value.worker.details.retryBackoff ? ' · retry backoff' : ''}</div>}
      <div className="dt-sab-sub">Assignment: {value.assignment ? `${value.assignment.id} · ${value.assignment.state}` : 'not recorded'}</div>
      {value.assignment?.report && <div className="dt-sab-sub">Report: {value.assignment.report.state} · {value.assignment.report.at}</div>}
      <div className="dt-sab-actions"><SessionButton sessionId={value.worker.sessionId} />
        <Button size="sm" variant="outline" onClick={() => navigate({ page: 'execution', id: value.ticketId })}>Ticket</Button></div>
    </div>
    <div className="dt-sab-follow">
      <strong>Next · {value.next.capabilityRef}</strong>
      <p>{value.next.reason}</p>
      <div className="dt-sab-sub">Undelivered: {value.pendingInputIds.length} · Confirmed evidence records: {value.evidence.length}</div>
      {value.warnings.map(warning => <p className="dt-sab-warning" key={warning}>{warning}</p>)}
      <div className="dt-sab-actions">
        {enabled('request-status') && <Button variant="outline" size="sm" disabled={send.busy}
          onClick={() => { void send.run('request-status') }}>Request status</Button>}
        {enabled('retry') && <ConfirmButton label="Retry" title="Retry this Ticket?"
          message="Only retry an authorized stalled Ticket. The Engine checks eligibility."
          onConfirm={() => control('retry')} />}
        {enabled('stop') && <ConfirmButton label="Stop" title="Stop this Ticket?"
          message="Stop its active work. This is an explicit operator action."
          onConfirm={() => control('stop')} />}
        <Button size="sm" onClick={() => setExpanded(!expanded)}>{expanded ? 'Less' : 'Evidence / context'}</Button>
      </div>
      {expanded && <div className="dt-sab-details">
        <strong>Inputs</strong>
        <ul>{value.inputs.map(input => <li key={input.id}><code>{input.id}</code> · {input.kind} · {input.delivery}</li>)}</ul>
        <strong>Context note (does not authorize new work)</strong>
        <textarea aria-label={`Context for ${value.ticketId}`} rows={2} maxLength={3000}
          placeholder="Fact or result from another Worker" value={text} onChange={event => setText(event.target.value)} />
        <Button size="sm" variant="outline" disabled={!text.trim() || !enabled('note') || send.busy}
          onClick={() => { void send.run('note') }}>Send fact</Button>
      </div>}
    </div>
  </article>
}
export function SabPage() {
  const { call, notify } = usePanel()
  const { restarts } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET sab'), [call, restarts], 2500)
  const { data: history, reload: reloadHistory } = usePoll(() => call('GET sab/history'), [call, restarts], 10000)
  const [archive, setArchive] = useState<SabArchiveSnapshot>()
  const showVersion = async (version: number) => {
    try { setArchive(await call('GET sab/history/:version', { version: String(version) })) }
    catch (failure) { notify(String(failure)) }
  }
  const [showMermaid, setShowMermaid] = useState(false)
  return <section className="dt-sab">
    <div className="dt-status-head"><div><h2 className="dt-status-title">Situation Action Board · R::SAB</h2>
      <p className="dt-hint">Live observation from persisted Ticket state and DSH Agent turns. Never infer an LLM invocation from a working Ticket.</p>
    </div><Button variant="outline" size="sm" icon={<Icon name="refresh" />} onClick={() => { void reload() }}>Refresh</Button></div>
    <LoadState error={error} loading={!data} />
    {data && <>
      <div className="dt-sab-summary">
        <span><strong>{data.summary.openTickets}</strong> open Tickets</span>
        <span><strong>{data.summary.workerTurnsRunning}</strong> running Agent turns</span>
        <span><strong>{data.summary.awaitingPerson}</strong> awaiting operator</span>
        <span><strong>{data.summary.queuedAssignments}</strong> queued</span>
        <span><strong>{data.summary.unknownWorkerTurns}</strong> unobserved turns</span>
        {data.processingPaused && <Tag tone="warning">Executor paused</Tag>}
      </div>
      <p className="dt-hint">Observed {data.observedAt} · Archive v{data.archive.version}. Solid edges in the Mermaid export refer to persisted records; inferred/pending relationships are dashed.</p>
      {data.tickets.length ? <div className="dt-sab-lanes">{data.tickets.map(ticket =>
        <TicketNode key={ticket.ticketId} value={ticket} refresh={reload} />)}</div> : <Hint>No open Tickets in the authoritative store.</Hint>}
      <section className="dt-sab-history">
        <div className="dt-sab-actions"><strong>Archived situation DIFF</strong><Button size="sm" variant="outline"
          onClick={() => { void reloadHistory() }}>Refresh archive</Button>
          {archive && <Button size="sm" onClick={() => setArchive(undefined)}>Close history</Button>}</div>
        <div className="dt-sab-actions">{history?.slice(0, 12).map(entry =>
          <Button key={entry.version} size="sm" variant="outline" onClick={() => { void showVersion(entry.version) }}>
            v{entry.version} · +{entry.diff.added.length} / Δ{entry.diff.changed.length} / -{entry.diff.removed.length}
          </Button>)}</div>
        {archive && <div className="dt-sab-details"><strong>Historical R::SAB v{archive.version} · {archive.at}</strong>
          <p className="dt-hint">Read-only evidence: displaying this archive does not roll back any Worker or Ticket.</p>
          <pre className="dt-sab-code">{JSON.stringify(archive.diff, null, 2)}</pre>
          <pre className="dt-sab-code">{archive.snapshot.mermaid}</pre></div>}
      </section>
      <div className="dt-sab-export">
        <Button variant="outline" size="sm" onClick={() => setShowMermaid(!showMermaid)}>{showMermaid ? 'Hide' : 'Show'} Mermaid ontology</Button>
        <Button variant="outline" size="sm" onClick={() => {
          void navigator.clipboard.writeText(data.mermaid).then(() => notify('Mermaid copied'), error => notify(String(error)))
        }}>Copy Mermaid</Button>
        {showMermaid && <pre className="dt-sab-code">{data.mermaid}</pre>}
      </div>
    </>}
  </section>
}

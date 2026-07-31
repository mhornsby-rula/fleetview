// The orientation panels for a session: enough to re-enter a session's context
// after being away, without reading the transcript.
//
//   • NowPanel     — 1-3 sentences on the conceptual work in flight.
//   • SummaryPanel — agent-authored blurb of what the session has accomplished.
//
// Both read from `.fleetview/sessions/<id>.json`, with NowPanel falling back to
// transcript-derived activity when no report file exists.
import type { SessionDigest } from '../shared/events';
import './SessionDigest.css';


export function NowPanel({ digest, live, status, waitingFor }: {
  digest: SessionDigest | null;
  live: boolean;
  /** From `claude agents --json`: 'busy' | 'idle' | 'waiting' | 'shell'. */
  status?: string | null;
  waitingFor?: string | null;
}) {
  const working = live && status !== 'idle' && status !== 'waiting';
  const blocked = live && status === 'waiting';

  if (!working && !blocked) return null;

  return (
    <section className="dg dg-now" aria-label="What this agent is working on now">
      <div className="dg-head">
        <h3>Working on now</h3>
        {working && <span className="dg-pulse" aria-hidden="true" />}
        {working && digest?.reported && (
          <span className="dg-src" title="Reported by the agent itself">self-reported</span>
        )}
      </div>

      {blocked
        ? <p className="dg-prose dg-blocked">Waiting on you{waitingFor ? ` — ${waitingFor}` : ''}.</p>
        : digest?.now
          ? <p className="dg-prose">{digest.now}</p>
          : <p className="dg-none">Nothing reported yet.</p>}

      {digest?.lastRequest && (
        <div className="dg-goal">
          <span className="dg-goal-label">Working toward</span>
          <span className="dg-goal-text" title={digest.lastRequest}>{digest.lastRequest}</span>
        </div>
      )}

      {digest && (digest.tools > 0 || digest.edits > 0) && (
        <div className="dg-counts">
          <span>{digest.tools} tool calls</span>
          <span>{digest.edits} file edits</span>
          {digest.compactions > 0 && <span>{digest.compactions}× compacted</span>}
        </div>
      )}
    </section>
  );
}

export function SummaryPanel({ digest }: { digest: SessionDigest | null }) {
  if (!digest?.summary) return null;

  return (
    <section className="dg dg-summary" aria-label="Session summary">
      <div className="dg-head">
        <h3>Summary</h3>
      </div>
      <p className="dg-prose">{digest.summary}</p>
    </section>
  );
}

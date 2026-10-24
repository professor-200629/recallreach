'use client';

import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, date, Tag, type Payload } from './shared';

type Check = { id: string; integration: string; mode: string; operation: string; ok: boolean; latency_ms: number; detail: string; at: string };
type Status = {
  agent: { provider: string; model: string; configured: boolean; reason: string };
  zetaris: { mode: 'live' | 'mock' | 'none'; detail: string; tables: Record<string, string> | null; connected: boolean; last_live_check: Check | null };
  meterless: { engine: string; upstream: string; storage: string; note: string };
  checks: Check[];
};

export function IntegrationsPanel({ data }: { data: Payload | null }) {
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState(''), [checking, setChecking] = useState(false);
  async function load() { try { setStatus(await api<Status>('/api/integrations')); setError(''); } catch (e) { setError((e as Error).message); } }
  useEffect(() => { let live = true; api<Status>('/api/integrations').then(s => { if (live) setStatus(s); }).catch(e => { if (live) setError((e as Error).message); }); return () => { live = false; }; }, []);
  async function check() { setChecking(true); try { await api('/api/integrations', { integration: 'zetaris' }); await load(); } catch (e) { setError((e as Error).message); } finally { setChecking(false); } }

  if (!status) return <div className="loading" role="status">{error ? <span className="form-error">{error}</span> : <><Loader2 className="spin" />Checking integration status…</>}</div>;
  const z = status.zetaris, last = z.last_live_check;
  const zTag = z.mode === 'none' ? <Tag>NOT CONFIGURED</Tag> : z.mode === 'mock' ? <Tag tone="amber">MOCK · NOT ZETARIS</Tag> : z.connected ? <Tag tone="teal">CONNECTED · LAST CHECK PASSED</Tag> : last ? <Tag tone="red">CONFIGURED · LAST CHECK FAILED</Tag> : <Tag tone="amber">CONFIGURED · NOT YET VERIFIED</Tag>;
  return <div className="integrations">
    {error && <div className="message error" role="alert"><span>{error}</span></div>}
    <p className="muted intro">Technical settings live here, outside the operator workflow. Secrets are set on the server and are never shown in this page. A status is only reported as connected after a real request succeeds.</p>
    <section className="panel integration-card">
      <div className="panel-heading"><div><span className="eyebrow">DATA ACCESS</span><h2>Zetaris</h2></div>{zTag}</div>
      <div className="integration-body">
        <p>{z.detail}</p>
        <p className="subtle">RecallReach queries three separately owned source tables through Zetaris (distributor dispatches, pharmacy stock events, returns register) with fixed, read-only SELECT statements. Rows keep their table and row key when imported.</p>
        {z.tables && <dl className="kv">{Object.entries(z.tables).map(([k, v]) => <div key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd className="mono">{v}</dd></div>)}</dl>}
        <div className="integration-actions"><button className="button" onClick={check} disabled={checking || z.mode === 'none'}>{checking ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}Run connection check</button>{last && <span className="subtle">Last live check {date(last.at)}: {last.ok ? 'passed' : 'failed'} in {last.latency_ms} ms</span>}</div>
      </div>
      <div className="table-scroll"><table><thead><tr><th>When</th><th>Mode</th><th>Operation</th><th>Result</th><th>Latency</th><th>Detail</th></tr></thead><tbody>
        {status.checks.filter(c => c.integration === 'zetaris').map(c => <tr key={c.id} className="static-row"><td>{date(c.at)}</td><td><Tag tone={c.mode === 'live' ? 'teal' : 'amber'}>{c.mode.toUpperCase()}</Tag></td><td>{c.operation}</td><td><Tag tone={c.ok ? 'teal' : 'red'}>{c.ok ? 'OK' : 'FAILED'}</Tag></td><td>{c.latency_ms} ms</td><td>{c.detail}</td></tr>)}
      </tbody></table>{!status.checks.some(c => c.integration === 'zetaris') && <div className="empty-small"><small>No connection attempts recorded yet.</small></div>}</div>
    </section>
    <section className="panel integration-card">
      <div className="panel-heading"><div><span className="eyebrow">INVESTIGATION MEMORY</span><h2>Meterless H-MEM</h2></div><Tag tone="teal">IN USE · VENDORED REFERENCE ENGINE</Tag></div>
      <div className="integration-body">
        <p>{status.meterless.note}</p>
        <dl className="kv"><div><dt>Engine</dt><dd className="mono">{status.meterless.engine}</dd></div><div><dt>Upstream</dt><dd>{status.meterless.upstream}</dd></div><div><dt>Storage</dt><dd>{status.meterless.storage}</dd></div>
          {data?.memory.ledger && <div><dt>This case</dt><dd>{data.memory.items.length} memories · {data.memory.ledger.entries} ledger entries</dd></div>}</dl>
        <p className="subtle">H-MEM provides ranking, the trust ledger, supersession lineage and conflict detection. RecallReach adds evidence fingerprints so a memory is marked for recheck when its evidence changes. Upstream describes this reference implementation as not a production library.</p>
      </div>
    </section>
    <section className="panel integration-card">
      <div className="panel-heading"><div><span className="eyebrow">LANGUAGE MODEL</span><h2>Investigation agent</h2></div>{status.agent.configured ? <Tag tone="teal">LIVE MODEL CONFIGURED</Tag> : <Tag>RULES MODE ONLY</Tag>}</div>
      <div className="integration-body">
        <dl className="kv"><div><dt>Provider</dt><dd>{status.agent.provider}</dd></div><div><dt>Model</dt><dd className="mono">{status.agent.model || '—'}</dd></div></dl>
        <p>{status.agent.reason}</p>
        <p className="subtle">The model chooses tools and explains evidence. The deterministic engine owns every stock number. Without a model, rules mode runs a fixed procedure with the same tools and the same citation checks.</p>
      </div>
    </section>
    <p className="fine-print"><ShieldCheck size={13} /> Setup and verification steps are in docs/INTEGRATIONS.md in the repository.</p>
  </div>;
}

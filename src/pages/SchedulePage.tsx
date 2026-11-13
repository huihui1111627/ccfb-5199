import { useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { getDAGNodes, DQ_TASK_ID } from '../pipeline/scheduler';
import { SOURCE_CONFIGS } from '../config/sources';
import { StatusBadge, LayerBadge } from '../components/Badges';
import type { DAGNode } from '../types';

const LAYERS: { id: DAGNode['layer']; title: string }[] = [
  { id: 'DWD', title: 'DWD 明细层' },
  { id: 'DWS', title: 'DWS 汇总层' },
  { id: 'DQ', title: '质量门禁' },
  { id: 'ADS', title: 'ADS 应用层' },
];
const COL_W = 210;
const NODE_H = 78;
const GAP_Y = 14;

export function SchedulePage() {
  const { lastRun, runHistory, running, runPipeline, imports } = useStore();
  const [fromDate, setFromDate] = useState('2026-10-26');
  const [forceFull, setForceFull] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const nodes = useMemo(() => getDAGNodes({}), []);
  const runsById = useMemo(() => new Map((lastRun?.taskRuns ?? []).map((r) => [r.taskId, r])), [lastRun]);

  const layout = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const pos = new Map<string, { x: number; y: number }>();
    LAYERS.forEach((layer, li) => {
      const items = nodes.filter((n) => n.layer === layer.id);
      items.forEach((n, i) => pos.set(n.id, { x: li * (COL_W + 26), y: i * (NODE_H + GAP_Y) }));
    });
    const edges: { from: DAGNode; to: DAGNode }[] = [];
    for (const n of nodes) for (const d of n.deps) {
      const f = byId.get(d);
      if (f) edges.push({ from: f, to: n });
    }
    const height = Math.max(...LAYERS.map((l) => nodes.filter((n) => n.layer === l.id).length)) * (NODE_H + GAP_Y) + 40;
    return { pos, edges, height, byId };
  }, [nodes]);

  const statusOf = (id: string) => runsById.get(id)?.status ?? 'pending';

  const doRun = async (mode: 'full' | 'backfill') => {
    // forceFull 时清除断点上下文，全部任务重跑
    if (forceFull) useStore.setState({ lastRun: null });
    await runPipeline(mode, mode === 'backfill' ? fromDate : null);
  };

  const minDate = useMemo(() => {
    const all = imports.flatMap((i) => i.bizDates).sort();
    return all[0] ?? '2026-10-26';
  }, [imports]);

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <div className="row">
          <h3 style={{ margin: 0 }}>任务依赖图（DAG）</h3>
          <span className="muted">拓扑排序执行；阻断型质量规则失败的分区不会进入 ADS</span>
          <span className="spacer" />
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            回补业务日期 ≥
            <input type="date" value={fromDate} min={minDate} onChange={(e) => setFromDate(e.target.value)} disabled={running} />
          </label>
          <label className="row" style={{ gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={forceFull} onChange={(e) => setForceFull(e.target.checked)} disabled={running} />
            <span className="dim">强制全量重跑（忽略断点）</span>
          </label>
          <button className="btn btn-primary" disabled={running || !imports.length} onClick={() => void doRun('full')}>
            {running ? '运行中…' : '全量运行'}
          </button>
          <button className="btn" disabled={running || !imports.length} onClick={() => void doRun('backfill')}>
            迟到回补 / 断点重跑
          </button>
        </div>
        {!imports.length && <div className="muted mt8">请先到「数据接入」导入数据。</div>}

        <div className="dag-canvas mt16" ref={wrapRef} style={{ height: layout.height, width: LAYERS.length * (COL_W + 26) }}>
          <svg className="dag-edges" width={LAYERS.length * (COL_W + 26)} height={layout.height}>
            {layout.edges.map((e, i) => {
              const p1 = layout.pos.get(e.from.id)!;
              const p2 = layout.pos.get(e.to.id)!;
              const x1 = p1.x + COL_W - 14;
              const y1 = p1.y + NODE_H / 2;
              const x2 = p2.x + 14;
              const y2 = p2.y + NODE_H / 2;
              const mx = (x1 + x2) / 2;
              const failed = statusOf(e.to.id) === 'failed' || statusOf(e.from.id) === 'failed';
              return (
                <path
                  key={i}
                  d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                  fill="none"
                  stroke={failed ? '#ef4444' : '#3f5173'}
                  strokeWidth={1.4}
                  markerEnd="url(#arrow)"
                />
              );
            })}
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#3f5173" />
              </marker>
            </defs>
          </svg>
          {LAYERS.map((layer, li) => (
            <div key={layer.id} className="dag-layer" style={{ left: li * (COL_W + 26), width: COL_W - 14 }}>
              <div className="dag-layer-title">{layer.title}</div>
              {nodes
                .filter((n) => n.layer === layer.id)
                .map((n) => {
                  const st = statusOf(n.id);
                  const run = runsById.get(n.id);
                  return (
                    <div key={n.id} className={`dag-node ${st}`} title={run?.message ?? n.label}>
                      <div className="row" style={{ gap: 6 }}>
                        <span className="t" style={{ flex: 1 }}>
                          {n.label}
                        </span>
                        <LayerBadge layer={n.layer} />
                      </div>
                      <div className="d">
                        {n.partitioned ? '分区任务 · 幂等回补' : n.id === DQ_TASK_ID ? '规则门禁 · 分区阻断' : '全量重建 · 幂等'}
                      </div>
                      <div className="mt8">
                        <StatusBadge status={st} />
                        {run && run.rowsAffected > 0 && (
                          <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
                            {run.rowsAffected.toLocaleString()} 行
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>任务运行明细</h3>
        {!lastRun ? (
          <div className="empty">尚未运行过 DAG</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>任务</th>
                  <th>状态</th>
                  <th className="num">影响行数</th>
                  <th>开始</th>
                  <th>结束</th>
                  <th>信息</th>
                </tr>
              </thead>
              <tbody>
                {lastRun.taskRuns.map((r) => (
                  <tr key={r.taskId}>
                    <td>{nodes.find((n) => n.id === r.taskId)?.label ?? r.taskId}</td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="num">{r.rowsAffected.toLocaleString()}</td>
                    <td>{r.startedAt?.replace('T', ' ').slice(11, 19) ?? '—'}</td>
                    <td>{r.finishedAt?.replace('T', ' ').slice(11, 19) ?? '—'}</td>
                    <td style={{ whiteSpace: 'normal', maxWidth: 380 }} className="dim">
                      {r.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3>运行历史（最近 20 次，本地持久化）</h3>
        {runHistory.length === 0 ? (
          <div className="empty">无历史</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>运行 ID</th>
                  <th>模式</th>
                  <th>回补起点</th>
                  <th>结果</th>
                  <th>开始时间</th>
                </tr>
              </thead>
              <tbody>
                {runHistory.map((r) => (
                  <tr key={r.runId}>
                    <td className="code-inline">{r.runId}</td>
                    <td>
                      <span className={`badge ${r.mode === 'full' ? 'badge-blue' : 'badge-purple'}`}>
                        {r.mode === 'full' ? '全量' : '回补'}
                      </span>
                    </td>
                    <td>{r.fromDate ?? '—'}</td>
                    <td>
                      <StatusBadge status={r.status === 'success' ? 'success' : 'failed'} />
                    </td>
                    <td>{r.startedAt.replace('T', ' ').slice(0, 19)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

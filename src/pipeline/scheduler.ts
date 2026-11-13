/**
 * DAG 调度器：
 * - 拓扑排序执行 9 个 SQL 任务 + 1 个质量检查节点（dq_check）
 * - 分区任务用 {{FROM_DATE}} 占位：全量=1900-01-01，回补=指定业务日期
 * - 每个任务幂等（CREATE OR REPLACE / 删分区再插），失败可从断点重跑
 * - 任务运行同时落 DuckDB etl_task_run 与浏览器 RunContext 历史
 */
import { DuckEngine } from '../db/duckdb';
import { idb } from '../db/idb';
import { runQuality } from './quality';
import { DEFAULT_TASKS, EARLIEST_DATE, type TaskTemplate } from '../model/sql-templates';
import type { DAGNode, QualityRule, RunContext, TaskRun, TaskStatus } from '../types';

export const DQ_TASK_ID = 'dq_check';

/** 合成的 DQ 节点定义 */
export function getDAGNodes(overrides: Record<string, string>): DAGNode[] {
  const nodes: DAGNode[] = DEFAULT_TASKS.map((t) => ({
    id: t.id,
    label: t.label,
    layer: t.layer,
    deps: t.deps,
    partitioned: t.partitioned,
  }));
  const dqDeps = DEFAULT_TASKS.filter((t) => t.layer === 'DWD' || t.layer === 'DWS').map((t) => t.id);
  nodes.push({ id: DQ_TASK_ID, label: '数据质量检查与阻断', layer: 'DQ', deps: dqDeps, partitioned: false });
  return nodes.sort((a, b) => layerOrder(a.layer) - layerOrder(b.layer));
}

function layerOrder(l: DAGNode['layer']) {
  return { SRC: 0, ODS: 1, DWD: 2, DWS: 3, ADS: 4, DQ: 3.5 }[l] as number;
}

function topoSort(nodes: DAGNode[]): DAGNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<string>();
  const out: DAGNode[] = [];
  const visit = (n: DAGNode, path: Set<string>) => {
    if (visited.has(n.id)) return;
    if (path.has(n.id)) throw new Error(`DAG 存在循环依赖：${n.id}`);
    path.add(n.id);
    for (const dep of n.deps) {
      const d = byId.get(dep);
      if (d) visit(d, path);
    }
    path.delete(n.id);
    visited.add(n.id);
    out.push(n);
  };
  for (const n of nodes) visit(n, new Set());
  return out;
}

function resolveTemplates(overrides: Record<string, string>): TaskTemplate[] {
  return DEFAULT_TASKS.map((t) => (overrides[t.id] ? { ...t, sql: overrides[t.id] } : t));
}

export interface RunOptions {
  mode: 'full' | 'backfill';
  fromDate?: string | null;
  rules: QualityRule[];
  overrides: Record<string, string>;
  /** 断点重跑：传入上次运行，成功的任务跳过 */
  resumeFrom?: RunContext | null;
  onProgress?: (runs: TaskRun[]) => void;
}

export async function runDAG(opts: RunOptions): Promise<RunContext> {
  const eng = DuckEngine.get();
  await eng.ready;
  const runId = `run_${new Date().toISOString().replaceAll(':', '').replaceAll('-', '').slice(0, 15)}`;
  const startedAt = new Date().toISOString();
  const fromDate = opts.mode === 'backfill' ? opts.fromDate ?? EARLIEST_DATE : EARLIEST_DATE;

  const nodes = topoSort(getDAGNodes(opts.overrides));
  const templates = new Map(resolveTemplates(opts.overrides).map((t) => [t.id, t]));
  // 断点重跑：全量模式可沿用上轮成功任务；回补模式下分区任务、DQ 门禁、ADS 依赖回补区间，必须重跑
  const reusable = new Set(
    (opts.resumeFrom?.taskRuns ?? [])
      .filter((r) => r.status === 'success')
      .map((r) => r.taskId)
      .filter((id) => {
        if (opts.mode === 'full') return true;
        const n = nodes.find((x) => x.id === id);
        return n && !n.partitioned && n.layer !== 'DQ' && n.layer !== 'ADS';
      }),
  );
  const prevSuccess = reusable;

  const runs: TaskRun[] = nodes.map((n) => ({
    taskId: n.id,
    status: 'pending',
    startedAt: null,
    finishedAt: null,
    rowsAffected: 0,
    message: '',
  }));
  const find = (id: string) => runs.find((r) => r.taskId === id)!;
  const setStatus = (id: string, patch: Partial<TaskRun>) => {
    Object.assign(find(id), patch);
    opts.onProgress?.(runs.map((r) => ({ ...r })));
  };

  const ctx: RunContext = {
    runId,
    startedAt,
    mode: opts.mode,
    fromDate: opts.mode === 'backfill' ? fromDate : null,
    taskRuns: runs,
    status: 'running',
  };

  let failed = false;
  for (const node of nodes) {
    if (failed) {
      setStatus(node.id, { status: 'skipped', message: '上游失败，未调度' });
      continue;
    }
    const depFailed = node.deps.some((d) => {
      const dr = find(d);
      return dr && (dr.status === 'failed' || dr.status === 'skipped');
    });
    if (depFailed) {
      setStatus(node.id, { status: 'skipped', message: '上游失败，跳过' });
      continue;
    }
    if (prevSuccess.has(node.id)) {
      setStatus(node.id, { status: 'success', message: '断点重跑：沿用上次成功结果' });
      continue;
    }

    setStatus(node.id, { status: 'running', startedAt: new Date().toISOString() });
    const t0 = Date.now();
    try {
      let rows = 0;
      let message = '';
      if (node.id === DQ_TASK_ID) {
        const dqResults = await runQuality(opts.rules, runId);
        const blocked = dqResults.filter((r) => !r.passed && r.severity === 'block');
        rows = await eng.rowCount('dq_blocked_partition');
        message = blocked.length
          ? `${blocked.length} 条阻断型规则失败，隔离 ${rows} 个门店日分区`
          : '全部启用规则通过';
      } else {
        const tpl = templates.get(node.id)!;
        const sql = tpl.sql.replaceAll('{{FROM_DATE}}', fromDate);
        await eng.execScript(sql);
        if (tpl.outputTable) rows = await eng.rowCount(tpl.outputTable);
        message = node.partitioned ? `已重建 >= ${fromDate} 的分区` : '全量重建完成';
      }
      setStatus(node.id, {
        status: 'success',
        finishedAt: new Date().toISOString(),
        rowsAffected: rows,
        message: `${message}（${Date.now() - t0}ms）`,
      });
      await eng.execScript(`INSERT INTO etl_task_run VALUES (
        '${runId}', '${node.id}', 'success', current_timestamp, current_timestamp,
        ${rows}, '${message.replaceAll("'", "''")}')`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus(node.id, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        message,
      });
      failed = true;
      await eng.execScript(`INSERT INTO etl_task_run VALUES (
        '${runId}', '${node.id}', 'failed', current_timestamp, current_timestamp,
        0, '${message.replaceAll("'", "''").slice(0, 500)}')`).catch(() => undefined);
    }
  }

  ctx.status = failed ? 'failed' : 'success';
  ctx.taskRuns = runs.map((r) => ({ ...r }));
  await idb.saveRun(ctx).catch(() => undefined);
  return ctx;
}

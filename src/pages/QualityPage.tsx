import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import { DuckEngine } from '../db/duckdb';
import { DataTable } from '../components/DataTable';
import { SqlEditor } from '../components/SqlEditor';
import type { QualityResult, QualityRule } from '../types';

export function QualityPage() {
  const { rules, saveRules, running } = useStore();
  const [results, setResults] = useState<QualityResult[]>([]);
  const [rejects, setRejects] = useState<Record<string, unknown>[]>([]);
  const [blocked, setBlocked] = useState<Record<string, unknown>[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftSql, setDraftSql] = useState('');
  const eng = DuckEngine.get();

  const refresh = async () => {
    if (await eng.tableExists('dq_rule_result')) {
      const rs = await eng.query<{
        rule_id: string; rule_name: string; table_name: string; severity: string;
        passed: boolean; fail_count: number; checked_at: string;
      }>(`SELECT * FROM dq_rule_result ORDER BY checked_at DESC, rule_id`);
      const latest = new Map<string, (typeof rs)[number]>();
      for (const r of rs) if (!latest.has(r.rule_id)) latest.set(r.rule_id, r);
      setResults(
        rules.map((rule) => {
          const row = latest.get(rule.id);
          return {
            ruleId: rule.id,
            ruleName: rule.name,
            table: rule.table,
            severity: rule.severity,
            passed: row ? !!row.passed : true,
            failCount: row ? Number(row.fail_count) : 0,
            samples: [],
            checkedAt: row?.checked_at ?? '',
            blockedPartitions: [],
          };
        }),
      );
    }
    if (await eng.tableExists('dwd_reject_record')) {
      setRejects(await eng.query(`SELECT * FROM dwd_reject_record ORDER BY rejected_at DESC LIMIT 200`));
    }
    if (await eng.tableExists('dq_blocked_partition')) {
      setBlocked(await eng.query(`SELECT * FROM dq_blocked_partition ORDER BY biz_date, store_id`));
    }
  };

  useEffect(() => {
    void eng.ready.then(refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules]);

  const toggle = async (id: string, patch: Partial<QualityRule>) => {
    const next = rules.map((r) => (r.id === id ? { ...r, ...patch } : r));
    await saveRules(next);
  };

  const saveDraft = async () => {
    if (!editingId) return;
    await toggle(editingId, { checkSql: draftSql });
    setEditingId(null);
  };

  const runOneRule = async (rule: QualityRule) => {
    try {
      const rows = await eng.query(`SELECT * FROM (${rule.checkSql}) AS q LIMIT 100`);
      setResults((prev) =>
        prev.map((r) =>
          r.ruleId === rule.id
            ? { ...r, samples: rows, failCount: rows.length === 100 ? r.failCount : rows.length }
            : r,
        ),
      );
    } catch (e) {
      useStore.getState().showToast('err', `规则 SQL 错误：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const editing = rules.find((r) => r.id === editingId);
  const summary = useMemo(() => {
    const checked = results.filter((r) => r.checkedAt);
    return {
      total: checked.length,
      passed: checked.filter((r) => r.passed).length,
      failed: checked.filter((r) => !r.passed).length,
      blocked: blocked.length,
    };
  }, [results, blocked]);

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid grid-4">
        <div className="card kpi accent-blue">
          <div className="kpi-label">已配置规则</div>
          <div className="kpi-value">{rules.length}</div>
          <div className="kpi-sub">启用 {rules.filter((r) => r.enabled).length} 条</div>
        </div>
        <div className="card kpi accent-green">
          <div className="kpi-label">最近一次通过</div>
          <div className="kpi-value">{summary.passed}</div>
        </div>
        <div className="card kpi accent-red">
          <div className="kpi-label">失败规则</div>
          <div className="kpi-value">{summary.failed}</div>
        </div>
        <div className="card kpi accent-amber">
          <div className="kpi-label">被阻断门店日分区</div>
          <div className="kpi-value">{summary.blocked}</div>
          <div className="kpi-sub">不进入 ADS 指标</div>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <h3 style={{ margin: 0 }}>质量规则配置（可启停、可调级别、可改 SQL）</h3>
          <span className="spacer" />
          <span className="muted" style={{ fontSize: 12 }}>
            修改后请到「任务调度」重新运行 DAG 生效
          </span>
        </div>
        <div className="table-wrap mt16">
          <table className="data">
            <thead>
              <tr>
                <th>启用</th>
                <th>规则</th>
                <th>层级/表</th>
                <th>级别</th>
                <th className="num">最近失败数</th>
                <th>说明</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => {
                const res = results.find((x) => x.ruleId === r.id);
                return (
                  <tr key={r.id}>
                    <td>
                      <label className="switch">
                        <input type="checkbox" checked={r.enabled} onChange={(e) => void toggle(r.id, { enabled: e.target.checked })} />
                        <span className="slider" />
                      </label>
                    </td>
                    <td style={{ whiteSpace: 'normal', maxWidth: 220 }}>{r.name}</td>
                    <td>
                      <span className="badge badge-gray">{r.layer.toUpperCase()}</span>
                      <span className="code-inline" style={{ marginLeft: 6 }}>{r.table}</span>
                    </td>
                    <td>
                      <select
                        value={r.severity}
                        onChange={(e) => void toggle(r.id, { severity: e.target.value as QualityRule['severity'] })}
                        style={{ padding: '3px 8px' }}
                      >
                        <option value="block">阻断</option>
                        <option value="warn">警告</option>
                      </select>
                    </td>
                    <td className="num">
                      {res?.checkedAt ? (
                        <span className={res.passed ? '' : 'badge badge-red'}>{res.failCount}</span>
                      ) : (
                        <span className="muted">未运行</span>
                      )}
                    </td>
                    <td className="dim" style={{ whiteSpace: 'normal', maxWidth: 260 }}>{r.desc}</td>
                    <td>
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          setEditingId(r.id);
                          setDraftSql(r.checkSql);
                        }}
                      >
                        改 SQL
                      </button>
                      <button className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => void runOneRule(r)}>
                        试跑取样
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <div className="card">
          <h3>编辑规则 SQL：{editing.name}（返回行即失败行；需带 store_id、biz_date 列才能写阻断分区）</h3>
          <SqlEditor value={draftSql} onChange={setDraftSql} height={300} />
          <div className="row mt16">
            <button className="btn btn-primary" onClick={() => void saveDraft()}>保存规则</button>
            <button className="btn" onClick={() => setEditingId(null)}>取消</button>
          </div>
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <h3>阻断分区明细（dq_blocked_partition）</h3>
          <DataTable
            rows={blocked}
            pageSize={8}
            empty="无阻断分区 —— 所有门店日均通过质量门禁"
          />
        </div>
        <div className="card">
          <h3>DWD 清洗拒收记录（dwd_reject_record，前 200 条）</h3>
          <DataTable rows={rejects} pageSize={8} empty="无拒收记录" />
        </div>
      </div>

      <div className="card">
        <h3>失败样例（点上方「试跑取样」查看，最多 100 行）</h3>
        {results.some((r) => r.samples.length > 0) ? (
          results
            .filter((r) => r.samples.length > 0)
            .map((r) => (
              <div key={r.ruleId} className="mb12">
                <div className="row mb12">
                  <span className="badge badge-red">{r.ruleName}</span>
                  <span className="muted">{r.samples.length} 条样例</span>
                </div>
                <DataTable rows={r.samples} pageSize={5} maxHeight={260} />
              </div>
            ))
        ) : (
          <div className="empty">暂无样例。规则在 DAG 运行时由质量门禁统一执行；也可对单条规则「试跑取样」。{running ? '' : ''}</div>
        )}
      </div>
    </div>
  );
}

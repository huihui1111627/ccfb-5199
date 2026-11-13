import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_TASKS, EARLIEST_DATE, type TaskTemplate } from '../model/sql-templates';
import { SOURCE_CONFIGS } from '../config/sources';
import { useStore } from '../store/useStore';
import { DuckEngine } from '../db/duckdb';
import { SqlEditor } from '../components/SqlEditor';
import { DataTable } from '../components/DataTable';
import { LayerBadge } from '../components/Badges';

export function LayerPage() {
  const { taskSqlOverrides, saveTaskSql, resetTaskSql, showToast } = useStore();
  const [selected, setSelected] = useState(DEFAULT_TASKS[0].id);
  const [sql, setSql] = useState('');
  const [preview, setPreview] = useState<Record<string, unknown>[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [tab, setTab] = useState<'tasks' | 'ods'>('tasks');
  const [odsTable, setOdsTable] = useState(SOURCE_CONFIGS.pos.odsTable);
  const [running, setRunning] = useState(false);

  const task: TaskTemplate = useMemo(() => DEFAULT_TASKS.find((t) => t.id === selected)!, [selected]);
  const customized = taskSqlOverrides[selected];
  const eng = DuckEngine.get();

  useEffect(() => {
    setSql(customized ?? task.sql);
  }, [selected, customized, task.sql]);

  const refreshCounts = async () => {
    const out: Record<string, number> = {};
    for (const t of DEFAULT_TASKS) {
      if (t.outputTable) out[t.outputTable] = await eng.rowCount(t.outputTable);
    }
    for (const c of Object.values(SOURCE_CONFIGS)) out[c.odsTable] = await eng.rowCount(c.odsTable);
    out['dwd_reject_record'] = await eng.rowCount('dwd_reject_record');
    out['dq_blocked_partition'] = await eng.rowCount('dq_blocked_partition');
    setCounts(out);
  };

  useEffect(() => {
    void eng.ready.then(refreshCounts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const previewTable = async (table: string) => {
    if (!(await eng.tableExists(table))) {
      setPreview([]);
      return;
    }
    setPreview(await eng.query(`SELECT * FROM ${table} LIMIT 100`));
  };

  const runTask = async (useEdited: boolean) => {
    setRunning(true);
    try {
      const finalSql = (useEdited ? sql : customized ?? task.sql).replaceAll('{{FROM_DATE}}', EARLIEST_DATE);
      await eng.execScript(finalSql);
      showToast('ok', `任务 ${task.label} 执行成功`);
      await refreshCounts();
      if (task.outputTable) await previewTable(task.outputTable);
    } catch (e) {
      showToast('err', `SQL 执行失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  const save = async () => {
    await saveTaskSql(selected, sql);
    showToast('ok', 'SQL 已保存到浏览器，后续 DAG 运行使用该版本');
  };

  const reset = async () => {
    await resetTaskSql(selected);
    setSql(task.sql);
    showToast('ok', '已恢复默认 SQL');
  };

  const grouped = (['DWD', 'DWS', 'ADS'] as const).map((layer) => ({
    layer,
    tasks: DEFAULT_TASKS.filter((t) => t.layer === layer),
  }));

  return (
    <div className="grid" style={{ gridTemplateColumns: '280px 1fr', gap: 16, alignItems: 'start' }}>
      <div className="card">
        <div className="tabs">
          <button className={`tab ${tab === 'tasks' ? 'active' : ''}`} onClick={() => setTab('tasks')}>
            转换任务
          </button>
          <button className={`tab ${tab === 'ods' ? 'active' : ''}`} onClick={() => setTab('ods')}>
            ODS 贴源表
          </button>
        </div>
        {tab === 'tasks' &&
          grouped.map((g) => (
            <div key={g.layer} className="mb12">
              <div className="muted" style={{ fontSize: 11.5, margin: '6px 0' }}>
                {g.layer} 层
              </div>
              {g.tasks.map((t) => (
                <button
                  key={t.id}
                  className={`dag-node ${selected === t.id ? 'running' : ''}`}
                  style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => setSelected(t.id)}
                >
                  <div className="t">
                    {t.label}
                    {taskSqlOverrides[t.id] && <span className="badge badge-amber" style={{ marginLeft: 6 }}>已改</span>}
                  </div>
                  <div className="d">
                    {t.outputTable && (
                      <>
                        {t.outputTable} · {counts[t.outputTable] ?? 0} 行
                      </>
                    )}
                  </div>
                </button>
              ))}
            </div>
          ))}
        {tab === 'ods' &&
          Object.values(SOURCE_CONFIGS).map((c) => (
            <button
              key={c.kind}
              className={`dag-node ${odsTable === c.odsTable ? 'running' : ''}`}
              style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}
              onClick={() => {
                setOdsTable(c.odsTable);
                void previewTable(c.odsTable);
              }}
            >
              <div className="t">{c.label}</div>
              <div className="d">
                {c.odsTable} · {counts[c.odsTable] ?? 0} 行
              </div>
            </button>
          ))}
      </div>

      <div className="grid" style={{ gap: 16 }}>
        {tab === 'tasks' ? (
          <div className="card">
            <div className="row mb12">
              <LayerBadge layer={task.layer} />
              <h3 style={{ margin: 0 }}>{task.label}</h3>
              <span className="muted">{task.desc}</span>
              <span className="spacer" />
              {customized && <span className="badge badge-amber">当前为自定义版本</span>}
              <button className="btn btn-sm" disabled={running} onClick={() => void runTask(false)}>
                运行当前版本
              </button>
              <button className="btn btn-sm btn-primary" disabled={running} onClick={() => void runTask(true)}>
                校验并运行编辑器 SQL
              </button>
              <button className="btn btn-sm" onClick={() => void save()}>
                保存修改
              </button>
              <button className="btn btn-sm" onClick={() => void reset()}>
                恢复默认
              </button>
            </div>
            <SqlEditor value={sql} onChange={setSql} height={430} />
            <div className="muted mt8" style={{ fontSize: 12 }}>
              占位符 <span className="code-inline">{'{{FROM_DATE}}'}</span> 在全量运行时替换为 {EARLIEST_DATE}，回补时替换为选定业务日期。
              所有任务均为幂等写法（CREATE OR REPLACE / 删分区再插）。
            </div>
          </div>
        ) : (
          <div className="card">
            <h3>{odsTable}（前 100 行）</h3>
            <div className="row mb12">
              <button className="btn btn-sm btn-primary" onClick={() => void previewTable(odsTable)}>
                刷新预览
              </button>
            </div>
            <DataTable rows={preview} pageSize={10} maxHeight={430} empty="表为空或尚未导入" />
          </div>
        )}

        {tab === 'tasks' && task.outputTable && (
          <div className="card">
            <div className="row">
              <h3 style={{ margin: 0 }}>{task.outputTable} 数据预览（前 100 行）</h3>
              <span className="spacer" />
              <button className="btn btn-sm" onClick={() => void previewTable(task.outputTable!)}>
                刷新
              </button>
            </div>
            <div className="mt16">
              <DataTable rows={preview} pageSize={10} maxHeight={360} empty="尚未运行该任务" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

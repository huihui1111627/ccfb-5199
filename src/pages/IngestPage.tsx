import { useState } from 'react';
import { SOURCE_CONFIGS, SOURCE_ORDER } from '../config/sources';
import { useStore } from '../store/useStore';
import { guessMapping, parseCsvText, readFileAsText, type ParsedCsv } from '../services/import';
import { DataTable } from '../components/DataTable';
import type { FieldMapping, SourceKind } from '../types';

const SAMPLE_FILES: Partial<Record<SourceKind, string[]>> = {
  store: ['dim_store.csv'],
  product: ['dim_product.csv'],
  pos: ['pos.csv', 'pos_late.csv'],
  purchase: ['purchase.csv'],
  transfer: ['transfer.csv'],
  stock: ['stock.csv', 'stock_late.csv'],
};

export function IngestPage() {
  const { imports, doImport, doPurge } = useStore();
  const [kind, setKind] = useState<SourceKind>('pos');
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [fileName, setFileName] = useState('');
  const [mapping, setMapping] = useState<FieldMapping>({});
  const [busy, setBusy] = useState(false);

  const cfg = SOURCE_CONFIGS[kind];

  const resetDraft = () => {
    setParsed(null);
    setFileName('');
    setMapping({});
  };

  const onPickFile = async (file: File) => {
    const text = await readFileAsText(file);
    const p = parseCsvText(text);
    setParsed(p);
    setFileName(file.name);
    setMapping(guessMapping(kind, p.columns));
  };

  const onPickKind = (k: SourceKind) => {
    setKind(k);
    resetDraft();
  };

  const onImport = async () => {
    if (!parsed) return;
    setBusy(true);
    await doImport({ kind, fileName, csvText: parsed.csvText, mapping });
    setBusy(false);
    resetDraft();
  };

  const loadSample = async (file: string) => {
    setBusy(true);
    try {
      const resp = await fetch(`${import.meta.env.BASE_URL}sample-data/${file}`);
      if (!resp.ok) throw new Error(`示例文件 ${file} 不存在，请先运行 npm run gen:data`);
      const text = await resp.text();
      const p = parseCsvText(text);
      setParsed(p);
      setFileName(file);
      setMapping(guessMapping(kind, p.columns));
    } catch (e) {
      useStore.getState().showToast('err', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importAllSamples = async () => {
    setBusy(true);
    try {
      for (const k of SOURCE_ORDER) {
        const files: string[] = SAMPLE_FILES[k] ?? [];
        for (const file of files) {
          const resp = await fetch(`${import.meta.env.BASE_URL}sample-data/${file}`);
          if (!resp.ok) continue;
          const text = await resp.text();
          const p = parseCsvText(text);
          const m = guessMapping(k, p.columns);
          const r = await doImport({ kind: k, fileName: file, csvText: text, mapping: m });
          if (!r) throw new Error(file);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <h3>① 选择数据源并选择 CSV（字段映射可配置）</h3>
        <div className="row mb12">
          {SOURCE_ORDER.map((k) => (
            <button key={k} className={`btn btn-sm ${kind === k ? 'btn-primary' : ''}`} onClick={() => onPickKind(k)}>
              {SOURCE_CONFIGS[k].label}
            </button>
          ))}
        </div>
        <div className="row mb12">
          <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
            选择本地 CSV
            <input
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onPickFile(f);
                e.target.value = '';
              }}
            />
          </label>
          {SAMPLE_FILES[kind]?.map((f) => (
            <button key={f} className="btn btn-sm" disabled={busy} onClick={() => void loadSample(f)}>
              载入示例 {f}
            </button>
          ))}
          <button className="btn btn-sm" disabled={busy} onClick={() => void importAllSamples()}>
            ⚡ 一键导入全部示例
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          ODS 目标表：<span className="code-inline">{cfg.odsTable}</span>
          {cfg.bizDateField && (
            <>
              {' '}· 业务日期字段 <span className="code-inline">{cfg.bizDateField}</span>（迟到回补分区依据）
            </>
          )}
        </div>
      </div>

      {parsed && (
        <div className="card">
          <h3>② 字段映射：{fileName}（CSV {parsed.rows.length} 行 × {parsed.columns.length} 列）</h3>
          <div className="grid grid-4" style={{ gap: 12 }}>
            {cfg.standardFields.map((f: { name: string; type: string; desc: string }) => (
              <label className="field" key={f.name}>
                {f.desc}（{f.name}: {f.type}）
                <select value={mapping[f.name] ?? ''} onChange={(e) => setMapping({ ...mapping, [f.name]: e.target.value })}>
                  <option value="">— 不映射 —</option>
                  {parsed.columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="row mt16">
            <button className="btn btn-primary" disabled={busy} onClick={() => void onImport()}>
              确认映射并导入 ODS
            </button>
            <button className="btn" onClick={resetDraft}>
              取消
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              同一文件重复导入会保留原始批次，DWD 层按业务主键去重，可安全重放
            </span>
          </div>
          <div className="mt16">
            <DataTable rows={parsed.rows.slice(0, 50)} columns={parsed.columns} pageSize={8} empty="空文件" />
          </div>
        </div>
      )}

      <div className="card">
        <div className="row">
          <h3 style={{ margin: 0 }}>③ 导入历史（已持久化到浏览器 IndexedDB）</h3>
          <span className="spacer" />
          {imports.length > 0 && (
            <button
              className="btn btn-sm btn-danger"
              onClick={() => {
                if (confirm('确认清空全部导入与派生层数据？此操作不可恢复。')) void doPurge();
              }}
            >
              清空全部数据
            </button>
          )}
        </div>
        <div className="mt16">
          {imports.length === 0 ? (
            <div className="empty">
              <div className="big">还没有任何导入</div>
              点击上方「一键导入全部示例」快速体验，或选择本地 CSV。
              <br />
              示例含空值、重复、金额不平、负库存、同店调拨、幽灵门店等脏数据，以及两处人为篡改的库存快照。
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>文件</th>
                    <th>数据源</th>
                    <th className="num">行数</th>
                    <th>导入时间</th>
                    <th>业务日期分区</th>
                  </tr>
                </thead>
                <tbody>
                  {imports.map((r) => (
                    <tr key={r.id}>
                      <td>{r.fileName}</td>
                      <td>
                        <span className="badge badge-cyan">{SOURCE_CONFIGS[r.kind].label}</span>
                      </td>
                      <td className="num">{r.rowCount.toLocaleString()}</td>
                      <td>{r.importedAt.replace('T', ' ').slice(0, 19)}</td>
                      <td>
                        {r.bizDates.length === 0
                          ? '主数据'
                          : r.bizDates.length === 1
                            ? r.bizDates[0]
                            : `${r.bizDates[0]} ~ ${r.bizDates[r.bizDates.length - 1]}（${r.bizDates.length} 天）`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

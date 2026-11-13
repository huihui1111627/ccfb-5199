import { useMemo, useState } from 'react';

interface Props {
  rows: Record<string, unknown>[];
  columns?: string[];
  pageSize?: number;
  numberCols?: string[];
  maxHeight?: number;
  empty?: string;
}

/** 通用分页数据表 */
export function DataTable({ rows, columns, pageSize = 10, numberCols = [], maxHeight = 420, empty = '暂无数据' }: Props) {
  const cols = useMemo(() => columns ?? (rows[0] ? Object.keys(rows[0]) : []), [rows, columns]);
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const cur = Math.min(page, pageCount - 1);
  const slice = rows.slice(cur * pageSize, (cur + 1) * pageSize);

  if (!rows.length) return <div className="empty">{empty}</div>;
  return (
    <div>
      <div className="table-wrap" style={{ maxHeight }}>
        <table className="data">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c} className={numberCols.includes(c) ? 'num' : ''}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c} className={numberCols.includes(c) ? 'num' : ''}>
                    {formatCell(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-footer">
        <span>共 {rows.length} 行</span>
        <span className="spacer" />
        <button className="btn btn-sm" disabled={cur === 0} onClick={() => setPage(cur - 1)}>
          上一页
        </button>
        <span>
          {cur + 1} / {pageCount}
        </span>
        <button className="btn btn-sm" disabled={cur >= pageCount - 1} onClick={() => setPage(cur + 1)}>
          下一页
        </button>
      </div>
    </div>
  );
}

export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return v.toLocaleString();
    return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
}

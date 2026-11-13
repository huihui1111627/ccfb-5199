/**
 * 数据接入服务：
 * - papaparse 解析 CSV（保留原始列名，支持中文表头）
 * - 字段映射可配；按映射把源列写入标准 ODS 表
 * - 原始 CSV 与映射归档到 IndexedDB，刷新/重开浏览器可完整重放
 */
import Papa from 'papaparse';
import { DuckEngine } from '../db/duckdb';
import { idb, type ArchivedImport } from '../db/idb';
import { SOURCE_CONFIGS } from '../config/sources';
import type { FieldMapping, SourceKind } from '../types';

export interface ParsedCsv {
  columns: string[];
  rows: Record<string, string>[];
  csvText: string;
}

export function parseCsvText(csvText: string): ParsedCsv {
  const parsed = Papa.parse<Record<string, string>>(csvText.trim(), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });
  if (parsed.errors.length && !parsed.data.length) {
    throw new Error(`CSV 解析失败：${parsed.errors[0]?.message ?? '未知错误'}`);
  }
  const columns = parsed.meta.fields ?? [];
  return { columns, rows: parsed.data, csvText };
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ''));
    fr.onerror = () => reject(fr.error);
    fr.readAsText(file, 'utf-8');
  });
}

/** 智能猜测映射：标准字段名与 CSV 列名精确/包含匹配 */
export function guessMapping(kind: SourceKind, columns: string[]): FieldMapping {
  const cfg = SOURCE_CONFIGS[kind];
  const lowerCols = columns.map((c) => c.toLowerCase().trim());
  const out: FieldMapping = {};
  for (const f of cfg.standardFields) {
    const std = f.name.toLowerCase();
    let idx = lowerCols.indexOf(std);
    if (idx < 0) idx = lowerCols.findIndex((c) => c.includes(std) || std.includes(c));
    if (idx >= 0) out[f.name] = columns[idx];
  }
  return { ...cfg.defaultMapping, ...out };
}

export interface ImportOutcome {
  record: ArchivedImport;
  insertedRows: number;
  bizDates: string[];
}

export async function importCsvFile(opts: {
  kind: SourceKind;
  fileName: string;
  csvText: string;
  mapping: FieldMapping;
}): Promise<ImportOutcome> {
  const eng = DuckEngine.get();
  await eng.ready;
  const { kind, fileName, csvText, mapping } = opts;
  const cfg = SOURCE_CONFIGS[kind];
  const parsed = parseCsvText(csvText);

  const id = `imp_${Date.now()}_${Math.floor(performance.now() * 1000)}`;
  const loadTs = new Date().toISOString();
  const { rows } = await eng.importCsv({
    config: cfg,
    csvText,
    mapping,
    csvColumns: parsed.columns,
    batchId: id,
    loadTs,
  });

  // 收集业务日期分区（迟到回补用）
  let bizDates: string[] = [];
  if (cfg.bizDateField) {
    const srcCol = mapping[cfg.bizDateField];
    const set = new Set<string>();
    for (const r of parsed.rows) {
      const v = (r[srcCol] ?? '').trim();
      if (v) set.add(v.slice(0, 10));
    }
    bizDates = [...set].sort();
  }

  const record: ArchivedImport = {
    id,
    fileName,
    kind,
    rowCount: parsed.rows.length,
    mapping,
    importedAt: loadTs,
    bizDates,
    csvText,
  };
  await idb.putImport(record);
  return { record, insertedRows: rows, bizDates };
}

/** 启动时从 IndexedDB 重放全部归档 CSV（幂等：清空 ODS 后按批次顺序重灌） */
export async function replayImports(
  onStep?: (msg: string) => void,
): Promise<ArchivedImport[]> {
  const eng = DuckEngine.get();
  await eng.ready;
  const archives = await idb.listImports();
  if (!archives.length) return [];

  for (const table of Object.values(SOURCE_CONFIGS).map((c) => c.odsTable)) {
    await eng.execScript(`DELETE FROM ${table}`);
  }
  for (const a of archives) {
    onStep?.(`重放 ${a.fileName}`);
    const cfg = SOURCE_CONFIGS[a.kind];
    const parsed = parseCsvText(a.csvText);
    await eng.importCsv({
      config: cfg,
      csvText: a.csvText,
      mapping: a.mapping,
      csvColumns: parsed.columns,
      batchId: a.id,
      loadTs: a.importedAt,
    });
  }
  return archives;
}

/** 清空所有数据（ODS + 派生层 + 归档） */
export async function purgeAll(): Promise<void> {
  const eng = DuckEngine.get();
  await eng.ready;
  const tables = [
    'ods_store', 'ods_product', 'ods_pos', 'ods_purchase', 'ods_transfer', 'ods_stock',
    'dwd_dim_store', 'dwd_dim_product', 'dwd_fact_pos', 'dwd_fact_purchase',
    'dwd_fact_transfer', 'dwd_fact_stock', 'dws_sales_d', 'dws_inv_balance_d',
    'ads_store_metrics_d', 'ads_store_metrics', 'ads_product_metrics', 'ads_kpi',
    'dwd_reject_record', 'dq_blocked_partition', 'dq_rule_result', 'etl_task_run',
  ];
  for (const t of tables) {
    if (await eng.tableExists(t)) await eng.execScript(`DELETE FROM ${t}`);
  }
  const archives = await idb.listImports();
  for (const a of archives) await idb.deleteImport(a.id);
}

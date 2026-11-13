/**
 * DuckDB-WASM 引擎单例：
 * - 纯浏览器内存计算，worker 线程执行，不阻塞 UI
 * - 多语句脚本切分（尊重引号与注释）
 * - CSV 经 registerFileText 注册虚拟文件后用 read_csv_auto(all_varchar) 贴源入库
 */
import * as duckdb from '@duckdb/duckdb-wasm';
import ehWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import EhWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?worker';
import type { FieldMapping, SourceConfig } from '../types';

let instance: DuckEngine | null = null;

export class DuckEngine {
  db!: duckdb.AsyncDuckDB;
  private conn!: duckdb.AsyncDuckDBConnection;
  ready: Promise<void>;

  private constructor() {
    this.ready = this.init();
  }

  static get(): DuckEngine {
    if (!instance) instance = new DuckEngine();
    return instance;
  }

  private async init() {
    const worker = new EhWorker();
    this.db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
    await this.db.instantiate(ehWasmUrl);
    this.conn = await this.db.connect();
    // 测试/排查用句柄（不影响生产逻辑）
    if (typeof window !== 'undefined') (window as unknown as { __duck: DuckEngine }).__duck = this;
  }

  /** 切分 SQL 脚本：按分号拆分，跳过单引号字符串与 -- 行注释 */
  splitStatements(script: string): string[] {
    const stmts: string[] = [];
    let buf = '';
    let inStr = false;
    let i = 0;
    const s = script;
    while (i < s.length) {
      const ch = s[i];
      const next = s[i + 1];
      if (!inStr && ch === '-' && next === '-') {
        let j = i;
        while (j < s.length && s[j] !== '\n') j++;
        buf += s.slice(i, j);
        i = j;
        continue;
      }
      if (ch === "'") {
        // SQL 转义单引号 '' 作为字面量字符，不切换字符串状态
        if (inStr && s[i + 1] === "'") {
          buf += "''";
          i += 2;
          continue;
        }
        inStr = !inStr;
        buf += ch;
        i++;
        continue;
      }
      if (!inStr && ch === ';') {
        if (buf.trim()) stmts.push(buf.trim());
        buf = '';
        i++;
        continue;
      }
      buf += ch;
      i++;
    }
    if (buf.trim()) stmts.push(buf.trim());
    return stmts;
  }

  /** 执行多语句脚本，返回最后一条语句影响行数（无结果集时为 0） */
  async execScript(script: string): Promise<number> {
    await this.ready;
    const stmts = this.splitStatements(script);
    let affected = 0;
    for (const stmt of stmts) {
      const r = await this.conn.query(stmt);
      affected = r.numRows;
      (r as { delete?: () => void }).delete?.();
    }
    return affected;
  }

  /** 查询并转成普通 JS 对象数组（bigint/Date 做 JSON 安全转换） */
  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    await this.ready;
    const table = await this.conn.query(sql);
    const rows = table.toArray().map((row) => {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(row)) {
        const v = (row as Record<string, unknown>)[k];
        out[k] = jsonSafe(v);
      }
      return out as T;
    });
    (table as { delete?: () => void }).delete?.();
    return rows;
  }

  async queryOne<T = Record<string, unknown>>(sql: string): Promise<T | null> {
    const rows = await this.query<T>(sql);
    return rows[0] ?? null;
  }

  async tableExists(name: string): Promise<boolean> {
    const r = await this.queryOne<{ c: bigint }>(
      `SELECT count(*) AS c FROM information_schema.tables WHERE table_name = '${name}'`,
    );
    return Number(r?.c ?? 0) > 0;
  }

  async rowCount(table: string, where = ''): Promise<number> {
    if (!(await this.tableExists(table))) return 0;
    const r = await this.queryOne<{ c: bigint }>(`SELECT count(*) AS c FROM ${table} ${where}`);
    return Number(r?.c ?? 0);
  }

  async tableColumns(table: string): Promise<{ name: string; type: string }[]> {
    return this.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = '${table}' ORDER BY ordinal_position`,
    ).then((rs) => rs.map((r) => ({ name: r.column_name, type: r.data_type })));
  }

  /**
   * CSV 贴源入库（幂等可重放）：
   * 1. 注册虚拟文件  2. all_varchar 读入，按字段映射选择列  3. 带批次与加载时间入 ODS
   */
  async importCsv(opts: {
    config: SourceConfig;
    csvText: string;
    mapping: FieldMapping;
    csvColumns: string[];
    batchId: string;
    loadTs: string;
  }): Promise<{ rows: number }> {
    await this.ready;
    const { config, csvText, mapping, csvColumns, batchId, loadTs } = opts;
    const missing = config.standardFields
      .map((f) => mapping[f.name])
      .filter((col) => col && !csvColumns.includes(col));
    if (missing.length) {
      throw new Error(`CSV 缺少映射列：${missing.join('、')}（实际列：${csvColumns.join(', ')}）`);
    }
    const vfile = `import_${batchId}.csv`;
    await this.db.registerFileText(vfile, csvText);
    const selectCols = config.standardFields
      .map((f) => {
        const src = mapping[f.name];
        const quoted = `"${String(src).replaceAll('"', '""')}"`;
        return `${quoted} AS ${f.name}`;
      })
      .join(', ');
    const targetCols = [
      ...config.standardFields.map((f) => f.name),
      'load_batch',
      'load_ts',
    ].join(', ');
    const sql = `INSERT INTO ${config.odsTable} (${targetCols})
      SELECT ${selectCols}, '${batchId}', TIMESTAMP '${loadTs.replace('T', ' ').slice(0, 19)}'
      FROM read_csv_auto('${vfile}', header=true, all_varchar=true)`;
    await this.execScript(sql);
    const rows = await this.rowCount(config.odsTable, `WHERE load_batch = '${batchId}'`);
    try {
      await this.db.dropFile(vfile);
    } catch {
      /* 虚拟文件清理失败可忽略 */
    }
    return { rows };
  }

  async terminate() {
    await this.conn?.close();
    await this.db?.terminate();
    instance = null;
  }
}

function jsonSafe(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    // Arrow Decimal 等可能以字节视图返回
    return Number(v);
  }
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = jsonSafe(val);
    return o;
  }
  return v;
}

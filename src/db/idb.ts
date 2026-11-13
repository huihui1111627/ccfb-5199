/**
 * IndexedDB 持久化：浏览器关闭后数据不丢。
 * 存原始 CSV 文本 + 导入元数据、自定义 SQL、规则配置、运行历史。
 * DuckDB 本身为内存库，启动时按归档 CSV 自动重放入库（幂等）。
 */
import type { FieldMapping, ImportRecord, QualityRule, RunContext, SourceKind } from '../types';
import { DEFAULT_QUALITY_RULES } from '../model/sql-templates';

const DB_NAME = 'pharmacy-dw';
const DB_VERSION = 1;
const STORE = {
  csv: 'csv_archive', // key: importId, value: { import record + csvText + mapping + kind }
  rules: 'rules', // key: 'current'
  taskSql: 'task_sql', // key: taskId, value: customized sql
  runs: 'runs', // key: runId
  kv: 'kv', // generic
};

export interface ArchivedImport extends ImportRecord {
  csvText: string;
  mapping: FieldMapping;
  kind: SourceKind;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORE)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
        t.onerror = () => reject(t.error);
      }),
  );
}

export const idb = {
  async putImport(rec: ArchivedImport): Promise<void> {
    await tx(STORE.csv, 'readwrite', (s) => s.put(rec, rec.id));
  },
  async deleteImport(id: string): Promise<void> {
    await tx(STORE.csv, 'readwrite', (s) => s.delete(id));
  },
  async listImports(): Promise<ArchivedImport[]> {
    const all = await tx(STORE.csv, 'readonly', (s) => s.getAll());
    return (all as ArchivedImport[]).sort((a, b) => a.importedAt.localeCompare(b.importedAt));
  },

  async saveRules(rules: QualityRule[]): Promise<void> {
    await tx(STORE.rules, 'readwrite', (s) => s.put(rules, 'current'));
  },
  async loadRules(): Promise<QualityRule[] | null> {
    const v = await tx(STORE.rules, 'readonly', (s) => s.get('current'));
    return (v as QualityRule[]) ?? null;
  },

  async saveTaskSql(taskId: string, sql: string): Promise<void> {
    await tx(STORE.taskSql, 'readwrite', (s) => s.put(sql, taskId));
  },
  async loadAllTaskSql(): Promise<Record<string, string>> {
    return ((await tx(STORE.taskSql, 'readonly', (s) => s.getAll())) as string[]).length
      ? Object.fromEntries(
          await new Promise<[string, string][]>((resolve) =>
            openDb().then((db) => {
              const t = db.transaction(STORE.taskSql, 'readonly');
              const req = t.objectStore(STORE.taskSql).getAllKeys();
              req.onsuccess = () => {
                const keys = req.result as string[];
                const req2 = t.objectStore(STORE.taskSql).getAll();
                req2.onsuccess = () => {
                  resolve(keys.map((k, i) => [k, req2.result[i]]));
                  db.close();
                };
              };
            }),
          ),
        )
      : {};
  },
  async resetTaskSql(taskId: string): Promise<void> {
    await tx(STORE.taskSql, 'readwrite', (s) => s.delete(taskId));
  },

  async saveRun(run: RunContext): Promise<void> {
    await tx(STORE.runs, 'readwrite', (s) => s.put(run, run.runId));
  },
  async listRuns(): Promise<RunContext[]> {
    const all = (await tx(STORE.runs, 'readonly', (s) => s.getAll())) as RunContext[];
    return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20);
  },
};

export function defaultRules(): QualityRule[] {
  return DEFAULT_QUALITY_RULES.map((r) => ({
    id: r.id,
    name: r.name,
    layer: r.layer,
    table: r.table,
    severity: r.severity,
    enabled: r.enabled,
    desc: r.desc,
    checkSql: r.checkSql,
  }));
}

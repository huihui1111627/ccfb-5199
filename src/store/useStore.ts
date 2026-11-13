import { create } from 'zustand';
import { DuckEngine } from '../db/duckdb';
import { idb, defaultRules, type ArchivedImport } from '../db/idb';
import { DDL_SQL } from '../model/sql-templates';
import { replayImports, importCsvFile, purgeAll, type ImportOutcome } from '../services/import';
import { runDAG } from '../pipeline/scheduler';
import type { QualityRule, RunContext, SourceKind, TaskRun } from '../types';

interface AppState {
  booting: boolean;
  bootMsg: string;
  engineReady: boolean;
  imports: ArchivedImport[];
  rules: QualityRule[];
  taskSqlOverrides: Record<string, string>;
  lastRun: RunContext | null;
  runHistory: RunContext[];
  running: boolean;
  toast: { kind: 'ok' | 'err'; text: string } | null;

  init: () => Promise<void>;
  showToast: (kind: 'ok' | 'err', text: string) => void;
  refreshImports: () => Promise<void>;
  doImport: (p: { kind: SourceKind; fileName: string; csvText: string; mapping: Record<string, string> }) => Promise<ImportOutcome | null>;
  doPurge: () => Promise<void>;
  saveRules: (rules: QualityRule[]) => Promise<void>;
  saveTaskSql: (taskId: string, sql: string) => Promise<void>;
  resetTaskSql: (taskId: string) => Promise<void>;
  runPipeline: (mode: 'full' | 'backfill', fromDate?: string | null) => Promise<void>;
}

export const useStore = create<AppState>((set, get) => ({
  booting: true,
  bootMsg: '初始化 DuckDB-WASM 引擎…',
  engineReady: false,
  imports: [],
  rules: defaultRules(),
  taskSqlOverrides: {},
  lastRun: null,
  runHistory: [],
  running: false,
  toast: null,

  init: async () => {
    try {
      const eng = DuckEngine.get();
      await eng.ready;
      await eng.execScript(DDL_SQL);
      set({ engineReady: true });

      const [savedRules, overrides, history] = await Promise.all([
        idb.loadRules(),
        idb.loadAllTaskSql(),
        idb.listRuns(),
      ]);
      set({
        rules: savedRules ?? defaultRules(),
        taskSqlOverrides: overrides ?? {},
        runHistory: history,
      });

      set({ bootMsg: '从浏览器本地存储重放历史导入…' });
      const archives = await replayImports((msg) => set({ bootMsg: msg }));
      set({ imports: archives });

      if (archives.length) {
        set({ bootMsg: '重放完成，自动执行全量 DAG…' });
        await get().runPipeline('full');
      }
      set({ booting: false, bootMsg: '' });
    } catch (e) {
      set({ booting: false, bootMsg: '', toast: { kind: 'err', text: `初始化失败：${fmtErr(e)}` } });
    }
  },

  showToast: (kind, text) => {
    set({ toast: { kind, text } });
    setTimeout(() => set({ toast: null as never }), 4200);
  },

  refreshImports: async () => set({ imports: await idb.listImports() }),

  doImport: async ({ kind, fileName, csvText, mapping }) => {
    try {
      const outcome = await importCsvFile({ kind, fileName, csvText, mapping });
      await get().refreshImports();
      get().showToast('ok', `已入库 ${outcome.insertedRows} 行：${fileName}`);
      return outcome;
    } catch (e) {
      get().showToast('err', `导入失败：${fmtErr(e)}`);
      return null;
    }
  },

  doPurge: async () => {
    await purgeAll();
    set({ imports: [], lastRun: null });
    get().showToast('ok', '已清空 ODS 与全部派生层数据');
  },

  saveRules: async (rules) => {
    await idb.saveRules(rules);
    set({ rules });
  },

  saveTaskSql: async (taskId, sql) => {
    await idb.saveTaskSql(taskId, sql);
    set((s) => ({ taskSqlOverrides: { ...s.taskSqlOverrides, [taskId]: sql } }));
  },

  resetTaskSql: async (taskId) => {
    await idb.resetTaskSql(taskId);
    set((s) => {
      const next = { ...s.taskSqlOverrides };
      delete next[taskId];
      return { taskSqlOverrides: next };
    });
  },

  runPipeline: async (mode, fromDate = null) => {
    if (get().running) return;
    set({ running: true });
    try {
      const ctx = await runDAG({
        mode,
        fromDate,
        rules: get().rules,
        overrides: get().taskSqlOverrides,
        resumeFrom: get().lastRun,
        onProgress: (taskRuns: TaskRun[]) => {
          const cur = get().lastRun;
          if (cur) set({ lastRun: { ...cur, taskRuns } });
        },
      });
      set((s) => ({
        lastRun: ctx,
        runHistory: [ctx, ...s.runHistory.filter((r) => r.runId !== ctx.runId)].slice(0, 20),
      }));
      if (ctx.status === 'success') {
        get().showToast('ok', mode === 'backfill' ? `回补完成（>= ${fromDate}）` : '全量 DAG 运行成功');
      } else {
        const failed = ctx.taskRuns.find((t) => t.status === 'failed');
        get().showToast('err', `任务失败：${failed?.taskId} —— ${failed?.message ?? ''}`);
      }
    } catch (e) {
      get().showToast('err', `调度失败：${fmtErr(e)}`);
    } finally {
      set({ running: false });
    }
  },
}));

function fmtErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

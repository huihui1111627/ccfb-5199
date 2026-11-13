// 全局类型定义

/** 数据源类型 */
export type SourceKind = 'store' | 'product' | 'pos' | 'purchase' | 'transfer' | 'stock';

/** 字段映射：源 CSV 列名 -> 标准字段名 */
export type FieldMapping = Record<string, string>;

export interface SourceConfig {
  kind: SourceKind;
  label: string;
  /** 该数据源的标准字段 */
  standardFields: { name: string; type: 'VARCHAR' | 'INTEGER' | 'DOUBLE' | 'DATE'; desc: string }[];
  /** 默认字段映射（标准字段 -> 源列名），可在 UI 改 */
  defaultMapping: FieldMapping;
  /** ODS 目标表名 */
  odsTable: string;
  /** 业务日期字段（标准字段名），用于分区回补 */
  bizDateField: string | null;
  /** 业务主键字段（标准字段名），用于去重 */
  bizKey: string[];
}

export interface ImportRecord {
  id: string;
  fileName: string;
  kind: SourceKind;
  rowCount: number;
  mapping: FieldMapping;
  importedAt: string;
  /** 本次导入涉及的业务日期分区 */
  bizDates: string[];
}

export type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface TaskRun {
  taskId: string;
  status: TaskStatus;
  startedAt: string | null;
  finishedAt: string | null;
  rowsAffected: number;
  message: string;
}

export type Severity = 'block' | 'warn';

export interface QualityRule {
  id: string;
  name: string;
  layer: 'ods' | 'dwd' | 'dws';
  /** 作用的表 */
  table: string;
  severity: Severity;
  enabled: boolean;
  desc: string;
  /** 失败样本查询：返回 fail_count 与前 N 条样例 */
  checkSql: string;
}

export interface QualityResult {
  ruleId: string;
  ruleName: string;
  table: string;
  severity: Severity;
  passed: boolean;
  failCount: number;
  samples: Record<string, unknown>[];
  checkedAt: string;
  /** 阻断型规则失败时，关联的业务分区（store_id, biz_date），用于下游隔离 */
  blockedPartitions: { store_id: string; biz_date: string }[];
}

export interface DAGNode {
  id: string;
  label: string;
  layer: 'ODS' | 'DWD' | 'DWS' | 'ADS' | 'DQ' | 'SRC';
  deps: string[];
  /** 是否按业务日期分区执行（回补单元） */
  partitioned: boolean;
}

export interface RunContext {
  runId: string;
  startedAt: string;
  mode: 'full' | 'backfill';
  /** 回补起始业务日期（null 表示全量） */
  fromDate: string | null;
  taskRuns: TaskRun[];
  status: 'running' | 'success' | 'failed';
}

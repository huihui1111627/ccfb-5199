/**
 * 数据质量引擎：
 * - 每条规则的 checkSql 返回"失败行"；引擎统一计数、取样例、抽取 (store_id, biz_date) 分区
 * - block 级规则失败 -> 重建 dq_blocked_partition；下游 ADS 只认通过分区
 * - warn 级只记录不阻断
 * - 每次运行整体重建结果表与阻断表，天然幂等
 */
import { DuckEngine } from '../db/duckdb';
import type { QualityResult, QualityRule } from '../types';

export async function runQuality(rules: QualityRule[], runId: string): Promise<QualityResult[]> {
  const eng = DuckEngine.get();
  await eng.ready;

  await eng.execScript(`DELETE FROM dq_rule_result WHERE run_id = '${runId}';
    DELETE FROM dq_blocked_partition;`);

  const results: QualityResult[] = [];
  const blockSelects: string[] = [];
  const checkedAt = new Date().toISOString();

  for (const rule of rules) {
    if (!rule.enabled) continue;
    let failCount = 0;
    let samples: Record<string, unknown>[] = [];
    let blockedPartitions: { store_id: string; biz_date: string }[] = [];
    let error: string | null = null;

    try {
      const countRow = await eng.queryOne<{ c: number }>(
        `SELECT count(*) AS c FROM (${rule.checkSql}) AS q`,
      );
      failCount = Number(countRow?.c ?? 0);

      if (failCount > 0) {
        samples = await eng.query(`SELECT * FROM (${rule.checkSql}) AS q LIMIT 100`);
        blockedPartitions = await eng
          .query<{ store_id: string | null; biz_date: string | null }>(
            `SELECT DISTINCT store_id, biz_date FROM (${rule.checkSql}) AS q
             WHERE store_id IS NOT NULL AND biz_date IS NOT NULL`,
          )
          .then((rs) =>
            rs.map((r) => ({ store_id: String(r.store_id), biz_date: String(r.biz_date) })),
          );
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      failCount = -1; // -1 表示规则本身执行出错
      samples = [{ error: error ?? '规则执行异常' }];
    }

    const passed = failCount === 0;
    results.push({
      ruleId: rule.id,
      ruleName: rule.name,
      table: rule.table,
      severity: rule.severity,
      passed,
      failCount,
      samples,
      checkedAt,
      blockedPartitions: rule.severity === 'block' ? blockedPartitions : [],
    });

    await eng.execScript(`INSERT INTO dq_rule_result VALUES (
      '${rule.id}', '${rule.name.replaceAll("'", "''")}', '${rule.layer}', '${rule.table}',
      '${rule.severity}', ${passed}, ${failCount < 0 ? 0 : failCount},
      current_timestamp, '${runId}')`);

    if (!passed && rule.severity === 'block' && failCount > 0) {
      blockSelects.push(
        `SELECT DISTINCT store_id, biz_date, '${rule.id}' AS rule_id,
                '${rule.name.replaceAll("'", "''")}' AS reason
         FROM (${rule.checkSql}) AS q
         WHERE store_id IS NOT NULL AND biz_date IS NOT NULL`,
      );
    }
  }

  if (blockSelects.length) {
    await eng.execScript(
      `INSERT INTO dq_blocked_partition
       SELECT store_id, biz_date, rule_id, reason, current_timestamp
       FROM (${blockSelects.join('\nUNION ALL\n')})`,
    );
  }

  return results;
}

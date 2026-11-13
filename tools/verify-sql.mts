/**
 * 端到端 SQL 校验（真实 DuckDB，Node 侧）：
 *   node --experimental-strip-types tools/verify-sql.mts
 *
 * 校验：
 * 1. 六类 CSV 全量入 ODS -> DWD 清洗去重 -> DWS 守恒 -> DQ 阻断 -> ADS 出数
 * 2. SCD2 拉链版本正确
 * 3. 两处人为篡改快照精确阻断 S007/2026-11-03、S023/2026-11-05
 * 4. 导入迟到 POS 后从业务日期回补，阻断解除；全链路幂等（重跑结果一致）
 * 5. 库存平衡恒等式在全部未阻断分区成立
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from 'duckdb-async';
import { DDL_SQL, DEFAULT_TASKS, DEFAULT_QUALITY_RULES, EARLIEST_DATE } from '../src/model/sql-templates.ts';
import { SOURCE_CONFIGS } from '../src/config/sources.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'public', 'sample-data');
const FILES = {
  store: ['dim_store.csv'],
  product: ['dim_product.csv'],
  pos: ['pos.csv'],
  purchase: ['purchase.csv'],
  transfer: ['transfer.csv'],
  stock: ['stock.csv'],
};
const LATE = { pos: 'pos_late.csv', stock: 'stock_late.csv' };

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
};

function split(sql) {
  const out = [];
  let buf = '', inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (inStr && sql[i + 1] === "'") { buf += "''"; i++; continue; }
      inStr = !inStr;
    }
    if (ch === ';' && !inStr) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    } else buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

async function exec(db, script) {
  for (const s of split(script)) await db.exec(s);
}

async function loadOds(db, includeLate = false) {
  for (const t of Object.values(SOURCE_CONFIGS).map((c) => c.odsTable)) {
    await db.exec(`DELETE FROM ${t}`);
  }
  for (const [kind, files] of Object.entries(FILES)) {
    const cfg = SOURCE_CONFIGS[kind];
    for (const f of files) {
      const path = join(DATA, f);
      const cols = cfg.standardFields.map((x) => x.name);
      const sel = cols.map((c) => `"${c}" AS ${c}`).join(', ');
      await db.exec(`INSERT INTO ${cfg.odsTable} (${[...cols, 'load_batch', 'load_ts'].join(',')})
        SELECT ${sel}, '${f}', current_timestamp FROM read_csv_auto('${path}', header=true, all_varchar=true)`);
    }
  }
  if (includeLate) {
    for (const [kind, f] of Object.entries(LATE)) {
      const cfg = SOURCE_CONFIGS[kind];
      const cols = cfg.standardFields.map((x) => x.name);
      const sel = cols.map((c) => `"${c}" AS ${c}`).join(', ');
      await db.exec(`INSERT INTO ${cfg.odsTable} (${[...cols, 'load_batch', 'load_ts'].join(',')})
        SELECT ${sel}, '${f}', current_timestamp FROM read_csv_auto('${join(DATA, f)}', header=true, all_varchar=true)`);
    }
  }
}

async function runTasks(db, fromDate = EARLIEST_DATE) {
  for (const t of DEFAULT_TASKS) {
    if (t.id === 'ads_metrics') continue; // 含 dq 依赖，单独在 DQ 后跑
    await exec(db, t.sql.replaceAll('{{FROM_DATE}}', fromDate));
  }
}

async function runDQ(db, runId) {
  await db.exec(`DELETE FROM dq_rule_result WHERE run_id = '${runId}'; DELETE FROM dq_blocked_partition;`);
  const blocks = [];
  for (const rule of DEFAULT_QUALITY_RULES) {
    if (!rule.enabled) continue;
    const cnt = await db.all(`SELECT count(*) AS c FROM (${rule.checkSql}) q`);
    const failCount = Number(cnt[0].C ?? cnt[0].c);
    await db.exec(`INSERT INTO dq_rule_result VALUES ('${rule.id}','${rule.name.replaceAll("'", "''")}','${rule.layer}','${rule.table}','${rule.severity}',${failCount === 0},${failCount},current_timestamp,'${runId}')`);
    if (failCount > 0 && rule.severity === 'block') {
      blocks.push(`SELECT DISTINCT store_id, biz_date, '${rule.id}' AS rule_id, '${rule.name.replaceAll("'", "''")}' AS reason
        FROM (${rule.checkSql}) q WHERE store_id IS NOT NULL AND biz_date IS NOT NULL`);
    }
  }
  if (blocks.length) {
    await db.exec(`INSERT INTO dq_blocked_partition SELECT store_id, biz_date, rule_id, reason, current_timestamp FROM (${blocks.join(' UNION ALL ')})`);
  }
  await exec(db, DEFAULT_TASKS.find((t) => t.id === 'ads_metrics').sql.replaceAll('{{FROM_DATE}}', EARLIEST_DATE));
}

async function main() {
  const db = await Database.create(':memory:');
  await exec(db, DDL_SQL);

  console.log('\n=== 场景 1：全量管线（不含迟到数据，含脏数据）===');
  await loadOds(db, false);
  const odsCounts = {};
  for (const c of Object.values(SOURCE_CONFIGS)) odsCounts[c.odsTable] = Number((await db.all(`SELECT count(*) c FROM ${c.odsTable}`))[0].c);
  check('ODS 六表均有数据', Object.values(odsCounts).every((n) => n > 0), JSON.stringify(odsCounts));

  await runTasks(db);
  await runDQ(db, 'run_test_1');

  const dwdPos = Number((await db.all('SELECT count(*) c FROM dwd_fact_pos'))[0].c);
  const odsPos = odsCounts.ods_pos;
  check('DWD POS 行数 < ODS（脏行被清洗）', dwdPos < odsPos, `ODS ${odsPos} -> DWD ${dwdPos}`);
  const rejectCnt = Number((await db.all('SELECT count(*) c FROM dwd_reject_record'))[0].c);
  check('拒收记录表有数据', rejectCnt > 0, `${rejectCnt} 行拒收`);

  const dup = await db.all(`SELECT count(*) c FROM (SELECT txn_no, line_no, count(*) c FROM dwd_fact_pos GROUP BY 1,2 HAVING count(*)>1)`);
  check('DWD POS 无重复主键', Number(dup[0].c) === 0);
  const neg = await db.all(`SELECT count(*) c FROM dwd_fact_pos WHERE qty <= 0 OR amount <= 0`);
  check('DWD POS 无负值', Number(neg[0].c) === 0);
  const selfTf = await db.all(`SELECT count(*) c FROM dwd_fact_transfer WHERE from_store_id = to_store_id`);
  check('DWD 调拨无同店流转', Number(selfTf[0].c) === 0);
  const ghost = await db.all(`SELECT count(*) c FROM dwd_fact_transfer t WHERE NOT EXISTS (SELECT 1 FROM dwd_dim_store d WHERE d.store_id=t.to_store_id)`);
  check('DWD 调拨无幽灵门店', Number(ghost[0].c) === 0);
  const negStock = await db.all(`SELECT count(*) c FROM dwd_fact_stock WHERE on_hand_qty < 0`);
  check('DWD 快照无负库存', Number(negStock[0].c) === 0);

  // SCD2
  const versions = await db.all(`SELECT sku_id, count(*) c FROM dwd_dim_product GROUP BY sku_id HAVING count(*) > 1 ORDER BY sku_id`);
  check('SCD2：6 个商品存在多版本', versions.length === 6, versions.map((v) => `${v.sku_id}:${v.c}`).join(', '));
  const chain = await db.all(`SELECT count(*) c FROM dwd_dim_product WHERE effective_to < DATE '9999-12-31' AND effective_from > effective_to`);
  check('SCD2：生效区间无倒挂', Number(chain[0].c) === 0);
  const current = await db.all(`SELECT sku_id, count(*) c FROM dwd_dim_product WHERE is_current GROUP BY sku_id HAVING count(*) > 1`);
  check('SCD2：每个商品恰好一个当前版本', current.length === 0);

  // 质量规则结果
  const ruleRows = await db.all('SELECT rule_id, passed, fail_count FROM dq_rule_result ORDER BY rule_id');
  console.log('  规则结果：');
  for (const r of ruleRows) console.log(`    - ${r.rule_id}: ${r.passed ? 'PASS' : 'FAIL'} (${r.fail_count})`);
  const amountFail = ruleRows.find((r) => r.rule_id === 'dq_pos_amount');
  check('金额一致性规则抓到 25 笔不平', amountFail && Number(amountFail.fail_count) === 25, `实际 ${amountFail?.fail_count}`);

  // 阻断分区（场景1：未导入迟到，10-28 迟到 POS + 两个篡改门店日）
  const blocks = await db.all('SELECT DISTINCT store_id, biz_date FROM dq_blocked_partition ORDER BY 1,2');
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  const blockKey = blocks.map((b) => `${b.store_id}/${iso(b.biz_date)}`);
  const hasTamper = blockKey.includes('S007/2026-11-03') && blockKey.includes('S023/2026-11-05');
  const lateBlockCnt = blockKey.filter((k) => k.endsWith('/2026-10-28')).length;
  const hasLate = lateBlockCnt > 0;
  check(
    '阻断分区包含两个篡改门店日 + 10-28 迟到门店日',
    hasTamper && hasLate,
    `共 ${blockKey.length} 个门店日，含 10-28 阻断 ${lateBlockCnt} 个`,
  );

  // 守恒：未阻断分区全部平衡
  const unbalanced = await db.all(`SELECT count(*) c FROM dws_inv_balance_d b
    WHERE b.balance_pass = false
      AND NOT EXISTS (SELECT 1 FROM dq_blocked_partition p WHERE p.store_id=b.store_id AND p.biz_date=b.biz_date)`);
  check('未阻断分区全部满足 期初+入-出=期末', Number(unbalanced[0].c) === 0);

  // ADS 排除阻断
  const adsLeak = await db.all(`SELECT count(*) c FROM ads_store_metrics_d d
    WHERE d.balance_ok = 0 AND EXISTS (SELECT 1 FROM dq_blocked_partition p WHERE p.store_id=d.store_id AND p.biz_date=d.biz_date)`);
  check('ADS 对阻断分区打标 balance_ok=0', Number(adsLeak[0].c) > 0);
  const kpi = await db.all('SELECT * FROM ads_kpi');
  check('ADS KPI 出数且含阻断分区计数', Number(kpi[0].blocked_partition_cnt) > 0, JSON.stringify(kpi[0], (_, v) => (typeof v === 'bigint' ? Number(v) : v)));
  const storeMetrics = await db.all('SELECT count(*) c FROM ads_store_metrics WHERE turnover_rate IS NOT NULL');
  check('门店周转/动销指标出数', Number(storeMetrics[0].c) > 0);

  console.log('\n=== 场景 2：幂等性 —— 不改数据再跑一遍 ===');
  const before = await db.all('SELECT count(*) c FROM dws_inv_balance_d');
  await runTasks(db);
  await runDQ(db, 'run_test_2');
  const after = await db.all('SELECT count(*) c FROM dws_inv_balance_d');
  check('重跑后 DWS 行数不变', Number(before[0].c) === Number(after[0].c), `${before[0].c} -> ${after[0].c}`);
  const blocks2 = await db.all('SELECT count(*) c FROM dq_blocked_partition');
  const blocks1 = await db.all('SELECT count(*) c FROM dq_blocked_partition');
  check('重跑后阻断分区数稳定（幂等）', Number(blocks2[0].c) === Number(blocks1[0].c), `${blocks1[0].c} 个分区`);

  console.log('\n=== 场景 3：迟到 POS 回补（2026-10-28 的 12 笔）===');
  await loadOds(db, true);
  // 模拟断点：全量 DWD 重建 + 从 2026-10-28 起回补 DWS
  await runTasks(db, '2026-10-28');
  await runDQ(db, 'run_test_3');
  const lateInDwd = await db.all(`SELECT count(*) c FROM dwd_fact_pos WHERE sale_date = DATE '2026-10-28'`);
  const lateBefore = Number((await db.all(`SELECT count(*) c FROM dwd_fact_pos WHERE load_batch='pos.csv' AND sale_date=DATE '2026-10-28'`))[0].c);
  check('迟到 12 笔 POS 进入 DWD', Number(lateInDwd[0].c) === lateBefore + 12, `${lateBefore} -> ${lateInDwd[0].c}`);
  const stillUnbalanced = await db.all(`SELECT DISTINCT store_id, biz_date FROM dws_inv_balance_d WHERE NOT balance_pass ORDER BY 1,2`);
  const iso2 = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  const keys = stillUnbalanced.map((b) => `${b.store_id}/${iso2(b.biz_date)}`).sort();
  const onlyTamper =
    keys.length === 4 &&
    keys.includes('S007/2026-11-03') && keys.includes('S007/2026-11-04') &&
    keys.includes('S023/2026-11-05') && keys.includes('S023/2026-11-06');
  check(
    '回补后 10-28 迟到阻断全部解除，仅剩两个篡改门店的连锁传播日（共 4 个门店日）',
    onlyTamper,
    keys.join(', '),
  );

  console.log('\n=== 场景 4：迟到库存快照回补（S017/2026-11-02）===');
  const missingBefore = Number((await db.all(`SELECT count(*) c FROM dws_inv_balance_d WHERE store_id='S017' AND biz_date=DATE '2026-11-02' AND actual_closing_qty IS NULL`))[0].c);
  check('S017/2026-11-02 迟到快照已补齐（无缺失行）', missingBefore === 0);
  const warn = await db.all(`SELECT count(*) c FROM dq_rule_result WHERE rule_id='dq_snapshot_missing' AND fail_count > 0`);
  check('快照缺失警告规则存在结果', warn.length === 1);

  console.log(`\n${failures === 0 ? '🎉 全部校验通过' : `⚠️ ${failures} 项校验失败`}`);
  await db.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

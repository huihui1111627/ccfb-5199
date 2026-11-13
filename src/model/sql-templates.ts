/**
 * 数仓四层 SQL 模型（ODS / DWD / DWS / ADS）+ 数据质量规则默认定义
 *
 * 约定：
 * - 建表 DDL 固定；转换 SQL 以任务模板形式提供，可在「分层模型」页在线修改（localStorage 持久化，可恢复默认）
 * - 分区回占位符 {{FROM_DATE}}：全量运行为 1900-01-01，回补运行业务日期起点
 * - 所有任务天然幂等：CREATE OR REPLACE 或 DELETE 分区后 INSERT，重跑结果一致
 * - 本文件同时被 Node 侧 tools/verify-sql.mjs 复用做真实 DuckDB 校验
 */

export const EARLIEST_DATE = '1900-01-01';

/** 固定物理 Schema */
export const DDL_SQL = `
-- ============ ODS 贴源层（保留批次与加载时间） ============
CREATE TABLE IF NOT EXISTS ods_store (
  store_id VARCHAR, store_name VARCHAR, region VARCHAR, city VARCHAR,
  open_date VARCHAR, status VARCHAR, load_batch VARCHAR, load_ts TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ods_product (
  sku_id VARCHAR, sku_name VARCHAR, category VARCHAR, specification VARCHAR, unit VARCHAR,
  unit_cost VARCHAR, retail_price VARCHAR, manufacturer VARCHAR, is_active VARCHAR,
  effective_from VARCHAR, load_batch VARCHAR, load_ts TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ods_pos (
  txn_no VARCHAR, line_no VARCHAR, sale_date VARCHAR, store_id VARCHAR, sku_id VARCHAR,
  qty VARCHAR, unit_price VARCHAR, amount VARCHAR, unit_cost VARCHAR,
  load_batch VARCHAR, load_ts TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ods_purchase (
  po_no VARCHAR, biz_date VARCHAR, store_id VARCHAR, sku_id VARCHAR,
  qty VARCHAR, unit_cost VARCHAR, amount VARCHAR, load_batch VARCHAR, load_ts TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ods_transfer (
  transfer_no VARCHAR, biz_date VARCHAR, from_store_id VARCHAR, to_store_id VARCHAR,
  sku_id VARCHAR, qty VARCHAR, load_batch VARCHAR, load_ts TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ods_stock (
  snapshot_date VARCHAR, store_id VARCHAR, sku_id VARCHAR, on_hand_qty VARCHAR,
  load_batch VARCHAR, load_ts TIMESTAMP
);

-- ============ 元数据 / 质量 / 运维 ============
CREATE TABLE IF NOT EXISTS dwd_reject_record (
  source_table VARCHAR, biz_key VARCHAR, biz_date DATE, store_id VARCHAR,
  reason VARCHAR, detail VARCHAR, load_batch VARCHAR, rejected_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS dq_blocked_partition (
  store_id VARCHAR, biz_date DATE, rule_id VARCHAR, reason VARCHAR, detected_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS dq_rule_result (
  rule_id VARCHAR, rule_name VARCHAR, layer VARCHAR, table_name VARCHAR,
  severity VARCHAR, passed BOOLEAN, fail_count INTEGER,
  checked_at TIMESTAMP, run_id VARCHAR
);
CREATE TABLE IF NOT EXISTS etl_task_run (
  run_id VARCHAR, task_id VARCHAR, status VARCHAR, started_at TIMESTAMP,
  finished_at TIMESTAMP, rows_affected INTEGER, message VARCHAR
);
`;

export interface TaskTemplate {
  id: string;
  label: string;
  layer: 'DWD' | 'DWS' | 'ADS' | 'DQ';
  deps: string[];
  partitioned: boolean;
  desc: string;
  /** 输出表（用于行数统计） */
  outputTable: string | null;
  sql: string;
}

export const DEFAULT_TASKS: TaskTemplate[] = [
  // ---------------- DWD ----------------
  {
    id: 'dwd_dim_store',
    label: 'DWD-门店维度(SCD1)',
    layer: 'DWD',
    deps: [],
    partitioned: false,
    outputTable: 'dwd_dim_store',
    desc: '门店主数据去重取最新批次',
    sql: `CREATE OR REPLACE TABLE dwd_dim_store AS
WITH ranked AS (
  SELECT *, row_number() OVER (PARTITION BY store_id ORDER BY load_ts DESC, load_batch DESC) AS rn
  FROM ods_store WHERE NULLIF(TRIM(store_id), '') IS NOT NULL
)
SELECT store_id,
       store_name,
       region,
       city,
       TRY_CAST(open_date AS DATE) AS open_date,
       status
FROM ranked WHERE rn = 1;`,
  },
  {
    id: 'dwd_dim_product',
    label: 'DWD-商品拉链表(SCD2)',
    layer: 'DWD',
    deps: [],
    partitioned: false,
    outputTable: 'dwd_dim_product',
    desc: '按 effective_from 构建缓慢变化维拉链，保留全部历史版本',
    sql: `CREATE OR REPLACE TABLE dwd_dim_product AS
WITH ev AS (
  SELECT *, row_number() OVER (PARTITION BY sku_id, effective_from ORDER BY load_ts DESC) AS rn_ef
  FROM ods_product WHERE NULLIF(TRIM(sku_id), '') IS NOT NULL
),
cur AS (
  SELECT sku_id, sku_name, category, specification, unit, unit_cost, retail_price,
         manufacturer, is_active, TRY_CAST(effective_from AS DATE) AS effective_from
  FROM ev WHERE rn_ef = 1
),
scd AS (
  SELECT *, lead(effective_from) OVER (PARTITION BY sku_id ORDER BY effective_from) AS next_from
  FROM cur
)
SELECT sku_id || '#' || effective_from AS product_sk,
       sku_id, sku_name, category, specification, unit,
       TRY_CAST(unit_cost AS DOUBLE)  AS unit_cost,
       TRY_CAST(retail_price AS DOUBLE) AS retail_price,
       manufacturer,
       TRY_CAST(is_active AS INTEGER) AS is_active,
       effective_from,
       COALESCE(next_from - INTERVAL 1 DAY, DATE '9999-12-31') AS effective_to,
       next_from IS NULL AS is_current
FROM scd;`,
  },
  {
    id: 'dwd_fact_pos',
    label: 'DWD-POS销售明细(清洗去重)',
    layer: 'DWD',
    deps: [],
    partitioned: false,
    outputTable: 'dwd_fact_pos',
    desc: '主键去重、类型转换、空值/负值拦截，拒收行写入 dwd_reject_record',
    sql: `CREATE OR REPLACE TABLE dwd_fact_pos AS
WITH src AS (
  SELECT *, row_number() OVER (PARTITION BY txn_no, line_no ORDER BY load_ts DESC) AS rn_dup
  FROM ods_pos
),
typed AS (
  SELECT txn_no, line_no,
         TRY_CAST(sale_date AS DATE)  AS sale_date,
         NULLIF(TRIM(store_id), '')   AS store_id,
         NULLIF(TRIM(sku_id), '')     AS sku_id,
         TRY_CAST(qty AS INTEGER)     AS qty,
         TRY_CAST(unit_price AS DOUBLE) AS unit_price,
         TRY_CAST(amount AS DOUBLE)   AS amount,
         TRY_CAST(unit_cost AS DOUBLE) AS unit_cost,
         load_batch, load_ts, rn_dup
  FROM src
)
SELECT txn_no, line_no, sale_date, store_id, sku_id, qty, unit_price, amount, unit_cost, load_batch, load_ts
FROM typed
WHERE rn_dup = 1
  AND NULLIF(TRIM(txn_no), '') IS NOT NULL
  AND sale_date IS NOT NULL AND store_id IS NOT NULL AND sku_id IS NOT NULL
  AND qty IS NOT NULL AND qty > 0
  AND amount IS NOT NULL AND amount > 0
  AND abs(amount - qty * unit_price) <= 0.02;

DELETE FROM dwd_reject_record WHERE source_table = 'ods_pos';
INSERT INTO dwd_reject_record
SELECT 'ods_pos',
       COALESCE(txn_no, '?') || '/' || COALESCE(line_no, '?'),
       TRY_CAST(sale_date AS DATE),
       NULLIF(TRIM(store_id), ''),
       CASE
         WHEN rn_dup > 1 THEN '重复流水'
         WHEN NULLIF(TRIM(txn_no), '') IS NULL THEN '交易单号为空'
         WHEN TRY_CAST(sale_date AS DATE) IS NULL THEN '业务日期为空或非法'
         WHEN NULLIF(TRIM(store_id), '') IS NULL THEN '门店编码为空'
         WHEN NULLIF(TRIM(sku_id), '') IS NULL THEN '商品编码为空'
         WHEN TRY_CAST(qty AS INTEGER) IS NULL OR TRY_CAST(qty AS INTEGER) <= 0 THEN '销售数量为空或非正'
         WHEN TRY_CAST(amount AS DOUBLE) IS NULL OR TRY_CAST(amount AS DOUBLE) <= 0 THEN '销售金额为空或非正'
         WHEN abs(TRY_CAST(amount AS DOUBLE) - TRY_CAST(qty AS INTEGER) * TRY_CAST(unit_price AS DOUBLE)) > 0.02 THEN '金额对不平'
         ELSE '其他' END,
       'qty=' || COALESCE(qty, '∅') || ', amount=' || COALESCE(amount, '∅'),
       load_batch, current_timestamp
FROM (
  SELECT *, row_number() OVER (PARTITION BY txn_no, line_no ORDER BY load_ts DESC) AS rn_dup FROM ods_pos
)
WHERE rn_dup > 1
   OR NULLIF(TRIM(txn_no), '') IS NULL
   OR TRY_CAST(sale_date AS DATE) IS NULL
   OR NULLIF(TRIM(store_id), '') IS NULL
   OR NULLIF(TRIM(sku_id), '') IS NULL
   OR TRY_CAST(qty AS INTEGER) IS NULL OR TRY_CAST(qty AS INTEGER) <= 0
   OR TRY_CAST(amount AS DOUBLE) IS NULL OR TRY_CAST(amount AS DOUBLE) <= 0
   OR abs(TRY_CAST(amount AS DOUBLE) - TRY_CAST(qty AS INTEGER) * TRY_CAST(unit_price AS DOUBLE)) > 0.02;`,
  },
  {
    id: 'dwd_fact_purchase',
    label: 'DWD-采购入库明细(清洗)',
    layer: 'DWD',
    deps: [],
    partitioned: false,
    outputTable: 'dwd_fact_purchase',
    desc: '空值/负数量负金额拦截，拒收写入 dwd_reject_record',
    sql: `CREATE OR REPLACE TABLE dwd_fact_purchase AS
WITH typed AS (
  SELECT NULLIF(TRIM(po_no), '') AS po_no,
         TRY_CAST(biz_date AS DATE) AS biz_date,
         NULLIF(TRIM(store_id), '') AS store_id,
         NULLIF(TRIM(sku_id), '') AS sku_id,
         TRY_CAST(qty AS INTEGER) AS qty,
         TRY_CAST(unit_cost AS DOUBLE) AS unit_cost,
         TRY_CAST(amount AS DOUBLE) AS amount,
         load_batch, load_ts
  FROM ods_purchase
)
SELECT * FROM typed
WHERE po_no IS NOT NULL AND biz_date IS NOT NULL AND store_id IS NOT NULL AND sku_id IS NOT NULL
  AND qty IS NOT NULL AND qty > 0 AND amount IS NOT NULL AND amount > 0;

DELETE FROM dwd_reject_record WHERE source_table = 'ods_purchase';
INSERT INTO dwd_reject_record
SELECT 'ods_purchase', COALESCE(po_no, '?'), TRY_CAST(biz_date AS DATE), NULLIF(TRIM(store_id), ''),
       CASE
         WHEN NULLIF(TRIM(po_no), '') IS NULL THEN '采购单号为空'
         WHEN TRY_CAST(biz_date AS DATE) IS NULL THEN '业务日期为空或非法'
         WHEN NULLIF(TRIM(store_id), '') IS NULL OR NULLIF(TRIM(sku_id), '') IS NULL THEN '门店或商品为空'
         WHEN TRY_CAST(qty AS INTEGER) IS NULL OR TRY_CAST(qty AS INTEGER) <= 0 THEN '入库数量为空或非正'
         WHEN TRY_CAST(amount AS DOUBLE) IS NULL OR TRY_CAST(amount AS DOUBLE) <= 0 THEN '入库金额为空或非正'
         ELSE '其他' END,
       'qty=' || COALESCE(qty, '∅') || ', amount=' || COALESCE(amount, '∅'),
       load_batch, current_timestamp
FROM ods_purchase
WHERE NULLIF(TRIM(po_no), '') IS NULL
   OR TRY_CAST(biz_date AS DATE) IS NULL
   OR NULLIF(TRIM(store_id), '') IS NULL OR NULLIF(TRIM(sku_id), '') IS NULL
   OR TRY_CAST(qty AS INTEGER) IS NULL OR TRY_CAST(qty AS INTEGER) <= 0
   OR TRY_CAST(amount AS DOUBLE) IS NULL OR TRY_CAST(amount AS DOUBLE) <= 0;`,
  },
  {
    id: 'dwd_fact_transfer',
    label: 'DWD-调拨明细(清洗+外键)',
    layer: 'DWD',
    deps: ['dwd_dim_store'],
    partitioned: false,
    outputTable: 'dwd_fact_transfer',
    desc: '拦截同店流转、空门店、幽灵门店（外键校验）、负数量',
    sql: `CREATE OR REPLACE TABLE dwd_fact_transfer AS
WITH typed AS (
  SELECT NULLIF(TRIM(transfer_no), '') AS transfer_no,
         TRY_CAST(biz_date AS DATE) AS biz_date,
         NULLIF(TRIM(from_store_id), '') AS from_store_id,
         NULLIF(TRIM(to_store_id), '') AS to_store_id,
         NULLIF(TRIM(sku_id), '') AS sku_id,
         TRY_CAST(qty AS INTEGER) AS qty,
         load_batch, load_ts
  FROM ods_transfer
)
SELECT t.* FROM typed t
WHERE t.transfer_no IS NOT NULL AND t.biz_date IS NOT NULL
  AND t.from_store_id IS NOT NULL AND t.to_store_id IS NOT NULL AND t.sku_id IS NOT NULL
  AND t.qty IS NOT NULL AND t.qty > 0
  AND t.from_store_id <> t.to_store_id
  AND EXISTS (SELECT 1 FROM dwd_dim_store d WHERE d.store_id = t.to_store_id)
  AND EXISTS (SELECT 1 FROM dwd_dim_store d WHERE d.store_id = t.from_store_id);

DELETE FROM dwd_reject_record WHERE source_table = 'ods_transfer';
INSERT INTO dwd_reject_record
SELECT 'ods_transfer', COALESCE(transfer_no, '?'), TRY_CAST(biz_date AS DATE),
       NULLIF(TRIM(from_store_id), ''),
       CASE
         WHEN NULLIF(TRIM(transfer_no), '') IS NULL THEN '调拨单号为空'
         WHEN TRY_CAST(biz_date AS DATE) IS NULL THEN '业务日期为空或非法'
         WHEN NULLIF(TRIM(from_store_id), '') IS NULL OR NULLIF(TRIM(to_store_id), '') IS NULL THEN '调入/调出门店为空'
         WHEN from_store_id = to_store_id THEN '调出门店=调入门店'
         WHEN TRY_CAST(qty AS INTEGER) IS NULL OR TRY_CAST(qty AS INTEGER) <= 0 THEN '调拨数量为空或非正'
         WHEN NOT EXISTS (SELECT 1 FROM dwd_dim_store d WHERE d.store_id = NULLIF(TRIM(to_store_id), ''))
           OR NOT EXISTS (SELECT 1 FROM dwd_dim_store d WHERE d.store_id = NULLIF(TRIM(from_store_id), '')) THEN '门店外键不存在'
         ELSE '其他' END,
       'from=' || COALESCE(from_store_id, '∅') || ', to=' || COALESCE(to_store_id, '∅') || ', qty=' || COALESCE(qty, '∅'),
       load_batch, current_timestamp
FROM ods_transfer
WHERE NULLIF(TRIM(transfer_no), '') IS NULL
   OR TRY_CAST(biz_date AS DATE) IS NULL
   OR NULLIF(TRIM(from_store_id), '') IS NULL OR NULLIF(TRIM(to_store_id), '') IS NULL
   OR from_store_id = to_store_id
   OR TRY_CAST(qty AS INTEGER) IS NULL OR TRY_CAST(qty AS INTEGER) <= 0
   OR NOT EXISTS (SELECT 1 FROM dwd_dim_store d WHERE d.store_id = NULLIF(TRIM(to_store_id), ''))
   OR NOT EXISTS (SELECT 1 FROM dwd_dim_store d WHERE d.store_id = NULLIF(TRIM(from_store_id), ''));`,
  },
  {
    id: 'dwd_fact_stock',
    label: 'DWD-库存快照明细(去重)',
    layer: 'DWD',
    deps: [],
    partitioned: false,
    outputTable: 'dwd_fact_stock',
    desc: '快照主键去重、负库存/空值拦截',
    sql: `CREATE OR REPLACE TABLE dwd_fact_stock AS
WITH src AS (
  SELECT *, row_number() OVER (PARTITION BY snapshot_date, store_id, sku_id ORDER BY load_ts DESC) AS rn_dup
  FROM ods_stock
),
typed AS (
  SELECT TRY_CAST(snapshot_date AS DATE) AS snapshot_date,
         NULLIF(TRIM(store_id), '') AS store_id,
         NULLIF(TRIM(sku_id), '') AS sku_id,
         TRY_CAST(on_hand_qty AS INTEGER) AS on_hand_qty,
         load_batch, load_ts, rn_dup
  FROM src
)
SELECT snapshot_date, store_id, sku_id, on_hand_qty, load_batch, load_ts
FROM typed
WHERE rn_dup = 1 AND snapshot_date IS NOT NULL AND store_id IS NOT NULL AND sku_id IS NOT NULL
  AND on_hand_qty IS NOT NULL AND on_hand_qty >= 0;

DELETE FROM dwd_reject_record WHERE source_table = 'ods_stock';
INSERT INTO dwd_reject_record
SELECT 'ods_stock',
       COALESCE(snapshot_date, '?') || '/' || COALESCE(store_id, '?') || '/' || COALESCE(sku_id, '?'),
       TRY_CAST(snapshot_date AS DATE), NULLIF(TRIM(store_id), ''),
       CASE
         WHEN rn_dup > 1 THEN '重复快照'
         WHEN TRY_CAST(snapshot_date AS DATE) IS NULL THEN '快照日期为空或非法'
         WHEN NULLIF(TRIM(store_id), '') IS NULL OR NULLIF(TRIM(sku_id), '') IS NULL THEN '门店或商品为空'
         WHEN TRY_CAST(on_hand_qty AS INTEGER) IS NULL OR TRY_CAST(on_hand_qty AS INTEGER) < 0 THEN '库存为空或负库存'
         ELSE '其他' END,
       'on_hand_qty=' || COALESCE(on_hand_qty, '∅'),
       load_batch, current_timestamp
FROM (
  SELECT *, row_number() OVER (PARTITION BY snapshot_date, store_id, sku_id ORDER BY load_ts DESC) AS rn_dup
  FROM ods_stock
)
WHERE rn_dup > 1
   OR TRY_CAST(snapshot_date AS DATE) IS NULL
   OR NULLIF(TRIM(store_id), '') IS NULL OR NULLIF(TRIM(sku_id), '') IS NULL
   OR TRY_CAST(on_hand_qty AS INTEGER) IS NULL OR TRY_CAST(on_hand_qty AS INTEGER) < 0;`,
  },
  // ---------------- DWS ----------------
  {
    id: 'dws_sales_d',
    label: 'DWS-销售日汇总(门店×商品)',
    layer: 'DWS',
    deps: ['dwd_fact_pos'],
    partitioned: true,
    outputTable: 'dws_sales_d',
    desc: '按业务日期分区幂等重算；回补只重建 >= {{FROM_DATE}} 的分区',
    sql: `CREATE TABLE IF NOT EXISTS dws_sales_d (
  store_id VARCHAR, sku_id VARCHAR, biz_date DATE,
  sale_qty INTEGER, sale_amt DOUBLE, cost_amt DOUBLE, gross_profit DOUBLE, txn_cnt INTEGER
);
DELETE FROM dws_sales_d WHERE biz_date >= DATE '{{FROM_DATE}}';
INSERT INTO dws_sales_d
SELECT store_id, sku_id, sale_date AS biz_date,
       sum(qty)::INTEGER AS sale_qty,
       round(sum(amount), 2) AS sale_amt,
       round(sum(qty * unit_cost), 2) AS cost_amt,
       round(sum(amount - qty * unit_cost), 2) AS gross_profit,
       count(DISTINCT txn_no)::INTEGER AS txn_cnt
FROM dwd_fact_pos
WHERE sale_date >= DATE '{{FROM_DATE}}'
GROUP BY 1, 2, 3;`,
  },
  {
    id: 'dws_inv_balance_d',
    label: 'DWS-库存日平衡(核心守恒表)',
    layer: 'DWS',
    deps: ['dwd_fact_pos', 'dwd_fact_purchase', 'dwd_fact_transfer', 'dwd_fact_stock'],
    partitioned: true,
    outputTable: 'dws_inv_balance_d',
    desc: '期初+采购入库+调入-销售出库-调出=期末；逐日逐店逐SKU核算差异',
    sql: `CREATE TABLE IF NOT EXISTS dws_inv_balance_d (
  store_id VARCHAR, sku_id VARCHAR, biz_date DATE,
  opening_qty INTEGER, in_purchase_qty INTEGER, in_transfer_qty INTEGER,
  out_sale_qty INTEGER, out_transfer_qty INTEGER,
  calc_closing_qty INTEGER, actual_closing_qty INTEGER, diff_qty INTEGER,
  balance_pass BOOLEAN
);
DELETE FROM dws_inv_balance_d WHERE biz_date >= DATE '{{FROM_DATE}}';
INSERT INTO dws_inv_balance_d
WITH dim_dates AS (
  SELECT DISTINCT snapshot_date AS biz_date FROM dwd_fact_stock
  WHERE snapshot_date > (SELECT min(snapshot_date) FROM dwd_fact_stock)
),
dim_store AS (SELECT DISTINCT store_id FROM dwd_fact_stock),
dim_sku   AS (SELECT DISTINCT sku_id FROM dwd_fact_stock),
spine AS (SELECT * FROM dim_dates CROSS JOIN dim_store CROSS JOIN dim_sku),
sale AS (
  SELECT store_id, sku_id, sale_date AS biz_date, sum(qty) AS q
  FROM dwd_fact_pos GROUP BY 1, 2, 3
),
pur AS (
  SELECT store_id, sku_id, biz_date, sum(qty) AS q FROM dwd_fact_purchase GROUP BY 1, 2, 3
),
tf_out AS (
  SELECT from_store_id AS store_id, sku_id, biz_date, sum(qty) AS q
  FROM dwd_fact_transfer GROUP BY 1, 2, 3
),
tf_in AS (
  SELECT to_store_id AS store_id, sku_id, biz_date, sum(qty) AS q
  FROM dwd_fact_transfer GROUP BY 1, 2, 3
),
snap AS (
  SELECT snapshot_date AS biz_date, store_id, sku_id, on_hand_qty FROM dwd_fact_stock
)
SELECT sp.store_id, sp.sku_id, sp.biz_date,
       opening.on_hand_qty AS opening_qty,
       COALESCE(pur.q, 0)::INTEGER AS in_purchase_qty,
       COALESCE(tf_in.q, 0)::INTEGER AS in_transfer_qty,
       COALESCE(sale.q, 0)::INTEGER AS out_sale_qty,
       COALESCE(tf_out.q, 0)::INTEGER AS out_transfer_qty,
       (opening.on_hand_qty + COALESCE(pur.q, 0) + COALESCE(tf_in.q, 0)
                        - COALESCE(sale.q, 0) - COALESCE(tf_out.q, 0))::INTEGER AS calc_closing_qty,
       snap.on_hand_qty AS actual_closing_qty,
       (snap.on_hand_qty - (opening.on_hand_qty + COALESCE(pur.q, 0) + COALESCE(tf_in.q, 0)
                                             - COALESCE(sale.q, 0) - COALESCE(tf_out.q, 0)))::INTEGER AS diff_qty,
       (snap.on_hand_qty IS NOT NULL AND opening.on_hand_qty IS NOT NULL
        AND snap.on_hand_qty = opening.on_hand_qty + COALESCE(pur.q, 0) + COALESCE(tf_in.q, 0)
                                                    - COALESCE(sale.q, 0) - COALESCE(tf_out.q, 0)) AS balance_pass
FROM spine sp
LEFT JOIN snap ON snap.store_id = sp.store_id AND snap.sku_id = sp.sku_id AND snap.biz_date = sp.biz_date
LEFT JOIN sale ON sale.store_id = sp.store_id AND sale.sku_id = sp.sku_id AND sale.biz_date = sp.biz_date
LEFT JOIN pur  ON pur.store_id  = sp.store_id AND pur.sku_id  = sp.sku_id AND pur.biz_date  = sp.biz_date
LEFT JOIN tf_out ON tf_out.store_id = sp.store_id AND tf_out.sku_id = sp.sku_id AND tf_out.biz_date = sp.biz_date
LEFT JOIN tf_in  ON tf_in.store_id  = sp.store_id AND tf_in.sku_id  = sp.sku_id AND tf_in.biz_date  = sp.biz_date
LEFT JOIN LATERAL (
  SELECT s.on_hand_qty FROM dwd_fact_stock s
  WHERE s.store_id = sp.store_id AND s.sku_id = sp.sku_id AND s.snapshot_date < sp.biz_date
  ORDER BY s.snapshot_date DESC LIMIT 1
) opening ON TRUE
WHERE sp.biz_date >= DATE '{{FROM_DATE}}';`,
  },
  // ---------------- ADS ----------------
  {
    id: 'ads_metrics',
    label: 'ADS-应用指标层(门店/商品/KPI)',
    layer: 'ADS',
    deps: ['dws_sales_d', 'dws_inv_balance_d', 'dq_check'],
    partitioned: true,
    outputTable: 'ads_store_metrics',
    desc: '被 dq_blocked_partition 阻断的门店日不进入指标；周转/动销/毛利按门店与商品出数',
    sql: `-- 门店×日指标（带平衡标记，阻断分区 balance_ok=0）
CREATE OR REPLACE TABLE ads_store_metrics_d AS
SELECT s.biz_date, s.store_id, d.store_name, d.region, d.city,
       sum(s.sale_qty) AS sale_qty,
       round(sum(s.sale_amt), 2) AS sale_amt,
       round(sum(s.cost_amt), 2) AS cost_amt,
       round(sum(s.gross_profit), 2) AS gross_profit,
       CASE WHEN bp.store_id IS NULL THEN 1 ELSE 0 END AS balance_ok
FROM dws_sales_d s
JOIN dwd_dim_store d ON d.store_id = s.store_id
LEFT JOIN dq_blocked_partition bp ON bp.store_id = s.store_id AND bp.biz_date = s.biz_date
GROUP BY 1, 2, 3, 4, 5, 10;

-- 门店周期汇总
CREATE OR REPLACE TABLE ads_store_metrics AS
WITH period AS (
  SELECT min(biz_date) AS d0, max(biz_date) AS d1,
         count(DISTINCT biz_date) AS day_cnt
  FROM dws_inv_balance_d WHERE balance_pass
),
sales AS (
  SELECT s.store_id,
         sum(s.sale_qty) AS sale_qty,
         sum(s.sale_amt) AS sale_amt,
         sum(s.cost_amt) AS cost_amt,
         sum(s.gross_profit) AS gross_profit,
         count(DISTINCT s.sku_id) AS active_sku_cnt
  FROM dws_sales_d s
  WHERE NOT EXISTS (
    SELECT 1 FROM dq_blocked_partition bp
    WHERE bp.store_id = s.store_id AND bp.biz_date = s.biz_date
  )
  GROUP BY 1
),
stockcost AS (
  SELECT b.store_id,
         avg(b.actual_closing_qty) AS avg_stock_qty,
         avg(b.actual_closing_qty * p.unit_cost) AS avg_stock_cost,
         count(DISTINCT b.sku_id) AS managed_sku_cnt
  FROM dws_inv_balance_d b
  JOIN dwd_dim_product p ON p.sku_id = b.sku_id
    AND b.biz_date BETWEEN p.effective_from AND p.effective_to
  WHERE b.balance_pass
  GROUP BY 1
)
SELECT d.store_id, d.store_name, d.region, d.city,
       COALESCE(s.sale_qty, 0) AS sale_qty,
       round(COALESCE(s.sale_amt, 0), 2) AS sale_amt,
       round(COALESCE(s.gross_profit, 0), 2) AS gross_profit,
       round(CASE WHEN s.sale_amt > 0 THEN s.gross_profit / s.sale_amt END, 4) AS margin_rate,
       round(COALESCE(sc.avg_stock_qty, 0), 1) AS avg_stock_qty,
       round(COALESCE(sc.avg_stock_cost, 0), 2) AS avg_stock_cost,
       round(CASE WHEN sc.avg_stock_cost > 0 THEN s.cost_amt / sc.avg_stock_cost END, 4) AS turnover_rate,
       round(CASE WHEN sc.avg_stock_cost > 0 AND s.cost_amt > 0
             THEN (SELECT day_cnt FROM period) * sc.avg_stock_cost / s.cost_amt END, 1) AS turnover_days,
       COALESCE(s.active_sku_cnt, 0) AS active_sku_cnt,
       COALESCE(sc.managed_sku_cnt, 0) AS managed_sku_cnt,
       round(CASE WHEN sc.managed_sku_cnt > 0 THEN s.active_sku_cnt * 1.0 / sc.managed_sku_cnt END, 4) AS sell_through_rate
FROM dwd_dim_store d
LEFT JOIN sales s ON s.store_id = d.store_id
LEFT JOIN stockcost sc ON sc.store_id = d.store_id;

-- 商品周期汇总（属性取 SCD2 当前版本）
CREATE OR REPLACE TABLE ads_product_metrics AS
WITH sales AS (
  SELECT sku_id, sum(sale_qty) AS sale_qty, sum(sale_amt) AS sale_amt,
         sum(cost_amt) AS cost_amt, sum(gross_profit) AS gross_profit
  FROM dws_sales_d s
  WHERE NOT EXISTS (
    SELECT 1 FROM dq_blocked_partition bp
    WHERE bp.store_id = s.store_id AND bp.biz_date = s.biz_date
  )
  GROUP BY 1
),
stock AS (
  SELECT b.sku_id, avg(b.actual_closing_qty) AS avg_stock_qty,
         avg(b.actual_closing_qty * p.unit_cost) AS avg_stock_cost
  FROM dws_inv_balance_d b
  JOIN dwd_dim_product p ON p.sku_id = b.sku_id
    AND b.biz_date BETWEEN p.effective_from AND p.effective_to
  WHERE b.balance_pass
  GROUP BY 1
)
SELECT p.sku_id, p.sku_name, p.category, p.manufacturer, p.unit,
       COALESCE(s.sale_qty, 0) AS sale_qty,
       round(COALESCE(s.sale_amt, 0), 2) AS sale_amt,
       round(COALESCE(s.gross_profit, 0), 2) AS gross_profit,
       round(COALESCE(st.avg_stock_qty, 0), 1) AS avg_stock_qty,
       round(COALESCE(st.avg_stock_cost, 0), 2) AS avg_stock_cost,
       round(CASE WHEN st.avg_stock_cost > 0 THEN s.cost_amt / st.avg_stock_cost END, 4) AS turnover_rate
FROM dwd_dim_product p
LEFT JOIN sales s ON s.sku_id = p.sku_id
LEFT JOIN stock st ON st.sku_id = p.sku_id
WHERE p.is_current;

-- 全局 KPI
CREATE OR REPLACE TABLE ads_kpi AS
WITH b AS (
  SELECT count(*) AS balance_rows,
         sum(CASE WHEN balance_pass THEN 1 ELSE 0 END) AS pass_rows,
         count(DISTINCT biz_date) AS day_cnt
  FROM dws_inv_balance_d
)
SELECT (SELECT round(sum(sale_amt), 2) FROM dws_sales_d s
          WHERE NOT EXISTS (SELECT 1 FROM dq_blocked_partition bp
                            WHERE bp.store_id = s.store_id AND bp.biz_date = s.biz_date)) AS total_sale_amt,
       (SELECT round(sum(gross_profit), 2) FROM dws_sales_d s
          WHERE NOT EXISTS (SELECT 1 FROM dq_blocked_partition bp
                            WHERE bp.store_id = s.store_id AND bp.biz_date = s.biz_date)) AS total_gross_profit,
       (SELECT count(*) FROM dq_blocked_partition) AS blocked_partition_cnt,
       (SELECT count(*) FROM dwd_reject_record) AS reject_row_cnt,
       b.balance_rows, b.pass_rows, b.day_cnt
FROM b;`,
  },
];

/** 数据质量规则默认值（checkSql 返回"失败行"，引擎自动包 count / 取样例 / 提取阻断分区） */
export interface QualityRuleTemplate {
  id: string;
  name: string;
  layer: 'ods' | 'dwd' | 'dws';
  table: string;
  severity: 'block' | 'warn';
  enabled: boolean;
  desc: string;
  /** 失败行查询；失败行需带 store_id 与 biz_date 列才能写阻断分区 */
  checkSql: string;
  /** 是否可产出 (store_id, biz_date) 阻断分区 */
  partitioned: boolean;
}

export const DEFAULT_QUALITY_RULES: QualityRuleTemplate[] = [
  {
    id: 'dq_pos_null',
    name: 'POS 必填字段空值/非法日期',
    layer: 'ods', table: 'ods_pos', severity: 'block', enabled: true, partitioned: true,
    desc: '交易单号、业务日期、门店、商品任一为空即失败',
    checkSql: `SELECT txn_no, line_no, sale_date AS biz_date, store_id, sku_id,
       CASE WHEN NULLIF(TRIM(txn_no),'') IS NULL THEN '交易单号为空'
            WHEN TRY_CAST(sale_date AS DATE) IS NULL THEN '业务日期为空或非法'
            WHEN NULLIF(TRIM(store_id),'') IS NULL THEN '门店为空'
            ELSE '商品为空' END AS reason
FROM ods_pos
WHERE (NULLIF(TRIM(txn_no),'') IS NULL
   OR TRY_CAST(sale_date AS DATE) IS NULL
   OR NULLIF(TRIM(store_id),'') IS NULL
   OR NULLIF(TRIM(sku_id),'') IS NULL)
  AND EXISTS (SELECT 1 FROM dwd_fact_pos f
              WHERE f.store_id = ods_pos.store_id AND f.sale_date = TRY_CAST(ods_pos.sale_date AS DATE))`,
  },
  {
    id: 'dq_pos_dup',
    name: 'POS 重复流水',
    layer: 'ods', table: 'ods_pos', severity: 'block', enabled: true, partitioned: true,
    desc: 'txn_no + line_no 出现多行',
    checkSql: `SELECT txn_no, line_no, ANY_VALUE(sale_date) AS biz_date, ANY_VALUE(store_id) AS store_id,
       count(*) AS dup_cnt, '重复流水' AS reason
FROM ods_pos
GROUP BY txn_no, line_no
HAVING count(*) > 1
   AND EXISTS (SELECT 1 FROM dwd_fact_pos f
               WHERE f.store_id = ANY_VALUE(ods_pos.store_id)
                 AND f.sale_date = TRY_CAST(ANY_VALUE(ods_pos.sale_date) AS DATE))`,
  },
  {
    id: 'dq_pos_amount',
    name: 'POS 金额一致性(amount=qty×单价)',
    layer: 'ods', table: 'ods_pos', severity: 'block', enabled: true, partitioned: true,
    desc: '容忍误差 0.02 元；失败分区阻断下游',
    checkSql: `SELECT txn_no, line_no, sale_date AS biz_date, store_id, sku_id, qty, unit_price, amount,
       round(TRY_CAST(amount AS DOUBLE) - TRY_CAST(qty AS INTEGER) * TRY_CAST(unit_price AS DOUBLE), 2) AS diff_amt,
       '金额对不平' AS reason
FROM ods_pos
WHERE TRY_CAST(qty AS INTEGER) > 0 AND TRY_CAST(unit_price AS DOUBLE) > 0 AND TRY_CAST(amount AS DOUBLE) > 0
  AND abs(TRY_CAST(amount AS DOUBLE) - TRY_CAST(qty AS INTEGER) * TRY_CAST(unit_price AS DOUBLE)) > 0.02
  AND EXISTS (SELECT 1 FROM dwd_dim_store d WHERE d.store_id = ods_pos.store_id)`,
  },
  {
    id: 'dq_pos_negative',
    name: 'POS 负数量/负金额',
    layer: 'ods', table: 'ods_pos', severity: 'block', enabled: true, partitioned: true,
    desc: '销售数量或金额 <= 0',
    checkSql: `SELECT txn_no, line_no, sale_date AS biz_date, store_id, sku_id, qty, amount, '负值' AS reason
FROM ods_pos
WHERE (TRY_CAST(qty AS INTEGER) <= 0 OR TRY_CAST(amount AS DOUBLE) <= 0)
  AND NULLIF(TRIM(store_id), '') IS NOT NULL AND TRY_CAST(sale_date AS DATE) IS NOT NULL
  AND EXISTS (SELECT 1 FROM dwd_fact_pos f
              WHERE f.store_id = ods_pos.store_id AND f.sale_date = TRY_CAST(ods_pos.sale_date AS DATE))`,
  },
  {
    id: 'dq_purchase_invalid',
    name: '采购空值/负数量负金额',
    layer: 'ods', table: 'ods_purchase', severity: 'block', enabled: true, partitioned: true,
    desc: '主键、门店、商品为空或数量金额非正',
    checkSql: `SELECT po_no, biz_date, store_id, sku_id, qty, amount, '采购非法行' AS reason
FROM ods_purchase
WHERE (NULLIF(TRIM(po_no),'') IS NULL OR TRY_CAST(biz_date AS DATE) IS NULL
   OR NULLIF(TRIM(store_id),'') IS NULL OR NULLIF(TRIM(sku_id),'') IS NULL
   OR TRY_CAST(qty AS INTEGER) <= 0 OR TRY_CAST(amount AS DOUBLE) <= 0)
  AND NULLIF(TRIM(store_id), '') IS NOT NULL AND TRY_CAST(biz_date AS DATE) IS NOT NULL
  AND EXISTS (SELECT 1 FROM dwd_fact_purchase f
              WHERE f.store_id = ods_purchase.store_id AND f.biz_date = TRY_CAST(ods_purchase.biz_date AS DATE))`,
  },
  {
    id: 'dq_transfer_invalid',
    name: '调拨同店/空门店/幽灵门店',
    layer: 'ods', table: 'ods_transfer', severity: 'block', enabled: true, partitioned: true,
    desc: '调出门店=调入门店、门店为空或外键不存在',
    checkSql: `SELECT t.transfer_no, t.biz_date, t.from_store_id AS store_id, t.to_store_id, t.sku_id,
       CASE WHEN t.from_store_id = t.to_store_id THEN '同店流转'
            WHEN NULLIF(t.from_store_id,'') IS NULL OR NULLIF(t.to_store_id,'') IS NULL THEN '门店为空'
            ELSE '门店外键不存在' END AS reason
FROM ods_transfer t
WHERE (t.from_store_id = t.to_store_id
   OR NULLIF(TRIM(t.from_store_id),'') IS NULL OR NULLIF(TRIM(t.to_store_id),'') IS NULL
   OR NOT EXISTS (SELECT 1 FROM dwd_dim_store d WHERE d.store_id = t.to_store_id)
   OR NOT EXISTS (SELECT 1 FROM dwd_dim_store d WHERE d.store_id = t.from_store_id))
  AND NULLIF(TRIM(t.from_store_id), '') IS NOT NULL AND TRY_CAST(t.biz_date AS DATE) IS NOT NULL
  AND EXISTS (SELECT 1 FROM dwd_fact_transfer f
              WHERE f.from_store_id = t.from_store_id AND f.biz_date = TRY_CAST(t.biz_date AS DATE))`,
  },
  {
    id: 'dq_stock_invalid',
    name: '快照空值/负库存/重复快照',
    layer: 'ods', table: 'ods_stock', severity: 'block', enabled: true, partitioned: true,
    desc: '快照主键重复、维度为空或库存为负',
    checkSql: `SELECT snapshot_date AS biz_date, store_id, sku_id, on_hand_qty,
       CASE WHEN count(*) > 1 THEN '重复快照'
            WHEN NULLIF(TRIM(store_id),'') IS NULL OR NULLIF(TRIM(sku_id),'') IS NULL THEN '维度为空'
            ELSE '负库存' END AS reason
FROM ods_stock
GROUP BY snapshot_date, store_id, sku_id, on_hand_qty
HAVING (count(*) > 1
   OR NULLIF(TRIM(store_id),'') IS NULL OR NULLIF(TRIM(sku_id),'') IS NULL
   OR TRY_CAST(on_hand_qty AS INTEGER) < 0)
  AND NULLIF(TRIM(store_id), '') IS NOT NULL AND TRY_CAST(snapshot_date AS DATE) IS NOT NULL
  AND EXISTS (SELECT 1 FROM dwd_fact_stock f
              WHERE f.store_id = ods_stock.store_id AND f.snapshot_date = TRY_CAST(ods_stock.snapshot_date AS DATE))`,
  },
  {
    id: 'dq_inv_balance',
    name: '库存平衡(期初+入-出=期末)',
    layer: 'dws', table: 'dws_inv_balance_d', severity: 'block', enabled: true, partitioned: true,
    desc: '核心规则：任一 SKU 不平则该门店整天分区阻断，不进 ADS',
    checkSql: `SELECT store_id, sku_id, biz_date, opening_qty, in_purchase_qty, in_transfer_qty,
       out_sale_qty, out_transfer_qty, calc_closing_qty, actual_closing_qty, diff_qty,
       '库存不平衡(差异 ' || COALESCE(diff_qty, 0) || ')' AS reason
FROM dws_inv_balance_d
WHERE NOT balance_pass`,
  },
  {
    id: 'dq_snapshot_missing',
    name: '快照缺失(警告)',
    layer: 'dws', table: 'dws_inv_balance_d', severity: 'warn', enabled: true, partitioned: true,
    desc: '门店×日期应有快照但缺失（如迟到快照），仅警告不阻断',
    checkSql: `SELECT store_id, sku_id, biz_date, actual_closing_qty, '快照缺失' AS reason
FROM dws_inv_balance_d
WHERE actual_closing_qty IS NULL`,
  },
  {
    id: 'dq_orphan_fk',
    name: 'POS 孤儿外键(警告)',
    layer: 'dwd', table: 'dwd_fact_pos', severity: 'warn', enabled: true, partitioned: true,
    desc: 'POS 门店或商品在维度表中不存在',
    checkSql: `SELECT f.txn_no, f.sale_date AS biz_date, f.store_id, f.sku_id, '外键不存在' AS reason
FROM dwd_fact_pos f
WHERE NOT EXISTS (SELECT 1 FROM dwd_dim_store d WHERE d.store_id = f.store_id)
   OR NOT EXISTS (SELECT 1 FROM dwd_dim_product p WHERE p.sku_id = f.sku_id)`,
  },
];

/** 看板/探查用查询（按筛选条件参数化） */
export const DASHBOARD_QUERIES = {
  trend: `SELECT biz_date,
         sum(CASE WHEN balance_ok = 1 THEN sale_amt ELSE 0 END) AS sale_amt,
         sum(CASE WHEN balance_ok = 1 THEN gross_profit ELSE 0 END) AS gross_profit,
         sum(CASE WHEN balance_ok = 0 THEN 1 ELSE 0 END) AS blocked_stores
  FROM ads_store_metrics_d
  WHERE (@region = '__ALL__' OR region = @region)
  GROUP BY 1 ORDER BY 1`,
  topStores: `SELECT store_id, store_name, region, sale_amt, gross_profit, margin_note
  FROM (
    SELECT m.store_id, m.store_name, m.region,
           round(sum(d.sale_amt), 2) AS sale_amt,
           round(sum(d.gross_profit), 2) AS gross_profit,
           '' AS margin_note
    FROM ads_store_metrics_d d JOIN ads_store_metrics m USING (store_id)
    WHERE d.balance_ok = 1 AND (@region = '__ALL__' OR d.region = @region)
    GROUP BY 1, 2, 3
  ) ORDER BY sale_amt DESC LIMIT 10`,
  balanceCalendar: `SELECT biz_date,
         count(DISTINCT store_id) AS store_cnt,
         sum(CASE WHEN balance_ok = 0 THEN 1 ELSE 0 END) AS blocked_cnt
  FROM ads_store_metrics_d
  GROUP BY 1 ORDER BY 1`,
};

import { useCallback, useEffect, useMemo, useState } from 'react';
import { DuckEngine } from '../db/duckdb';
import { useStore } from '../store/useStore';
import { BarChart, DonutChart, LineChart, compact } from '../components/Charts';
import { DataTable } from '../components/DataTable';

interface Kpi {
  total_sale_amt: number;
  total_gross_profit: number;
  blocked_partition_cnt: number;
  reject_row_cnt: number;
  balance_rows: number;
  pass_rows: number;
  day_cnt: number;
}

export function DashboardPage() {
  const { lastRun, imports } = useStore();
  const eng = DuckEngine.get();
  const [region, setRegion] = useState('__ALL__');
  const [regions, setRegions] = useState<string[]>([]);
  const [kpi, setKpi] = useState<Kpi | null>(null);
  const [trend, setTrend] = useState<Record<string, unknown>[]>([]);
  const [regionRows, setRegionRows] = useState<Record<string, unknown>[]>([]);
  const [stores, setStores] = useState<Record<string, unknown>[]>([]);
  const [products, setProducts] = useState<Record<string, unknown>[]>([]);
  const [calendar, setCalendar] = useState<Record<string, unknown>[]>([]);
  const [failRows, setFailRows] = useState<Record<string, unknown>[]>([]);
  const [scdRows, setScdRows] = useState<Record<string, unknown>[]>([]);
  const [ready, setReady] = useState(false);

  const esc = (s: string) => s.replaceAll("'", "''");

  const load = useCallback(async () => {
    if (!(await eng.tableExists('ads_kpi'))) {
      setReady(false);
      return;
    }
    const [k, t, rg, st, pr, ca, fv, scd, regs] = await Promise.all([
      eng.queryOne<Kpi>('SELECT * FROM ads_kpi'),
      eng.query(`SELECT biz_date,
         sum(CASE WHEN balance_ok = 1 THEN sale_amt ELSE 0 END) AS sale_amt,
         sum(CASE WHEN balance_ok = 1 THEN gross_profit ELSE 0 END) AS gross_profit,
         sum(CASE WHEN balance_ok = 0 THEN 1 ELSE 0 END) AS blocked_stores
       FROM ads_store_metrics_d GROUP BY 1 ORDER BY 1`),
      eng.query(`SELECT region, round(sum(sale_amt),2) AS sale_amt, round(sum(gross_profit),2) AS gross_profit
       FROM ads_store_metrics_d WHERE balance_ok = 1 GROUP BY 1 ORDER BY sale_amt DESC`),
      eng.query(`SELECT store_id, store_name, region, sale_amt, gross_profit, margin_rate,
         turnover_rate, turnover_days, sell_through_rate FROM ads_store_metrics ORDER BY sale_amt DESC`),
      eng.query(`SELECT sku_id, sku_name, category, sale_qty, sale_amt, gross_profit,
         avg_stock_qty, turnover_rate FROM ads_product_metrics ORDER BY sale_amt DESC LIMIT 15`),
      eng.query(`SELECT biz_date, count(DISTINCT store_id) AS store_cnt,
         sum(CASE WHEN balance_ok = 0 THEN 1 ELSE 0 END) AS blocked_cnt
       FROM ads_store_metrics_d GROUP BY 1 ORDER BY 1`),
      eng.query(`SELECT store_id, biz_date, count(*) AS unbalanced_skus, sum(abs(diff_qty)) AS abs_diff
       FROM dws_inv_balance_d WHERE NOT balance_pass GROUP BY 1, 2 ORDER BY biz_date, store_id`),
      eng.query(`SELECT sku_id, sku_name, effective_from, effective_to, is_current,
         unit_cost, retail_price, manufacturer, category
       FROM dwd_dim_product WHERE sku_id IN (
         SELECT sku_id FROM dwd_dim_product GROUP BY sku_id HAVING count(*) > 1
       ) ORDER BY sku_id, effective_from`),
      eng.query<{ region: string }>('SELECT DISTINCT region FROM dwd_dim_store ORDER BY 1'),
    ]);
    setKpi(k);
    setTrend(t);
    setRegionRows(rg);
    setStores(st);
    setProducts(pr);
    setCalendar(ca);
    setFailRows(fv);
    setScdRows(scd);
    setRegions(regs.map((r) => r.region));
    setReady(true);
  }, [eng]);

  useEffect(() => {
    void eng.ready.then(load);
  }, [eng, load, lastRun?.runId]);

  const filteredStores = useMemo(
    () => (region === '__ALL__' ? stores : stores.filter((s) => s.region === region)),
    [stores, region],
  );

  if (!ready) {
    return (
      <div className="empty">
        <div className="big">指标尚未生成</div>
        请先到「数据接入」导入 CSV，再到「任务调度」运行 DAG。
        <br />
        被质量门禁阻断的门店日不会进入任何指标，保证看板数字只来自账实平衡的数据。
      </div>
    );
  }

  const marginRate = kpi && kpi.total_sale_amt ? kpi.total_gross_profit / kpi.total_sale_amt : 0;
  const balanceRate = kpi && kpi.balance_rows ? kpi.pass_rows / kpi.balance_rows : 0;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid grid-4">
        <div className="card kpi accent-blue">
          <div className="kpi-label">有效销售额（已剔除阻断分区）</div>
          <div className="kpi-value">¥{compact(Number(kpi?.total_sale_amt ?? 0))}</div>
          <div className="kpi-sub">覆盖 {kpi?.day_cnt ?? 0} 个业务日</div>
        </div>
        <div className="card kpi accent-green">
          <div className="kpi-label">毛利 / 毛利率</div>
          <div className="kpi-value">¥{compact(Number(kpi?.total_gross_profit ?? 0))}</div>
          <div className="kpi-sub">{(marginRate * 100).toFixed(2)}%</div>
        </div>
        <div className="card kpi accent-amber">
          <div className="kpi-label">库存平衡通过率</div>
          <div className="kpi-value">{(balanceRate * 100).toFixed(2)}%</div>
          <div className="kpi-sub">
            {Number(kpi?.pass_rows ?? 0).toLocaleString()} / {Number(kpi?.balance_rows ?? 0).toLocaleString()} 门店×日×SKU 行
          </div>
        </div>
        <div className="card kpi accent-red">
          <div className="kpi-label">阻断分区 / 拒收脏行</div>
          <div className="kpi-value">
            {Number(kpi?.blocked_partition_cnt ?? 0)}
            <span style={{ fontSize: 16, color: 'var(--text-faint)' }}> / {Number(kpi?.reject_row_cnt ?? 0)}</span>
          </div>
          <div className="kpi-sub">不平门店日 / ODS→DWD 拒收行</div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3>每日销售额与毛利趋势</h3>
          <LineChart
            series={[
              { label: '销售额', points: trend.map((r) => ({ x: String(r.biz_date), y: Number(r.sale_amt) })) },
              { label: '毛利', points: trend.map((r) => ({ x: String(r.biz_date), y: Number(r.gross_profit) })) },
            ]}
          />
        </div>
        <div className="card">
          <h3>大区销售占比</h3>
          <DonutChart data={regionRows.map((r) => ({ label: String(r.region), value: Number(r.sale_amt) }))} />
        </div>
      </div>

      <div className="card">
        <div className="row">
          <h3 style={{ margin: 0 }}>门店库存平衡日历</h3>
          <span className="muted">绿色=全部平衡，红色=存在阻断门店（数字为当日阻断门店数）</span>
        </div>
        <div className="pill-row mt16">
          {calendar.map((r) => {
            const blocked = Number(r.blocked_cnt);
            return (
              <div
                key={String(r.biz_date)}
                className="dag-node"
                style={{
                  width: 118,
                  borderColor: blocked ? '#7f2d33' : '#2a6b3c',
                  background: blocked ? 'var(--red-soft)' : 'var(--green-soft)',
                }}
              >
                <div className="t" style={{ fontSize: 11.5 }}>{String(r.biz_date).slice(5)}</div>
                <div className="d">
                  {String(r.store_cnt)} 店 ·{' '}
                  <span style={{ color: blocked ? '#fca5a5' : '#86efac', fontWeight: 700 }}>
                    {blocked ? `${blocked} 阻断` : '全平'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        {failRows.length > 0 && (
          <div className="mt16">
            <div className="badge badge-red mb12">不平门店日明细（期初+入−出≠期末）</div>
            <DataTable rows={failRows} numberCols={['unbalanced_skus', 'abs_diff']} pageSize={6} />
          </div>
        )}
      </div>

      <div className="card">
        <div className="row">
          <h3 style={{ margin: 0 }}>门店指标排行</h3>
          <span className="spacer" />
          <select value={region} onChange={(e) => setRegion(e.target.value)}>
            <option value="__ALL__">全部大区</option>
            {regions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="mt16">
          <BarChart
            data={filteredStores.slice(0, 12).map((s) => ({
              label: String(s.store_name),
              value: Number(s.sale_amt),
              sub: String(s.region),
            }))}
            formatVal={(n) => '¥' + compact(n)}
          />
        </div>
        <DataTable
          rows={filteredStores}
          columns={['store_id', 'store_name', 'region', 'sale_amt', 'gross_profit', 'margin_rate', 'turnover_rate', 'turnover_days', 'sell_through_rate']}
          numberCols={['sale_amt', 'gross_profit', 'margin_rate', 'turnover_rate', 'turnover_days', 'sell_through_rate']}
          pageSize={8}
        />
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3>商品销售 TOP 15（按门店与商品出数）</h3>
          <DataTable
            rows={products}
            numberCols={['sale_qty', 'sale_amt', 'gross_profit', 'avg_stock_qty', 'turnover_rate']}
            pageSize={8}
          />
        </div>
        <div className="card">
          <h3>商品主数据 SCD2 历史版本（缓慢变化维）</h3>
          <div className="sub">同一 sku_id 的多个生效区间，is_current=当前版本</div>
          <DataTable
            rows={scdRows}
            columns={['sku_id', 'sku_name', 'effective_from', 'effective_to', 'is_current', 'unit_cost', 'retail_price', 'manufacturer', 'category']}
            pageSize={8}
            empty="无变更记录"
          />
        </div>
      </div>

      <div className="card">
        <h3>口径说明</h3>
        <ul className="dim" style={{ lineHeight: 1.9, paddingLeft: 18, margin: 0 }}>
          <li>库存平衡：期末 = 期初 + 采购入库 + 调入 − 销售出库 − 调出，按 门店×商品×业务日期 逐日核算；任一 SKU 不平则该门店整天阻断。</li>
          <li>库存周转率 = 周期销售成本 / 平均库存金额（成本按 SCD2 生效区间匹配当日单位成本）；周转天数 = 天数 / 周转率。</li>
          <li>动销率 = 周期内有销售的 SKU 数 / 门店经营 SKU 数；毛利率 = 毛利 / 销售额。</li>
          <li>所有金额指标自动剔除 dq_blocked_partition 中的门店日；快照缺失为警告级，不阻断但该 SKU 不参与平均库存。</li>
          <li>当前导入批次：{imports.length} 个文件；最近运行：{lastRun ? `${lastRun.runId}（${lastRun.mode === 'full' ? '全量' : '回补'}）` : '无'}</li>
        </ul>
      </div>
    </div>
  );
}

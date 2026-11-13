#!/usr/bin/env node
/**
 * 药房数仓测试数据生成器（零依赖，确定性随机种子）
 *
 * 架构原则：流水是唯一事实源，快照由流水滚动计算 -> 结构上保证
 *   期末 = 期初 + 采购入库 + 调入 - 销售出库 - 调出
 * 脏数据与迟到数据在最后阶段隔离注入，绝不回写库存账本。
 *
 * 生成到 public/sample-data/：
 *   dim_store.csv / dim_product.csv（含 SCD2 事件）
 *   pos.csv / pos_late.csv（迟到 POS）
 *   purchase.csv / transfer.csv
 *   stock.csv / stock_late.csv（迟到快照）
 *   README.md（脏数据清单与预期）
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const N_STORES = arg('stores', 60);
const N_SKUS = arg('skus', 30);
const N_DAYS = arg('days', 14);
const OUT = join(__dirname, '..', 'public', 'sample-data');
const SEED = 20261113;
const FIRST_DATE = '2026-10-26';
const ANCHOR_DATE = '2026-10-25';
const LATE_DATE = '2026-10-28';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const ri = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const round2 = (x) => Math.round(x * 100) / 100;
const pad = (n) => String(n).padStart(3, '0');
function addDays(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
const DATES = Array.from({ length: N_DAYS }, (_, i) => addDays(FIRST_DATE, i));
const LAST_DATE = DATES[DATES.length - 1];

function csv(rows, headers) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n') + '\n';
}
const write = (name, content) => writeFileSync(join(OUT, name), content, 'utf8');
mkdirSync(OUT, { recursive: true });

// ---------- 门店 ----------
const REGIONS = [
  ['华东', ['上海', '杭州', '苏州', '南京']],
  ['华南', ['广州', '深圳', '佛山', '东莞']],
  ['华北', ['北京', '天津', '石家庄']],
  ['西南', ['成都', '重庆', '昆明']],
];
const stores = [];
for (let i = 1; i <= N_STORES; i++) {
  const [region, cities] = REGIONS[i % REGIONS.length];
  const city = cities[i % cities.length];
  stores.push({
    store_id: `S${pad(i)}`,
    store_name: `${city}${['安康', '仁心', '惠民', '同济', '德生'][i % 5]}药房${pad(i)}店`,
    region,
    city,
    open_date: addDays(FIRST_DATE, -ri(200, 1200)),
    status: i === 58 ? 'CLOSED' : 'OPEN',
  });
}

// ---------- 商品（含 SCD2 事件） ----------
const CATEGORIES = ['处方药', '非处方药', '保健品', '医疗器械', '中成药'];
const UNITS = ['盒', '瓶', '袋', '支'];
const NAMES = ['阿莫', '布洛芬', '维C', '血压计', '感冒清热', '蒙脱石', '氯雷他定', '二甲双胍', '钙片', '藿香正气'];
const productBase = [];
for (let i = 1; i <= N_SKUS; i++) {
  const cost = round2(3 + rand() * 40);
  productBase.push({
    sku_id: `P${pad(i)}`,
    sku_name: `${NAMES[i % NAMES.length]}${pad(i)}号`,
    category: CATEGORIES[i % CATEGORIES.length],
    specification: `${ri(1, 3) * 8}粒/盒`,
    unit: UNITS[i % UNITS.length],
    unit_cost: cost,
    retail_price: round2(cost * (1.25 + rand() * 0.9)),
    manufacturer: `${['华南', '北方', '仁和', '同仁堂', '扬子江'][i % 5]}药业`,
    is_active: 1,
    effective_from: '1900-01-01',
  });
}
const scdEvents = [
  { sku_idx: 3, date: '2026-10-31', patch: (p) => ({ retail_price: round2(p.retail_price * 1.12) }) },
  { sku_idx: 7, date: '2026-11-02', patch: (p) => ({ unit_cost: round2(p.unit_cost * 1.08), retail_price: round2(p.retail_price * 1.1) }) },
  { sku_idx: 11, date: '2026-11-04', patch: () => ({ manufacturer: '新康缘药业' }) },
  { sku_idx: 15, date: '2026-11-01', patch: () => ({ category: '非处方药' }) },
  { sku_idx: 21, date: '2026-11-06', patch: () => ({ is_active: 0 }) },
  { sku_idx: 26, date: '2026-11-03', patch: () => ({ specification: '24粒/盒' }) },
];
const productRows = productBase.map((p) => ({ ...p }));
for (const ev of scdEvents) {
  const prev = productRows.filter((r) => r.sku_id === `P${pad(ev.sku_idx)}`).slice(-1)[0];
  productRows.push({ ...prev, ...ev.patch(prev), effective_from: ev.date });
}
const productAt = (date) => {
  const m = new Map();
  for (const base of productBase) {
    const events = productRows
      .filter((r) => r.sku_id === base.sku_id && r.effective_from <= date)
      .sort((a, b) => a.effective_from.localeCompare(b.effective_from));
    m.set(base.sku_id, events[events.length - 1]);
  }
  return m;
};

// ---------- 第一阶段：只生成干净流水（唯一事实源） ----------
const openStores = stores.filter((s) => s.status === 'OPEN');
const key = (s, p) => `${s}|${p}`;
const cleanPos = [], cleanPurchase = [], cleanTransfer = [];
let txnSeq = 1, poSeq = 1, tfSeq = 1;

// 期初库存
const opening = new Map();
for (const s of openStores) {
  for (const p of productBase) opening.set(key(s.store_id, p.sku_id), ri(30, 120));
}
// 工作库存（只随流水变更）
const work = new Map(opening);

for (let di = 0; di < N_DAYS; di++) {
  const date = DATES[di];
  const pmap = productAt(date);

  // 销售
  for (const s of openStores) {
    for (const p of productBase) {
      const k = key(s.store_id, p.sku_id);
      if (rand() < 0.55) {
        const qty = Math.min(ri(1, 6), work.get(k));
        if (qty <= 0) continue;
        const prod = pmap.get(p.sku_id);
        const row = {
          txn_no: `T${date.replaceAll('-', '')}${pad(txnSeq++)}`,
          line_no: 1,
          sale_date: date,
          store_id: s.store_id,
          sku_id: p.sku_id,
          qty,
          unit_price: prod.retail_price,
          amount: round2(qty * prod.retail_price),
          unit_cost: prod.unit_cost,
        };
        work.set(k, work.get(k) - qty);
        // 全部真实销售先进 cleanPos；迟到切分在所有流水生成后统一做，避免生成时序耦合
        cleanPos.push(row);
      }
    }
  }

  // 采购入库
  for (const s of openStores) {
    for (const p of productBase) {
      if (rand() < 0.08) {
        const k = key(s.store_id, p.sku_id);
        const qty = ri(10, 60);
        const prod = pmap.get(p.sku_id);
        cleanPurchase.push({
          po_no: `PO${date.replaceAll('-', '')}${pad(poSeq++)}`,
          biz_date: date,
          store_id: s.store_id,
          sku_id: p.sku_id,
          qty,
          unit_cost: prod.unit_cost,
          amount: round2(qty * prod.unit_cost),
        });
        work.set(k, work.get(k) + qty);
      }
    }
  }

  // 调拨：每单 1-2 行，强制同单各行 SKU 不同，避免 (transfer_no,sku_id,from) 主键重复
  for (let t = 0; t < 45; t++) {
    const from = pick(openStores);
    const to = pick(openStores);
    if (to.store_id === from.store_id) continue;
    const tfNo = `TF${date.replaceAll('-', '')}${pad(tfSeq++)}`;
    const lineCnt = ri(1, 2);
    const usedSkus = new Set();
    for (let l = 0; l < lineCnt; l++) {
      let p = pick(productBase);
      let guard = 0;
      while (usedSkus.has(p.sku_id) && guard++ < 10) p = pick(productBase);
      if (usedSkus.has(p.sku_id)) continue;
      usedSkus.add(p.sku_id);
      const kf = key(from.store_id, p.sku_id);
      const qty = Math.min(ri(2, 15), work.get(kf));
      if (qty <= 0) continue;
      cleanTransfer.push({
        transfer_no: tfNo,
        biz_date: date,
        from_store_id: from.store_id,
        to_store_id: to.store_id,
        sku_id: p.sku_id,
        qty,
      });
      work.set(kf, work.get(kf) - qty);
      const kt = key(to.store_id, p.sku_id);
      work.set(kt, work.get(kt) + qty);
    }
  }
}

// ---------- 第二阶段：由流水滚动重算快照（保证与流水严格守恒） ----------
// 注意：滚动基于全部真实 POS（迟到只是文件切分，库存物理上已发生）
const allCleanPos = cleanPos;
const stockCalc = new Map(opening); // 当前滚动库存
const cleanStock = [];
// 锚点
for (const s of openStores) {
  for (const p of productBase) {
    cleanStock.push({ snapshot_date: ANCHOR_DATE, store_id: s.store_id, sku_id: p.sku_id, on_hand_qty: opening.get(key(s.store_id, p.sku_id)) });
  }
}
const indexRows = (rows, dfield, store, sku) => {
  const m = new Map();
  for (const r of rows) {
    const k = key(r[store], r[sku]);
    if (!m.has(k)) m.set(k, new Map());
    m.get(k).set(r[dfield], (m.get(k).get(r[dfield]) ?? 0) + r.qty);
  }
  return m;
};
const posIdx = indexRows(allCleanPos, 'sale_date', 'store_id', 'sku_id');
const purIdx = indexRows(cleanPurchase, 'biz_date', 'store_id', 'sku_id');
const tfOutIdx = indexRows(cleanTransfer, 'biz_date', 'from_store_id', 'sku_id');
const tfInIdx = indexRows(cleanTransfer, 'biz_date', 'to_store_id', 'sku_id');

for (const date of DATES) {
  for (const s of openStores) {
    for (const p of productBase) {
      const k = key(s.store_id, p.sku_id);
      const delta =
        (purIdx.get(k)?.get(date) ?? 0) +
        (tfInIdx.get(k)?.get(date) ?? 0) -
        (posIdx.get(k)?.get(date) ?? 0) -
        (tfOutIdx.get(k)?.get(date) ?? 0);
      stockCalc.set(k, stockCalc.get(k) + delta);
      cleanStock.push({ snapshot_date: date, store_id: s.store_id, sku_id: p.sku_id, on_hand_qty: stockCalc.get(k) });
    }
  }
}

// 自检：滚动结果必须与工作库存完全一致
let selfCheckBad = 0;
for (const [k, v] of stockCalc) if (v !== work.get(k)) selfCheckBad++;
if (selfCheckBad) throw new Error(`生成器自检失败：${selfCheckBad} 个键滚动库存与流水不一致`);

// ---------- 第三阶段：迟到数据隔离（流水全部生成后再切分，快照已含这些真实扣减） ----------
// 从 10-28 的成品 POS 中确定性抽 12 笔作为迟到文件
const latePool = cleanPos.filter((r) => r.sale_date === LATE_DATE);
const latePos = latePool.filter((_, i) => i % Math.max(1, Math.floor(latePool.length / 12)) === 0).slice(0, 12);
const latePosKeys = new Set(latePos.map((r) => r.txn_no));
const posMain = cleanPos.filter((r) => !latePosKeys.has(r.txn_no)).map((r) => ({ ...r }));
// 迟到快照：S017 / 2026-11-02 整体移出
const lateStock = cleanStock.filter((r) => r.store_id === 'S017' && r.snapshot_date === '2026-11-02').map((r) => ({ ...r }));
const stockMain = cleanStock.filter((r) => !(r.store_id === 'S017' && r.snapshot_date === '2026-11-02')).map((r) => ({ ...r }));
const purchaseMain = cleanPurchase.map((r) => ({ ...r }));
const transferMain = cleanTransfer.map((r) => ({ ...r }));

// ---------- 第四阶段：脏数据注入（独立脏行，不触碰任何数量账本） ----------
const dirty = [];
const mark = (type, target, expect) => dirty.push({ type, target, expect });
const bizStock = cleanStock.filter((r) => r.snapshot_date !== ANCHOR_DATE);

for (let i = 0; i < 20; i++) {
  const r = { ...pick(cleanPos) };
  if (i % 3 === 0) r.store_id = '';
  else if (i % 3 === 1) r.sku_id = '';
  else r.sale_date = '';
  r.txn_no = `NULL${pad(i)}`;
  posMain.push(r);
}
mark('POS 必填字段空值/非法日期', 'pos.csv ×20', 'DWD 清洗进拒收表，不参与核算');

for (let i = 0; i < 15; i++) posMain.push({ ...cleanPos[i % cleanPos.length] });
mark('POS 重复流水（txn_no+line_no 重复）', 'pos.csv ×15', 'DWD 去重保留一份，质量规则报重复');

for (let i = 0; i < 25; i++) {
  const r = { ...pick(cleanPos) };
  r.txn_no = `AMT${pad(i)}`;
  // 仅篡改金额，数量保持真实；用独立单号且不回写库存，DWD 拒收后不影响数量守恒
  r.amount = round2(r.amount + (rand() < 0.5 ? 1 : -1) * ri(2, 20));
  posMain.push(r);
}
mark('POS 金额对不平 amount ≠ qty×单价（独立单号，数量真实）', 'pos.csv ×25', '金额一致性规则失败，规则可配阻断/警告');

for (let i = 0; i < 8; i++) {
  const r = { ...pick(cleanPos) };
  r.txn_no = `NEG${pad(i)}`;
  r.qty = -ri(1, 5);
  posMain.push(r);
}
mark('POS 负数量/负金额', 'pos.csv ×8', 'DWD 合法值校验拦截');

for (let i = 0; i < 12; i++) {
  const r = { ...pick(cleanPurchase) };
  r.po_no = `PNULL${pad(i)}`;
  if (i % 2) r.store_id = ''; else r.sku_id = '';
  purchaseMain.push(r);
}
for (let i = 0; i < 6; i++) {
  const r = { ...pick(cleanPurchase) };
  r.po_no = `PNEG${pad(i)}`;
  r.qty = -ri(1, 9);
  r.amount = -r.amount;
  purchaseMain.push(r);
}
mark('采购空值 / 负数量负金额', 'purchase.csv ×18', 'DWD 清洗拦截');

// 脏调拨全部使用虚拟调出门店 S997 / 幽灵调入 S999，不引用任何真实库存键，
// 因此 DWD 外键拒收时不会在真实店品上留下守恒缺口
for (let i = 0; i < 10; i++) {
  const r = { ...pick(cleanTransfer) };
  r.transfer_no = `TFSELF${pad(i)}`;
  r.from_store_id = 'S997';
  r.to_store_id = 'S997'; // 同店流转
  transferMain.push(r);
}
for (let i = 0; i < 8; i++) {
  const r = { ...pick(cleanTransfer) };
  r.transfer_no = `TFNULL${pad(i)}`;
  r.from_store_id = ''; // 空门店
  transferMain.push(r);
}
for (let i = 0; i < 6; i++) {
  const r = { ...pick(cleanTransfer) };
  r.transfer_no = `TFGHOST${pad(i)}`;
  r.from_store_id = 'S997';
  r.to_store_id = 'S999'; // 幽灵门店
  transferMain.push(r);
}
mark('调拨同店流转(×10) / 空门店(×8) / 幽灵门店 S999(×6)，均挂虚拟门店不污染真实库存', 'transfer.csv ×24', 'DWD 清洗与外键校验拦截');

// 空值快照：维度置空，天然不与真实快照争主键
for (let i = 0; i < 15; i++) {
  const r = { ...bizStock[i % bizStock.length] };
  if (i % 2) r.store_id = ''; else r.sku_id = '';
  stockMain.push(r);
}
// 负库存：用虚拟门店 S998，避免污染真实 (date,store,sku) 主键
for (let i = 0; i < 5; i++) {
  const r = { ...bizStock[(i + 15) % bizStock.length] };
  r.store_id = 'S998';
  r.on_hand_qty = -ri(1, 10);
  stockMain.push(r);
}
// 重复快照：与干净行完全同值（DWD 去重后数量不变，仅触发重复规则），排除篡改目标
const tamperedKeys = new Set(['S007|2026-11-03|P012', 'S023|2026-11-05|P005']);
const dupPool = bizStock.filter((r) => !tamperedKeys.has(`${r.store_id}|${r.snapshot_date}|${r.sku_id}`));
for (let i = 0; i < 10; i++) stockMain.push({ ...dupPool[(i * 37) % dupPool.length] });
mark('快照空值(×15) / 虚拟门店负库存(×5) / 同值重复(×10)', 'stock.csv ×30', 'DWD 拦截空值负库存 + 去重，真实快照零污染');

// 人为篡改两处有效快照 -> 核心阻断演示（仅有的两个"真实"不平衡）
const tamper = (storeId, dateStr, skuId, delta) => {
  const row = stockMain.find((r) => r.store_id === storeId && r.snapshot_date === dateStr && r.sku_id === skuId);
  if (!row) throw new Error(`篡改目标不存在：${storeId}/${dateStr}/${skuId}`);
  row.on_hand_qty += delta;
  mark(`快照篡改：期末与流水推算差 ${delta}`, `${storeId}/${dateStr}/${skuId}`, '库存平衡规则失败，该门店整天分区阻断，不进 ADS');
};
tamper('S007', '2026-11-03', 'P012', 6);
tamper('S023', '2026-11-05', 'P005', -3);

// ---------- 写文件 ----------
write('dim_store.csv', csv(stores, ['store_id', 'store_name', 'region', 'city', 'open_date', 'status']));
write('dim_product.csv', csv(productRows, ['sku_id', 'sku_name', 'category', 'specification', 'unit', 'unit_cost', 'retail_price', 'manufacturer', 'is_active', 'effective_from']));
write('pos.csv', csv(posMain, ['txn_no', 'line_no', 'sale_date', 'store_id', 'sku_id', 'qty', 'unit_price', 'amount', 'unit_cost']));
write('pos_late.csv', csv(latePos, ['txn_no', 'line_no', 'sale_date', 'store_id', 'sku_id', 'qty', 'unit_price', 'amount', 'unit_cost']));
write('purchase.csv', csv(purchaseMain, ['po_no', 'biz_date', 'store_id', 'sku_id', 'qty', 'unit_cost', 'amount']));
write('transfer.csv', csv(transferMain, ['transfer_no', 'biz_date', 'from_store_id', 'to_store_id', 'sku_id', 'qty']));
write('stock.csv', csv(stockMain, ['snapshot_date', 'store_id', 'sku_id', 'on_hand_qty']));
write('stock_late.csv', csv(lateStock, ['snapshot_date', 'store_id', 'sku_id', 'on_hand_qty']));

write('README.md', `# 测试数据说明（生成器种子 ${SEED}，可重复生成）

- 门店 ${N_STORES} 家（S058 已停业 CLOSED），商品 ${N_SKUS} 个，业务日期 ${FIRST_DATE} ~ ${LAST_DATE} 共 ${N_DAYS} 天
- 期初锚点 ${ANCHOR_DATE}。**流水是唯一事实源，快照由流水滚动计算，结构上保证
  期初 + 采购入库 + 调入 − 销售出库 − 调出 = 期末**
- 商品主数据含 6 个 SCD2 变更事件（调价/换厂/类别更正/停售/规格变更），DWD 拉链表保留历史
- 迟到数据：
  - \`pos_late.csv\`：12 笔业务日期 ${LATE_DATE} 的 POS。未导入前相关门店日平衡失败；导入并从 ${LATE_DATE} 回补后恢复
  - \`stock_late.csv\`：S017 在 2026-11-02 的快照迟到，导入后回补该分区
- 全量数据中**仅有两个真实不平衡**：人为篡改的 S007/2026-11-03、S023/2026-11-05

## 脏数据（均为独立脏行，不污染数量账本）

| # | 类型 | 位置/数量 | 预期 |
| -- | -- | -- | -- |
${dirty.map((d, i) => `| ${i + 1} | ${d.type} | ${d.target} | ${d.expect} |`).join('\n')}

## 演示路径
1. 导入六个主文件并全量运行 DAG -> 质量页看到两个篡改门店日被阻断，看板自动剔除
2. 导入 pos_late.csv 并从 ${LATE_DATE} 回补 -> 迟到导致的阻断解除
3. 导入 stock_late.csv 回补 S017/2026-11-02 快照缺失警告
4. 分层模型页改 SQL（可恢复默认）；调度页看 DAG 与断点重跑
`);

console.log(`✅ 已生成到 ${OUT}`);
console.log(`   门店 ${N_STORES} / 商品 ${N_SKUS} / 天数 ${N_DAYS}，自检不一致键 ${selfCheckBad}`);
console.log(`   POS ${posMain.length} 行（迟到另 ${latePos.length}），采购 ${purchaseMain.length}，调拨 ${transferMain.length}，快照 ${stockMain.length}（迟到另 ${lateStock.length}）`);
console.log(`   脏数据场景 ${dirty.length} 类`);

# 药房数仓 · 浏览器端 DuckDB-WASM 数仓

面向连锁药房（200+ 门店）的**纯浏览器数据仓库**：TypeScript + React + DuckDB-WASM。
数据从本地 CSV 导入，原始文件与配置持久化在浏览器 IndexedDB，DuckDB 在 Web Worker 中做内存计算，
无需任何后端服务、数据不出本机。

## 快速开始

```bash
npm install
npm run gen:data     # 生成带脏数据的测试 CSV 到 public/sample-data（确定性种子，可重复）
npm run dev          # 启动 http://localhost:5173
```

打开后在「数据接入」页点 **⚡ 一键导入全部示例**，再到「任务调度」页点 **全量运行** 即可体验完整链路。

## 验证与构建

```bash
npm run verify       # Node 侧真实 DuckDB 端到端校验（4 个场景，全部断言）
npm run build        # TypeScript 检查 + 生产构建
node tools/smoke-browser.mjs   # Playwright 浏览器冒烟（需先 npm run dev）
```

`verify` 覆盖：ODS→DWD 清洗去重、SCD2 拉链、库存恒等式、质量阻断、幂等重跑、迟到 POS/快照回补。

## 五个功能页面

| 页面 | 能力 |
| -- | -- |
| **数据接入** | 6 类 CSV（门店/商品/POS/采购/调拨/库存快照），字段映射可视化可配，支持中文表头与智能猜列；导入历史与原始文件持久化，刷新自动重放 |
| **分层模型** | ODS/DWD/DWS/ADS 四层，9 个转换任务的 SQL 用 CodeMirror 在线查看/修改/保存/恢复默认，单任务试跑与表预览 |
| **任务调度** | DAG 依赖图（SVG 连线 + 实时状态）、拓扑执行、全量/回补、失败断点重跑、运行历史 |
| **数据质量** | 10 条可配规则（启停、阻断/警告级别、SQL 可编辑、单规则试跑取样）、拒收记录、阻断分区明细 |
| **指标看板** | 库存周转、动销率、毛利按门店/商品出数，销售趋势、大区占比、门店日平衡日历、SCD2 历史版本 |

## 分层模型与核心设计

- **ODS**：`read_csv_auto(all_varchar)` 贴源入库，保留 `load_batch` / `load_ts`，全部字段以字符串保真。
- **DWD**：类型转换、业务主键去重（窗口函数）、空值/负值/外键/金额一致性清洗，拒收行落 `dwd_reject_record`；
  商品维度按 `effective_from` 构建 **SCD2 拉链表**（`effective_from/effective_to/is_current`）。
- **DWS**：
  - `dws_sales_d` 门店×商品×日销售汇总，按业务日期分区，`DELETE 分区 + INSERT` 幂等。
  - `dws_inv_balance_d` 核心守恒表，逐日逐店逐 SKU 核算
    **期末 = 期初 + 采购入库 + 调入 − 销售出库 − 调出**，输出差异与平衡标记。
- **ADS**：门店/商品周期指标 + 全局 KPI。所有金额指标自动剔除 `dq_blocked_partition` 中的门店日。

## 迟到数据与幂等

- 转换 SQL 用占位符 `{{FROM_DATE}}`：全量运行为 `1900-01-01`，回补运行替换为选定业务日期。
- 分区任务只重建 `>= 回补起点` 的分区；全量任务用 `CREATE OR REPLACE`。任意重跑结果一致（幂等）。
- 回补模式下 DWD 全量任务可沿用上轮成功结果（断点），DWS/DQ/ADS 必然重跑。
- 示例：`pos_late.csv`（10-28 的 12 笔 POS，11-10 才到）、`stock_late.csv`（S017 11-02 快照迟到）。

## 质量阻断机制

- 规则 `checkSql` 返回"失败行"，引擎统一计数、取样例、抽取 `(store_id, biz_date)` 写入 `dq_blocked_partition`。
- `block` 级规则失败 → 该门店整天分区隔离，ADS 指标打标 `balance_ok=0` 并剔除；`warn` 级仅记录。
- ODS 层规则的阻断分区额外要求该门店日在 DWD 中真实存在，避免已被清洗的脏行误伤有效分区。

## 测试数据（含脏数据）

`tools/generate-data.mjs` 采用"**流水是唯一事实源，快照由流水滚动计算**"架构，从结构上保证库存恒等式；
脏数据在最后阶段隔离注入，绝不污染数量账本。包含：空值、重复流水、金额对不平、负数量/负库存、
同店调拨、空门店、幽灵外键、重复快照，以及**两处人为篡改的库存快照**（S007/2026-11-03、S023/2026-11-05）。

完整清单见 `public/sample-data/README.md`。

## 技术栈

React 18 · TypeScript · Zustand · DuckDB-WASM（EH worker）· CodeMirror 6 · PapaParse · Vite

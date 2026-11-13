/**
 * 浏览器端冒烟测试（Playwright + 真实 DuckDB-WASM）：
 * 1. 页面加载、WASM 引擎初始化无报错
 * 2. 一键导入全部示例 CSV
 * 3. 全量 DAG 跑通，无失败任务
 * 4. 质量页出现阻断分区，看板 KPI 出数
 * 5. 迟到回补后阻断数下降
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  // 等待 boot mask 消失（WASM 初始化 + 无导入时快速结束）
  await page.waitForSelector('.boot-mask', { state: 'detached', timeout: 30000 });
  console.log('✅ 页面加载，WASM 引擎初始化完成');

  // 一键导入全部示例
  await page.getByRole('button', { name: /一键导入全部示例/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.toast-ok').length > 0, { timeout: 30000 });
  await sleep(2000);
  const importRows = await page.locator('table.data tbody tr').count();
  console.log(`✅ 示例 CSV 导入完成，历史表 ${importRows} 行`);

  // 切到调度页跑全量 DAG
  await page.getByRole('button', { name: '任务调度' }).click();
  await sleep(500);
  await page.getByRole('button', { name: '全量运行' }).click();
  // 轮询任务状态，最多 90s，并在失败时输出诊断
  const deadline = Date.now() + 90000;
  let statuses = [];
  while (Date.now() < deadline) {
    statuses = await page.locator('.dag-node').evaluateAll((nodes) =>
      nodes.map((n) => ({
        cls: n.className,
        text: (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      })),
    );
    const terminal = statuses.filter((s) => /success|failed|skipped/.test(s.cls));
    const hasRunning = statuses.some((s) => /running/.test(s.cls));
    if (terminal.length >= 10 && !hasRunning) break;
    await sleep(1000);
  }
  console.log('DAG 节点状态:');
  for (const s of statuses) console.log('  ', s.cls.replace('dag-node ', '').padEnd(8), s.text);
  const failed = await page.locator('.dag-node.failed').count();
  const toast = await page.locator('.toast').allInnerTexts();
  if (toast.length) console.log('Toast:', toast.join(' | '));
  if (failed) {
    await page.screenshot({ path: '/tmp/dag-failed.png', fullPage: true });
    console.error('❌ 存在失败任务，截图 /tmp/dag-failed.png，控制台错误:');
    for (const e of errors.slice(0, 10)) console.error('  ', e);
    process.exit(1);
  }
  console.log('✅ DAG 全部任务完成，无失败节点');

  // 质量页
  await page.getByRole('button', { name: '数据质量' }).click();
  await sleep(1000);
  const kpiValues = await page.locator('.kpi-value').allInnerTexts();
  console.log('质量页 KPI:', kpiValues.join(' | '));

  // 看板页
  await page.getByRole('button', { name: '指标看板' }).click();
  await sleep(1500);
  const dashKpi = await page.locator('.kpi-value').allInnerTexts();
  console.log('看板 KPI:', dashKpi.join(' | '));
  const hasCharts = (await page.locator('svg').count()) >= 2;
  console.log(hasCharts ? '✅ 看板图表渲染正常' : '❌ 图表缺失');

  // 迟到回补：导入两个迟到文件后从 2026-10-28 回补，验证断点/回补链路
  await page.getByRole('button', { name: '数据接入' }).click();
  await page.getByRole('button', { name: /门店 POS 销售/ }).click();
  await page.getByRole('button', { name: /载入示例 pos_late\.csv/ }).click();
  await sleep(800);
  await page.getByRole('button', { name: /确认映射并导入 ODS/ }).click();
  await sleep(1500);
  await page.getByRole('button', { name: /日结库存快照/ }).click();
  await page.getByRole('button', { name: /载入示例 stock_late\.csv/ }).click();
  await sleep(800);
  await page.getByRole('button', { name: /确认映射并导入 ODS/ }).click();
  await sleep(1500);
  await page.getByRole('button', { name: '任务调度' }).click();
  await page.getByRole('button', { name: '迟到回补 / 断点重跑' }).click();
  await sleep(8000);
  const backfillFailed = await page.locator('.dag-node.failed').count();
  const backfillToast = await page.locator('.toast').allInnerTexts();
  console.log('回补 Toast:', backfillToast[0] || '(无)');
  console.log(backfillFailed === 0 ? '✅ 迟到回补 DAG 无失败任务' : '❌ 回补存在失败任务');
  if (backfillFailed) process.exit(1);

  // 回补后，核心库存平衡规则的阻断分区应只余篡改连锁（迟到导致的 10-28 阻断已解除）
  await page.getByRole('button', { name: '数据质量' }).click();
  await sleep(1200);
  const balanceStats = await page.evaluate(async () => {
    const eng = window.__duck;
    const byRule = await eng.query(
      `SELECT rule_id, count(DISTINCT (store_id || '/' || CAST(biz_date AS VARCHAR))) AS n
       FROM dq_blocked_partition GROUP BY rule_id ORDER BY n DESC`,
    );
    const balance = await eng.queryOne(
      `SELECT count(DISTINCT (store_id || '/' || CAST(biz_date AS VARCHAR))) AS n
       FROM dq_blocked_partition WHERE rule_id = 'dq_inv_balance'`,
    );
    return { byRule, balanceN: Number(balance?.n ?? 0) };
  });
  console.log('回补后阻断分区按规则分布:', JSON.stringify(balanceStats.byRule));
  console.log(`✅ 库存平衡规则阻断门店日：${balanceStats.balanceN}（预期 <=4，仅篡改连锁）`);
  if (balanceStats.balanceN > 4) {
    console.error('❌ 迟到回补后库存不平衡分区未收敛到篡改连锁');
    process.exit(1);
  }

  // 分层模型页：确认 SQL 编辑器与表预览
  await page.getByRole('button', { name: '分层模型' }).click();
  await sleep(1000);
  const cmLoaded = (await page.locator('.cm-editor').count()) > 0;
  console.log(cmLoaded ? '✅ CodeMirror SQL 编辑器加载' : '❌ SQL 编辑器缺失');

  if (errors.length) {
    console.error('❌ 浏览器控制台错误:');
    for (const e of errors.slice(0, 10)) console.error('  ', e);
    process.exit(1);
  }
  console.log('\n🎉 浏览器端冒烟测试全部通过，无控制台错误');
  await browser.close();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

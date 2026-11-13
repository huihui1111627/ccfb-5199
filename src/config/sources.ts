import type { SourceConfig, SourceKind } from '../types';

/**
 * 六类数据源的标准结构与默认字段映射。
 * 映射可在导入页配置：标准字段 <- CSV 实际列名。
 */
export const SOURCE_CONFIGS: Record<SourceKind, SourceConfig> = {
  store: {
    kind: 'store',
    label: '门店主数据',
    odsTable: 'ods_store',
    bizDateField: null,
    bizKey: ['store_id'],
    standardFields: [
      { name: 'store_id', type: 'VARCHAR', desc: '门店编码' },
      { name: 'store_name', type: 'VARCHAR', desc: '门店名称' },
      { name: 'region', type: 'VARCHAR', desc: '大区' },
      { name: 'city', type: 'VARCHAR', desc: '城市' },
      { name: 'open_date', type: 'DATE', desc: '开业日期' },
      { name: 'status', type: 'VARCHAR', desc: '状态 OPEN/CLOSED' },
    ],
    defaultMapping: {
      store_id: 'store_id', store_name: 'store_name', region: 'region', city: 'city',
      open_date: 'open_date', status: 'status',
    },
  },
  product: {
    kind: 'product',
    label: '商品主数据（含变更生效日）',
    odsTable: 'ods_product',
    bizDateField: null,
    bizKey: ['sku_id', 'effective_from'],
    standardFields: [
      { name: 'sku_id', type: 'VARCHAR', desc: '商品编码' },
      { name: 'sku_name', type: 'VARCHAR', desc: '商品名称' },
      { name: 'category', type: 'VARCHAR', desc: '品类' },
      { name: 'specification', type: 'VARCHAR', desc: '规格' },
      { name: 'unit', type: 'VARCHAR', desc: '单位' },
      { name: 'unit_cost', type: 'DOUBLE', desc: '单位成本' },
      { name: 'retail_price', type: 'DOUBLE', desc: '零售价' },
      { name: 'manufacturer', type: 'VARCHAR', desc: '生产厂家' },
      { name: 'is_active', type: 'INTEGER', desc: '是否在售 1/0' },
      { name: 'effective_from', type: 'DATE', desc: '本行属性生效日（SCD2 原料）' },
    ],
    defaultMapping: {
      sku_id: 'sku_id', sku_name: 'sku_name', category: 'category', specification: 'specification',
      unit: 'unit', unit_cost: 'unit_cost', retail_price: 'retail_price', manufacturer: 'manufacturer',
      is_active: 'is_active', effective_from: 'effective_from',
    },
  },
  pos: {
    kind: 'pos',
    label: '门店 POS 销售',
    odsTable: 'ods_pos',
    bizDateField: 'sale_date',
    bizKey: ['txn_no', 'line_no'],
    standardFields: [
      { name: 'txn_no', type: 'VARCHAR', desc: '交易单号' },
      { name: 'line_no', type: 'INTEGER', desc: '行号' },
      { name: 'sale_date', type: 'DATE', desc: '销售业务日期' },
      { name: 'store_id', type: 'VARCHAR', desc: '门店编码' },
      { name: 'sku_id', type: 'VARCHAR', desc: '商品编码' },
      { name: 'qty', type: 'INTEGER', desc: '销售数量' },
      { name: 'unit_price', type: 'DOUBLE', desc: '成交单价' },
      { name: 'amount', type: 'DOUBLE', desc: '销售金额' },
      { name: 'unit_cost', type: 'DOUBLE', desc: '单位成本' },
    ],
    defaultMapping: {
      txn_no: 'txn_no', line_no: 'line_no', sale_date: 'sale_date', store_id: 'store_id',
      sku_id: 'sku_id', qty: 'qty', unit_price: 'unit_price', amount: 'amount', unit_cost: 'unit_cost',
    },
  },
  purchase: {
    kind: 'purchase',
    label: '采购入库',
    odsTable: 'ods_purchase',
    bizDateField: 'biz_date',
    bizKey: ['po_no'],
    standardFields: [
      { name: 'po_no', type: 'VARCHAR', desc: '采购单号' },
      { name: 'biz_date', type: 'DATE', desc: '入库业务日期' },
      { name: 'store_id', type: 'VARCHAR', desc: '入库门店' },
      { name: 'sku_id', type: 'VARCHAR', desc: '商品编码' },
      { name: 'qty', type: 'INTEGER', desc: '入库数量' },
      { name: 'unit_cost', type: 'DOUBLE', desc: '单位成本' },
      { name: 'amount', type: 'DOUBLE', desc: '入库金额' },
    ],
    defaultMapping: {
      po_no: 'po_no', biz_date: 'biz_date', store_id: 'store_id', sku_id: 'sku_id',
      qty: 'qty', unit_cost: 'unit_cost', amount: 'amount',
    },
  },
  transfer: {
    kind: 'transfer',
    label: '门店调拨',
    odsTable: 'ods_transfer',
    bizDateField: 'biz_date',
    bizKey: ['transfer_no', 'sku_id', 'from_store_id'],
    standardFields: [
      { name: 'transfer_no', type: 'VARCHAR', desc: '调拨单号' },
      { name: 'biz_date', type: 'DATE', desc: '调拨业务日期' },
      { name: 'from_store_id', type: 'VARCHAR', desc: '调出门店' },
      { name: 'to_store_id', type: 'VARCHAR', desc: '调入门店' },
      { name: 'sku_id', type: 'VARCHAR', desc: '商品编码' },
      { name: 'qty', type: 'INTEGER', desc: '调拨数量' },
    ],
    defaultMapping: {
      transfer_no: 'transfer_no', biz_date: 'biz_date', from_store_id: 'from_store_id',
      to_store_id: 'to_store_id', sku_id: 'sku_id', qty: 'qty',
    },
  },
  stock: {
    kind: 'stock',
    label: '日结库存快照',
    odsTable: 'ods_stock',
    bizDateField: 'snapshot_date',
    bizKey: ['snapshot_date', 'store_id', 'sku_id'],
    standardFields: [
      { name: 'snapshot_date', type: 'DATE', desc: '快照业务日期' },
      { name: 'store_id', type: 'VARCHAR', desc: '门店编码' },
      { name: 'sku_id', type: 'VARCHAR', desc: '商品编码' },
      { name: 'on_hand_qty', type: 'INTEGER', desc: '账面库存数量' },
    ],
    defaultMapping: {
      snapshot_date: 'snapshot_date', store_id: 'store_id', sku_id: 'sku_id', on_hand_qty: 'on_hand_qty',
    },
  },
};

export const SOURCE_ORDER: SourceKind[] = ['store', 'product', 'pos', 'purchase', 'transfer', 'stock'];

import type { TaskStatus } from '../types';

const MAP: Record<TaskStatus, { cls: string; text: string }> = {
  pending: { cls: 'badge-gray', text: '待运行' },
  running: { cls: 'badge-blue', text: '运行中' },
  success: { cls: 'badge-green', text: '成功' },
  failed: { cls: 'badge-red', text: '失败' },
  skipped: { cls: 'badge-gray', text: '已跳过' },
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const m = MAP[status];
  const dot = { success: 'dot-green', failed: 'dot-red', running: 'dot-blue', pending: 'dot-gray', skipped: 'dot-gray' }[status];
  return (
    <span className={`badge ${m.cls}`}>
      <span className={`dot ${dot}`} style={{ display: status === 'running' ? 'inline-block' : 'inline-block' }} />
      {m.text}
    </span>
  );
}

export function LayerBadge({ layer }: { layer: string }) {
  const cls: Record<string, string> = {
    ODS: 'badge-cyan',
    DWD: 'badge-blue',
    DWS: 'badge-purple',
    ADS: 'badge-green',
    DQ: 'badge-amber',
    SRC: 'badge-gray',
  };
  return <span className={`badge ${cls[layer] ?? 'badge-gray'}`}>{layer}</span>;
}

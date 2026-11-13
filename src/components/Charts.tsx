import { useMemo } from 'react';

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a78bfa', '#22d3ee', '#f472b6', '#fb923c', '#94a3b8'];

export interface Series {
  label: string;
  color?: string;
  points: { x: string; y: number }[];
}

/** 多序列折线图（纯 SVG） */
export function LineChart({ series, height = 240, yLabel = '' }: { series: Series[]; height?: number; yLabel?: string }) {
  const W = 720;
  const H = height;
  const padL = 56;
  const padR = 16;
  const padT = 14;
  const padB = 44;
  const xs = useMemo(() => [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort(), [series]);
  const maxY = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.y)));
  const xAt = (i: number) => padL + (xs.length <= 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (xs.length - 1));
  const yAt = (y: number) => padT + (1 - y / maxY) * (H - padT - padB);
  const ticks = 4;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img">
      {Array.from({ length: ticks + 1 }, (_, i) => {
        const y = padT + (i * (H - padT - padB)) / ticks;
        const val = maxY * (1 - i / ticks);
        return (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y} y2={y} stroke="#2c3a57" strokeWidth={1} strokeDasharray="3 4" />
            <text x={padL - 8} y={y + 4} textAnchor="end" fontSize={10} fill="#66748f">
              {compact(val)}
            </text>
          </g>
        );
      })}
      {xs.map((x, i) => (
        <text key={x} x={xAt(i)} y={H - padB + 18} textAnchor="middle" fontSize={10} fill="#66748f">
          {x.slice(5)}
        </text>
      ))}
      {yLabel && (
        <text x={14} y={padT + 6} fontSize={10} fill="#66748f">
          {yLabel}
        </text>
      )}
      {series.map((s, si) => {
        const color = s.color ?? COLORS[si % COLORS.length];
        const map = new Map(s.points.map((p) => [p.x, p.y]));
        const d = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)},${yAt(map.get(x) ?? 0)}`).join(' ');
        return (
          <g key={s.label}>
            <path d={d} fill="none" stroke={color} strokeWidth={2} />
            {xs.map((x, i) =>
              map.has(x) ? <circle key={x} cx={xAt(i)} cy={yAt(map.get(x)!)} r={2.6} fill={color} /> : null,
            )}
          </g>
        );
      })}
      <g transform={`translate(${padL}, ${H - 12})`}>
        {series.map((s, i) => (
          <g key={s.label} transform={`translate(${i * 130}, 0)`}>
            <rect width={10} height={10} rx={2} fill={s.color ?? COLORS[i % COLORS.length]} />
            <text x={15} y={9} fontSize={11} fill="#93a1bd">
              {s.label}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

/** 横向条形图（排名） */
export function BarChart({
  data,
  height = 280,
  formatVal = compact,
}: {
  data: { label: string; value: number; sub?: string }[];
  height?: number;
  formatVal?: (n: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const rowH = 26;
  const labelW = 130;
  const valW = 90;
  const W = 720;
  const H = Math.max(height, data.length * rowH + 10);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
      {data.map((d, i) => {
        const y = i * rowH + 6;
        const w = ((W - labelW - valW - 20) * d.value) / max;
        return (
          <g key={d.label}>
            <text x={labelW - 8} y={y + 13} textAnchor="end" fontSize={11} fill="#c8d3e8">
              {d.label.length > 11 ? d.label.slice(0, 10) + '…' : d.label}
            </text>
            <rect x={labelW} y={y + 3} width={Math.max(2, w)} height={16} rx={3} fill={COLORS[i % COLORS.length]} opacity={0.9} />
            <text x={labelW + w + 8} y={y + 15} fontSize={11} fill="#93a1bd">
              {formatVal(d.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** 环形图（分类占比） */
export function DonutChart({ data, size = 210 }: { data: { label: string; value: number }[]; size?: number }) {
  const total = data.reduce((a, b) => a + b.value, 0) || 1;
  const r = size / 2 - 8;
  const cx = size / 2;
  const cy = size / 2;
  let angle = -Math.PI / 2;
  const arcs = data.map((d, i) => {
    const frac = d.value / total;
    const a0 = angle;
    const a1 = angle + frac * Math.PI * 2;
    angle = a1;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const [x0, y0] = p(a0);
    const [x1, y1] = p(a1);
    return { d: `M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1}`, color: COLORS[i % COLORS.length], ...d, frac };
  });
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {arcs.map((a) => (
          <path key={a.label} d={a.d} fill="none" stroke={a.color} strokeWidth={17} />
        ))}
        <text x={cx} y={cy - 2} textAnchor="middle" fontSize={15} fontWeight={700} fill="#e6ebf5">
          {compact(total)}
        </text>
        <text x={cx} y={cy + 16} textAnchor="middle" fontSize={10} fill="#66748f">
          合计
        </text>
      </svg>
      <div style={{ paddingTop: 10 }}>
        {arcs.map((a) => (
          <div key={a.label} className="row" style={{ gap: 8, marginBottom: 7 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: a.color, display: 'inline-block' }} />
            <span className="dim" style={{ minWidth: 90 }}>
              {a.label}
            </span>
            <span style={{ fontSize: 12 }}>{(a.frac * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (abs >= 1e4) return (n / 1e4).toFixed(1) + '万';
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toFixed(2);
}

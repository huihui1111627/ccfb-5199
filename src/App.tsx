import { useEffect, useState } from 'react';
import { useStore } from './store/useStore';
import { IngestPage } from './pages/IngestPage';
import { LayerPage } from './pages/LayerPage';
import { SchedulePage } from './pages/SchedulePage';
import { QualityPage } from './pages/QualityPage';
import { DashboardPage } from './pages/DashboardPage';

const NAV = [
  { id: 'ingest', label: '数据接入', icon: '⇪' },
  { id: 'layer', label: '分层模型', icon: '▤' },
  { id: 'schedule', label: '任务调度', icon: '⟳' },
  { id: 'quality', label: '数据质量', icon: '✓' },
  { id: 'dashboard', label: '指标看板', icon: '▥' },
] as const;
type NavId = (typeof NAV)[number]['id'];

export default function App() {
  const [nav, setNav] = useState<NavId>('ingest');
  const { booting, bootMsg, toast, init } = useStore();

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          药房数仓
          <small>DuckDB-WASM · 浏览器内运行</small>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <button key={n.id} className={`nav-item ${nav === n.id ? 'active' : ''}`} onClick={() => setNav(n.id)}>
              <span className="nav-icon">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          数据仅存于本浏览器
          <br />
          IndexedDB + 内存 DuckDB
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <h1>{NAV.find((n) => n.id === nav)?.label}</h1>
          <span className="spacer" />
          <span className="muted" style={{ fontSize: 12 }}>
            ODS → DWD → DWS → ADS · SCD2 · 迟到回补 · 质量阻断
          </span>
        </header>
        <div className="content">
          {nav === 'ingest' && <IngestPage />}
          {nav === 'layer' && <LayerPage />}
          {nav === 'schedule' && <SchedulePage />}
          {nav === 'quality' && <QualityPage />}
          {nav === 'dashboard' && <DashboardPage />}
        </div>
      </main>
      {booting && (
        <div className="boot-mask">
          <div className="spinner" />
          <div className="dim">{bootMsg || '启动中…'}</div>
        </div>
      )}
      {toast && <div className={`toast toast-${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}

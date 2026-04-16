const DASHBOARD_CURRENT_MGR_ID = '__DASHBOARD_CURRENT_MGR_ID__';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderDashboardHtml(currentMgrId: string): string {
  return DASHBOARD_HTML_TEMPLATE.replace(
    DASHBOARD_CURRENT_MGR_ID,
    escapeHtml(currentMgrId || '-'),
  );
}

const DASHBOARD_HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SmartCube 중계서버 모니터</title>
<style>
  :root {
    --bg: #0a0a0f; --surface: #12121a; --surface2: #1a1a26; --surface3: #22222e;
    --border: #2a2a3a; --border2: #333346;
    --text: #e4e4ef; --text2: #9494a8; --text3: #5e5e72;
    --blue: #6c8cff; --blue-glow: rgba(108,140,255,0.15);
    --green: #34d399; --green-dim: #22c55e; --green-glow: rgba(52,211,153,0.12);
    --red: #f87171; --red-glow: rgba(248,113,113,0.15);
    --amber: #fbbf24; --amber-glow: rgba(251,191,36,0.12);
    --purple: #a78bfa;
    --accent: #4b5fc7;
    --gradient-blue: linear-gradient(135deg, #6c8cff 0%, #818cf8 100%);
    --gradient-green: linear-gradient(135deg, #34d399 0%, #22c55e 100%);
    --gradient-red: linear-gradient(135deg, #f87171 0%, #fb923c 100%);
    --gradient-amber: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    background: var(--bg); color: var(--text); min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }

  .shell { max-width: 1320px; margin: 0 auto; padding: 28px 32px; }

  /* ── Header ── */
  .hdr { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; }
  .hdr-left h1 { font-size: 20px; font-weight: 700; color: var(--text); letter-spacing: -0.3px; }
  .hdr-left p { font-size: 12px; color: var(--text3); margin-top: 4px; }
  .hdr-right { display: flex; align-items: stretch; gap: 12px; flex-wrap: wrap; }
  .logout-form { margin: 0; }
  .hdr-section {
    display: flex; flex-direction: column; gap: 8px;
    padding: 10px 12px; border-radius: 14px;
    background: rgba(255,255,255,0.02); border: 1px solid var(--border);
  }
  .hdr-section-label {
    font-size: 10px; font-weight: 700; letter-spacing: 0.4px;
    text-transform: uppercase; color: var(--text3);
  }
  .hdr-section-body {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  }

  .conn-badge {
    display: flex; align-items: center; gap: 7px;
    padding: 6px 14px; border-radius: 20px; font-size: 11px; font-weight: 600;
    background: var(--surface2); border: 1px solid var(--border); color: var(--text3);
    transition: all 0.3s;
  }
  .conn-badge.live { background: rgba(52,211,153,0.08); border-color: rgba(52,211,153,0.2); color: var(--green); }
  .conn-badge.dead { background: rgba(248,113,113,0.08); border-color: rgba(248,113,113,0.2); color: var(--red); }
  .conn-dot {
    width: 7px; height: 7px; border-radius: 50%; background: var(--text3);
    transition: background 0.3s;
  }
  .conn-badge.live .conn-dot { background: var(--green); box-shadow: 0 0 6px var(--green); animation: pulse 2s infinite; }
  .conn-badge.dead .conn-dot { background: var(--red); }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.35; } }

  .last-recv {
    font-size: 12px; font-weight: 500; color: var(--text2);
    font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
  }
  .mgr-id {
    font-size: 12px; font-weight: 600; color: var(--text2);
    padding: 6px 12px; border-radius: 12px;
    background: var(--surface2); border: 1px solid var(--border);
    font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
  }

  .filter-group { display: flex; gap: 4px; }
  .filter-btn {
    padding: 6px 12px; border-radius: 8px; font-size: 11px; font-weight: 600;
    background: var(--surface2); border: 1px solid var(--border); color: var(--text3);
    cursor: pointer; transition: all 0.15s;
  }
  .filter-btn:hover { background: var(--surface3); color: var(--text2); }
  .filter-btn.active { background: rgba(108,140,255,0.1); border-color: rgba(108,140,255,0.3); color: var(--blue); }
  .source-badge {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 42px; padding: 4px 8px; border-radius: 6px;
    font-size: 11px; font-weight: 600; line-height: 1;
    white-space: nowrap; border: 1px solid transparent;
  }
  .source-badge.webhook { background: rgba(108,140,255,0.12); border-color: rgba(108,140,255,0.22); color: var(--blue); }
  .source-badge.scheduler { background: rgba(167,139,250,0.12); border-color: rgba(167,139,250,0.22); color: var(--purple); }
  .source-badge.site-sync { background: rgba(52,211,153,0.12); border-color: rgba(52,211,153,0.22); color: var(--green); }
  .source-badge.user-sync { background: rgba(251,191,36,0.12); border-color: rgba(251,191,36,0.22); color: var(--amber); }


  /* ── Grid Layout ── */
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
  @media (max-width: 1000px) { .grid { grid-template-columns: 1fr; } }

  .panel {
    background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
    overflow: hidden;
  }
  .panel-hd {
    padding: 14px 20px; display: flex; justify-content: space-between; align-items: center;
    border-bottom: 1px solid var(--border);
  }
  .panel-hd h2 { font-size: 13px; font-weight: 700; color: var(--text); }
  .panel-hd .tag {
    font-size: 11px; color: var(--text3); background: var(--surface2); padding: 3px 10px;
    border-radius: 8px; font-weight: 600;
  }
  .panel-bd { padding: 14px 20px; }

  /* ── Bar chart ── */
  .bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .bar-row:last-child { margin-bottom: 0; }
  .bar-lbl {
    width: 120px; font-size: 12px; color: var(--text2); font-weight: 500;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0;
  }
  .bar-track {
    flex: 1; height: 22px; background: var(--surface2); border-radius: 6px;
    overflow: hidden; position: relative;
  }
  .bar-ok {
    height: 100%; background: var(--blue); border-radius: 6px;
    transition: width 0.6s cubic-bezier(0.16,1,0.3,1);
    opacity: 0.85;
  }
  .bar-err {
    position: absolute; top: 0; right: 0; height: 100%;
    background: var(--red); opacity: 0.7; border-radius: 0 6px 6px 0;
    transition: width 0.6s cubic-bezier(0.16,1,0.3,1);
  }
  .bar-num { min-width: 40px; text-align: right; font-size: 12px; font-weight: 700; color: var(--text2); font-variant-numeric: tabular-nums; }

  /* ── Tables ── */
  table { width: 100%; border-collapse: collapse; }
  thead th {
    font-size: 11px; color: var(--text3); font-weight: 600; text-align: left;
    padding: 10px 16px; text-transform: uppercase; letter-spacing: 0.4px;
    border-bottom: 1px solid var(--border); background: var(--surface2);
  }
  tbody td {
    padding: 10px 16px; font-size: 12px; border-bottom: 1px solid rgba(42,42,58,0.5);
    vertical-align: top;
  }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr { transition: background 0.15s; }
  tbody tr:hover td { background: var(--surface2); }

  /* Row flash animation */
  @keyframes rowFlash {
    0% { background: rgba(108,140,255,0.15); }
    100% { background: transparent; }
  }
  @keyframes rowFlashError {
    0% { background: rgba(248,113,113,0.18); }
    100% { background: transparent; }
  }
  tr.flash td { animation: rowFlash 1.5s ease-out; }
  tr.flash-err td { animation: rowFlashError 2s ease-out; }

  .chip {
    display: inline-block; padding: 2px 8px; border-radius: 4px;
    font-size: 10px; font-weight: 700; letter-spacing: 0.3px;
    white-space: nowrap;
  }
  .chip.ok { background: rgba(52,211,153,0.12); color: var(--green); }
  .chip.fail { background: rgba(248,113,113,0.12); color: var(--red); }

  .ev-name { color: var(--blue); font-weight: 500; font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace; font-size: 11px; }
  .ev-sub { font-size: 10px; color: var(--text3); }
  .dur { color: var(--text3); font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace; font-size: 11px; font-variant-numeric: tabular-nums; }
  .ts { color: var(--text2); font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace; font-size: 11px; }
  .err-msg { color: var(--red); font-size: 11px; line-height: 1.6; }

  .payload-toggle {
    display: inline-block; margin-top: 4px; padding: 2px 8px;
    background: var(--surface2); border: 1px solid var(--border); border-radius: 4px;
    font-size: 10px; color: var(--text3); cursor: pointer; transition: all 0.15s;
  }
  .payload-toggle:hover { background: var(--surface3); color: var(--text2); }
  .payload-box {
    display: none; margin-top: 8px; padding: 10px 12px;
    background: var(--surface2); border: 1px solid var(--border); border-radius: 8px;
    font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
    font-size: 10px; color: var(--text2); white-space: pre-wrap;
    max-height: 180px; overflow: auto; line-height: 1.7;
  }
  .payload-box.open { display: block; }
  .scroll-panel { max-height: 320px; overflow-y: auto; }
  .tab-group { display: flex; gap: 4px; }
  .tab-btn {
    padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 600;
    background: var(--surface2); border: 1px solid var(--border); color: var(--text3);
    cursor: pointer; transition: all 0.15s;
  }
  .tab-btn:hover { background: var(--surface3); color: var(--text2); }
  .tab-btn.active { background: rgba(108,140,255,0.1); border-color: rgba(108,140,255,0.3); color: var(--blue); }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .sched-type {
    display: inline-block; padding: 2px 6px; border-radius: 4px;
    font-size: 9px; font-weight: 700; letter-spacing: 0.3px;
    white-space: nowrap;
  }
  .sched-type.in { background: rgba(52,211,153,0.12); color: var(--green); }
  .sched-type.out { background: rgba(251,191,36,0.12); color: var(--amber); }
  .empty { text-align: center; padding: 28px; color: var(--text3); font-size: 12px; }

  /* ── Feed row toggle detail ── */
  tr.feed-row { cursor: pointer; }
  tr.feed-row:hover td { background: var(--surface2); }
  tr.feed-detail { display: none; }
  tr.feed-detail.open { display: table-row; }
  tr.feed-detail td {
    padding: 0 16px 14px 16px; border-bottom: 1px solid rgba(42,42,58,0.5);
    background: var(--surface);
  }
  .detail-wrap {
    padding: 12px 14px; background: var(--surface2); border: 1px solid var(--border);
    border-radius: 10px; display: flex; flex-direction: column; gap: 8px;
  }
  .detail-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 6px 16px;
  }
  .detail-item { font-size: 11px; }
  .detail-label { color: var(--text3); font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 2px; }
  .detail-val { color: var(--text2); font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace; font-size: 11px; word-break: break-all; }
  .detail-val.err { color: var(--red); }
  .detail-payload {
    margin-top: 4px; padding: 10px 12px;
    background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
    font-size: 10px; color: var(--text2); white-space: pre-wrap;
    max-height: 200px; overflow: auto; line-height: 1.7;
  }
  .detail-payload-label {
    font-size: 10px; font-weight: 600; color: var(--text3);
    text-transform: uppercase; letter-spacing: 0.3px;
  }
  .detail-actions {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding-top: 2px;
  }
  .detail-hint {
    font-size: 11px; color: var(--text3);
  }
  .retry-btn {
    height: 28px; padding: 0 12px; border-radius: 8px; border: 1px solid rgba(108,140,255,0.24);
    background: rgba(108,140,255,0.12); color: var(--blue); font-size: 11px; font-weight: 700;
    cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  }
  .retry-btn:hover { background: rgba(108,140,255,0.18); }
  .retry-btn:disabled {
    cursor: default; opacity: 0.45; background: var(--surface3); color: var(--text3); border-color: var(--border);
  }
  tr.feed-row.expanded > td { background: var(--surface2); }

  .feed-toolbar {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  }
  .feed-subtoolbar {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    padding: 12px 20px;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    background: rgba(255,255,255,0.01);
  }
  .feed-select {
    height: 32px; padding: 0 10px; border-radius: 8px; font-size: 11px; font-weight: 600;
    background: var(--surface2); border: 1px solid var(--border); color: var(--text2);
    cursor: pointer; outline: none; appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%235e5e72'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 8px center;
    padding-right: 24px;
    transition: all 0.15s;
  }
  .feed-select:hover { border-color: var(--border2); color: var(--text); }
  .feed-select:focus { border-color: rgba(108,140,255,0.4); }
  .feed-filter-wrap { position: relative; }
  .feed-filter-btn {
    height: 32px; padding: 0 10px; border-radius: 8px; font-size: 11px; font-weight: 600;
    background: var(--surface2); border: 1px solid var(--border); color: var(--text2);
    cursor: pointer; outline: none; display: inline-flex; align-items: center; gap: 6px;
    transition: all 0.15s;
  }
  .feed-filter-btn:hover { border-color: var(--border2); color: var(--text); }
  .control-btn {
    height: 32px; padding: 0 16px; border-radius: 8px; border: none;
    color: #fff; font-size: 12px; font-weight: 600; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .control-btn:disabled {
    cursor: default; opacity: 0.45;
  }
  .check-inline {
    display: inline-flex; align-items: center; gap: 6px; min-height: 32px;
    color: var(--text3); font-weight: 500; font-size: 12px; cursor: pointer;
  }
  .check-inline input { width: 14px; height: 14px; }
  .feed-filter-menu {
    position: absolute; top: calc(100% + 6px); left: 0; min-width: 160px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0,0,0,0.35); padding: 8px; z-index: 20; display: none;
  }
  .feed-filter-menu.open { display: block; }
  .feed-filter-item {
    display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px;
    font-size: 12px; color: var(--text2); cursor: pointer;
  }
  .feed-input {
    height: 32px; min-width: 240px; padding: 0 12px; border-radius: 8px;
    background: var(--surface2); border: 1px solid var(--border); color: var(--text);
    font-size: 12px; outline: none;
  }
  .feed-input:focus { border-color: rgba(108,140,255,0.45); }
  .feed-search-note {
    display: none; align-items: center; justify-content: space-between; gap: 8px;
    margin-top: 10px; padding: 10px 12px; border-radius: 10px;
    background: rgba(108,140,255,0.08); border: 1px solid rgba(108,140,255,0.2);
    color: var(--text2); font-size: 12px;
  }
  .feed-search-note.visible { display: flex; }
  .feed-search-note button {
    height: 28px; padding: 0 12px; border: none; border-radius: 8px;
    background: var(--accent); color: #fff; font-size: 11px; font-weight: 700; cursor: pointer;
  }
  .feed-filter-item:hover { background: var(--surface2); color: var(--text); }
  .feed-filter-item input { width: 14px; height: 14px; }

  .paging {
    display: flex; justify-content: center; align-items: center; gap: 4px;
    padding: 12px 20px; border-top: 1px solid var(--border);
  }
  .paging:empty { display: none; }
  .pg-btn {
    min-width: 32px; padding: 5px 8px; border-radius: 6px; font-size: 11px; font-weight: 600;
    background: var(--surface2); border: 1px solid var(--border); color: var(--text3);
    cursor: pointer; transition: all 0.15s; text-align: center;
  }
  .pg-btn:hover { background: var(--surface3); color: var(--text2); }
  .pg-btn.active { background: rgba(108,140,255,0.1); border-color: rgba(108,140,255,0.3); color: var(--blue); }
  .pg-btn:disabled { opacity: 0.3; cursor: default; }
  .pg-info { font-size: 11px; color: var(--text3); margin: 0 8px; }
  .pg-dots { color: var(--text3); font-size: 11px; padding: 0 4px; }

  /* ── Toast Notification ── */
  .toast-container {
    position: fixed; top: 20px; right: 20px; z-index: 9999;
    display: flex; flex-direction: column; gap: 8px;
  }
  .toast {
    padding: 12px 18px; border-radius: 10px; font-size: 12px; font-weight: 500;
    display: flex; align-items: center; gap: 10px;
    transform: translateX(120%); opacity: 0;
    transition: all 0.35s cubic-bezier(0.16,1,0.3,1);
    max-width: 380px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  }
  .toast.show { transform: translateX(0); opacity: 1; }
  .toast.error {
    background: rgba(248,113,113,0.12); border: 1px solid rgba(248,113,113,0.25);
    color: var(--red); backdrop-filter: blur(12px);
  }
  .toast.success {
    background: rgba(52,211,153,0.1); border: 1px solid rgba(52,211,153,0.2);
    color: var(--green); backdrop-filter: blur(12px);
  }
  .toast-icon { font-size: 16px; flex-shrink: 0; }
  .toast-body { flex: 1; }
  .toast-title { font-weight: 700; margin-bottom: 2px; }
  .toast-detail { font-size: 11px; opacity: 0.8; }

  /* ── Live Feed Indicator ── */
  .feed-indicator {
    position: fixed; bottom: 20px; right: 20px;
    display: flex; align-items: center; gap: 8px;
    padding: 8px 14px; border-radius: 10px;
    background: var(--surface); border: 1px solid var(--border);
    font-size: 11px; color: var(--text3); font-weight: 500;
    opacity: 0; transition: opacity 0.3s;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  }
  .feed-indicator.visible { opacity: 1; }
  .feed-indicator .dot {
    width: 6px; height: 6px; border-radius: 50%; background: var(--green);
    animation: pulse 1.5s infinite;
  }

  /* ── Scrollbar ── */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--border2); }

</style>
</head>
<body>
<div class="shell">
  <div class="hdr">
    <div class="hdr-left">
      <h1>SmartCube 중계서버 모니터</h1>
      <p>웹훅 + 스케줄러 &middot; 실시간 현황</p>
    </div>
    <div class="hdr-right">
      <div class="hdr-section">
        <span class="hdr-section-label">서버 상태</span>
        <div class="hdr-section-body">
          <span class="last-recv" id="lastRecv">마지막 수신: -</span>
          <div class="conn-badge" id="connBadge">
            <span class="conn-dot"></span>
            <span id="connText">연결중...</span>
          </div>
        </div>
      </div>
      <div class="hdr-section">
        <span class="hdr-section-label">인증</span>
        <div class="hdr-section-body">
          <span class="mgr-id">로그인: ${DASHBOARD_CURRENT_MGR_ID}</span>
          <a class="filter-btn" href="/api-docs">API 문서 →</a>
          <form class="logout-form" method="post" action="/logout">
            <button class="filter-btn" type="submit">로그아웃</button>
          </form>
        </div>
      </div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-hd">
      <h2>실시간 피드</h2>
      <div class="feed-toolbar">
        <div class="feed-filter-wrap" id="sourceFilterWrap">
          <button class="feed-filter-btn" id="sourceFilterBtn" onclick="toggleSourceMenu()">소스: 전체</button>
          <div class="feed-filter-menu" id="sourceFilterMenu">
            <label class="feed-filter-item"><input type="checkbox" id="sourceAll" onchange="toggleAllSources(this.checked)" checked> 전체</label>
            <label class="feed-filter-item"><input type="checkbox" class="source-filter-cb" value="webhook" onchange="applySourceFilters()" checked> 웹훅</label>
            <label class="feed-filter-item"><input type="checkbox" class="source-filter-cb" value="scheduler" onchange="applySourceFilters()" checked> 스케줄러</label>
            <label class="feed-filter-item"><input type="checkbox" class="source-filter-cb" value="site-sync" onchange="applySourceFilters()" checked> 동기화</label>
            <label class="feed-filter-item"><input type="checkbox" class="source-filter-cb" value="user-sync" onchange="applySourceFilters()" checked> 사용자동기화</label>
          </div>
        </div>
        <select class="feed-select" id="siteSelect" onchange="setSiteFilter(this.value)">
          <option value="all">지점: 전체</option>
          <option value="001">논현점</option>
          <option value="002">마곡점</option>
          <option value="003">선릉역점</option>
          <option value="004">WB 논현</option>
          <option value="005">WB 선릉역</option>
          <option value="006">고양점</option>
          <option value="007">금호점</option>
          <option value="008">목동점</option>
          <option value="009">송파점</option>
          <option value="010">서울숲 비즈허브</option>
          <option value="011">영등포점</option>
        </select>
        <select class="feed-select" id="statusSelect" onchange="setStatusFilter(this.value)">
          <option value="all">상태: 전체</option>
          <option value="success">상태: 성공</option>
          <option value="error">상태: 실패</option>
        </select>
        <select class="feed-select" id="pageSizeSelect" onchange="changePageSize(this.value)">
          <option value="10" selected>10건</option>
          <option value="20">20건</option>
          <option value="50">50건</option>
          <option value="100">100건</option>
        </select>
      </div>
    </div>
    <div class="feed-subtoolbar">
      <input
        class="feed-input"
        id="logSearchInput"
        type="text"
        placeholder="작업 ID, 유닛, 사용자로 검색"
        onkeydown="if (event.key === 'Enter') applyLogSearch()"
      >
      <div class="feed-filter-wrap" id="searchFieldWrap">
        <button class="feed-filter-btn" id="searchFieldBtn" onclick="toggleSearchFieldMenu()">검색 필드: 전체</button>
        <div class="feed-filter-menu" id="searchFieldMenu" style="min-width:220px">
          <label class="feed-filter-item"><input type="checkbox" id="searchFieldAll" onchange="toggleAllSearchFields(this.checked)" checked> 전체</label>
          <label class="feed-filter-item"><input type="checkbox" class="search-field-cb" value="workId" onchange="applySearchFieldSelection()" checked> 작업 ID</label>
          <label class="feed-filter-item"><input type="checkbox" class="search-field-cb" value="unitName" onchange="applySearchFieldSelection()" checked> 유닛 이름</label>
          <label class="feed-filter-item"><input type="checkbox" class="search-field-cb" value="stgUnitId" onchange="applySearchFieldSelection()" checked> 유닛 STG ID</label>
          <label class="feed-filter-item"><input type="checkbox" class="search-field-cb" value="unitId" onchange="applySearchFieldSelection()" checked> 유닛 ID(예: 1018)</label>
          <label class="feed-filter-item"><input type="checkbox" class="search-field-cb" value="unitKey" onchange="applySearchFieldSelection()" checked> 유닛 areaCode</label>
          <label class="feed-filter-item"><input type="checkbox" class="search-field-cb" value="userId" onchange="applySearchFieldSelection()" checked> 사용자 ID</label>
          <label class="feed-filter-item"><input type="checkbox" class="search-field-cb" value="userPhone" onchange="applySearchFieldSelection()" checked> 사용자 전화번호</label>
          <label class="feed-filter-item"><input type="checkbox" class="search-field-cb" value="userName" onchange="applySearchFieldSelection()" checked> 사용자 이름</label>
        </div>
      </div>
      <button class="control-btn" id="logSearchBtn" onclick="applyLogSearch()" style="background:var(--accent)">검색</button>
    </div>
    <table>
      <thead><tr><th style="width:70px">작업 ID</th><th style="width:160px">시각</th><th style="width:60px;white-space:nowrap">소스</th><th>이벤트</th><th>사용자</th><th>유닛</th><th style="width:50px;white-space:nowrap">상태</th><th style="width:80px;white-space:nowrap">처리시간</th></tr></thead>
      <tbody id="recentLogs"><tr><td colspan="7" class="empty">이벤트 대기중...</td></tr></tbody>
    </table>
    <div class="feed-search-note" id="liveSearchNote">
      <span id="liveSearchNoteText"></span>
      <button onclick="jumpToLatestMatchingLogs()">최신 결과 보기</button>
    </div>
    <div class="paging" id="paging"></div>
  </div>

  <div class="panel" style="margin-top:12px">
    <div class="panel-hd">
      <h2>스케줄링</h2>
      <div class="feed-toolbar">
        <select class="feed-select" id="schedSiteSelect" onchange="setSchedSiteFilter(this.value)">
          <option value="all">지점: 전체</option>
          <option value="001">논현점</option>
          <option value="002">마곡점</option>
          <option value="003">선릉역점</option>
          <option value="004">WB 논현</option>
          <option value="005">WB 선릉역</option>
          <option value="006">고양점</option>
          <option value="007">금호점</option>
          <option value="008">목동점</option>
          <option value="009">송파점</option>
          <option value="010">서울숲 비즈허브</option>
          <option value="011">영등포점</option>
        </select>
        <select class="feed-select" id="schedSelect" onchange="switchSchedTab(this.value)">
          <option value="tabSchedAll">전체</option>
          <option value="tabSchedIn">입주 대기</option>
          <option value="tabSchedOut">퇴거 예정</option>
        </select>
        <span class="tag" id="schedCount"></span>
      </div>
    </div>
    <div class="scroll-panel">
      <div id="tabSchedAll" class="tab-content active">
        <table><thead><tr><th>유형</th><th>유닛</th><th>사용자</th><th>예정일</th><th style="white-space:nowrap">D-day</th></tr></thead>
        <tbody id="schedAllBody"><tr><td colspan="5" class="empty">예정된 작업 없음</td></tr></tbody></table>
      </div>
      <div id="tabSchedIn" class="tab-content">
        <table><thead><tr><th>유닛</th><th>사용자</th><th>시작일</th><th style="white-space:nowrap">D-day</th></tr></thead>
        <tbody id="schedInBody"><tr><td colspan="4" class="empty">대기 중인 입주 없음</td></tr></tbody></table>
      </div>
      <div id="tabSchedOut" class="tab-content">
        <table><thead><tr><th>유닛</th><th>사용자</th><th>종료일</th><th style="white-space:nowrap">D-day</th></tr></thead>
        <tbody id="schedOutBody"><tr><td colspan="4" class="empty">예정된 퇴거 없음</td></tr></tbody></table>
      </div>
    </div>
  </div>


  <div class="panel" style="margin-top:12px">
    <div class="panel-hd">
      <div style="display:flex;align-items:center;gap:0">
        <button id="syncTabSite" class="control-btn" onclick="switchSyncTab('site')" style="background:var(--accent);border-radius:6px 0 0 6px;font-size:12px;padding:6px 16px">지점 동기화</button>
        <button id="syncTabUser" class="control-btn" onclick="switchSyncTab('user')" style="background:var(--surface3);color:var(--text3);border-radius:0 6px 6px 0;font-size:12px;padding:6px 16px">사용자 동기화</button>
      </div>
      <div id="siteSyncActions" style="display:flex;gap:8px;align-items:center">
        <button id="siteSyncBtn" class="control-btn" onclick="startSiteSync()" style="background:var(--accent)">동기화 시작</button>
        <button id="siteSyncStopBtn" class="control-btn" onclick="stopSiteSync()" style="background:var(--red);display:none">중지</button>
      </div>
      <div id="userSyncActions" style="display:none;gap:8px;align-items:center">
        <button id="userSyncBtn" class="control-btn" onclick="startUserSync()" style="background:var(--accent)">동기화 시작</button>
        <button id="userSyncStopBtn" class="control-btn" onclick="stopUserSync()" style="background:var(--red);display:none">중지</button>
      </div>
    </div>
    <div id="siteSyncContent">
      <div id="siteSyncBrowser" style="padding:0;display:none">
        <div style="display:flex;border-bottom:1px solid var(--border)">
          <div style="display:flex;align-items:center;padding:8px 12px;border-right:1px solid var(--border)">
            <select class="feed-select" id="siteSyncOfficeMirror" onchange="syncSiteSyncOffice(this.value)" style="min-width:92px">
              <option value="001">논현점</option>
              <option value="002">마곡점</option>
              <option value="003">선릉역점</option>
              <option value="004">WB 논현</option>
              <option value="005">WB 선릉역</option>
              <option value="006">고양점</option>
              <option value="007">금호점</option>
              <option value="008">목동점</option>
              <option value="009">송파점</option>
              <option value="010">서울숲 비즈허브</option>
              <option value="011">영등포점</option>
            </select>
          </div>
          <div id="groupTabs" style="display:flex;align-items:center;overflow-x:auto;padding:8px 16px;gap:4px;flex:1;min-height:48px"></div>
        </div>
        <div style="padding:10px 16px 6px;display:flex;gap:16px;font-size:13px;font-weight:600;color:var(--text2);align-items:center">
          <span><span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:#5ba8c8;vertical-align:middle"></span> 사용중</span>
          <span><span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:#a0a0a0;vertical-align:middle"></span> 빈칸</span>
          <span><span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:#e8a040;vertical-align:middle"></span> 차단</span>
          <span><span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:#a78bfa;vertical-align:middle"></span> 차단(비매출 사용자)</span>
          <span><span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:#d34a4a;vertical-align:middle"></span> 오버락</span>
          <span style="margin-left:auto;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text3);font-weight:500">
            상태 기준:
            <div style="display:flex;border:1px solid var(--border);border-radius:4px;overflow:hidden">
              <button id="unitViewModeDb" type="button" onclick="setUnitViewMode('db')" style="padding:3px 10px;border:0;background:var(--accent);color:#fff;cursor:pointer;font-size:11px">호호락</button>
              <button id="unitViewModeStg" type="button" onclick="setUnitViewMode('stg')" style="padding:3px 10px;border:0;background:var(--surface3);color:var(--text3);cursor:pointer;font-size:11px">STG</button>
            </div>
          </span>
          <label class="check-inline" style="align-self:flex-start;min-height:14px">
            <input type="checkbox" id="unitSelectAll" onchange="toggleAllUnits(this.checked)">
            전체 선택
          </label>
        </div>
        <div id="unitGrid" style="padding:10px 16px 16px;max-height:400px;min-height:364px;overflow-y:auto">
          <div style="display:flex;align-items:center;justify-content:center;min-height:338px;text-align:center;color:var(--text3);font-size:11px">지점을 선택하세요</div>
        </div>
      </div>
      <div id="siteSyncStatus" style="display:none;padding:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span id="siteSyncLabel" style="font-size:12px;color:var(--text2)">준비중...</span>
          <span id="siteSyncCount" style="font-size:11px;color:var(--text3)"></span>
        </div>
        <div style="width:100%;height:6px;background:var(--surface2);border-radius:3px;overflow:hidden">
          <div id="siteSyncBar" style="width:0%;height:100%;background:var(--blue);transition:width 0.3s"></div>
        </div>
        <div id="siteSyncLog" style="margin-top:10px;max-height:200px;overflow:auto;font-size:11px;font-family:monospace;color:var(--text3)"></div>
      </div>
    </div>
    <div id="userSyncContent" style="display:none">
      <div style="padding:20px 16px;text-align:center;color:var(--text3);font-size:12px" id="userSyncIdle">
        STG 전체 사용자의 이름, 전화번호, User ID를 호호락 DB에 동기화합니다.
      </div>
      <div id="userSyncStatus" style="display:none;padding:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span id="userSyncLabel" style="font-size:12px;color:var(--text2)">준비중...</span>
          <span id="userSyncCount" style="font-size:11px;color:var(--text3)"></span>
        </div>
        <div style="width:100%;height:6px;background:var(--surface2);border-radius:3px;overflow:hidden">
          <div id="userSyncBar" style="width:0%;height:100%;background:var(--amber);transition:width 0.3s"></div>
        </div>
        <div style="margin-top:10px;display:flex;align-items:center;gap:12px">
        <label style="font-size:11px;color:var(--text3);display:flex;align-items:center;gap:4px;cursor:pointer">
          <input type="checkbox" id="userSyncShowSkipped" onchange="toggleUserSyncSkipped()"> 스킵 표시
        </label>
      </div>
      <div id="userSyncLog" style="margin-top:6px;max-height:200px;overflow:auto;font-size:11px;font-family:monospace;color:var(--text3)"></div>
      </div>
    </div>
  </div>

  <div class="panel" style="margin-top:12px">
    <div class="panel-hd">
      <div style="font-size:12px;font-weight:600;color:var(--text1)">이메일 전송 테스트</div>
    </div>
    <div style="padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:8px">SMTP 설정 (.env)</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text3)">
            SMTP 주소
            <input id="testEmailHost" type="text" disabled style="padding:6px 8px;background:var(--surface3);color:var(--text2);border:1px solid var(--border);border-radius:4px;font-size:12px">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text3)">
            포트
            <input id="testEmailPort" type="text" disabled style="padding:6px 8px;background:var(--surface3);color:var(--text2);border:1px solid var(--border);border-radius:4px;font-size:12px">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text3)">
            발신자
            <input id="testEmailFrom" type="text" disabled style="padding:6px 8px;background:var(--surface3);color:var(--text2);border:1px solid var(--border);border-radius:4px;font-size:12px">
          </label>
          <div id="testEmailConfigNote" style="font-size:11px;color:var(--text3)"></div>
        </div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:8px">테스트 내용</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text3)">
            수신자
            <input id="testEmailTo" type="email" placeholder="test@example.com" style="padding:6px 8px;background:var(--surface1);color:var(--text1);border:1px solid var(--border);border-radius:4px;font-size:12px">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text3)">
            제목
            <input id="testEmailSubject" type="text" value="[SmartCube] 메일 전송 테스트" style="padding:6px 8px;background:var(--surface1);color:var(--text1);border:1px solid var(--border);border-radius:4px;font-size:12px">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text3)">
            본문
            <textarea id="testEmailBody" rows="4" style="padding:6px 8px;background:var(--surface1);color:var(--text1);border:1px solid var(--border);border-radius:4px;font-size:12px;resize:vertical;font-family:inherit">SmartCube 알림 메일 전송이 정상 동작하는지 확인하는 테스트 메일입니다.</textarea>
          </label>
          <div style="display:flex;gap:8px;align-items:center">
            <button id="testEmailBtn" class="control-btn" onclick="sendTestEmail()" style="background:var(--accent)">전송</button>
            <span id="testEmailResult" style="font-size:11px"></span>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="toast-container" id="toastContainer"></div>
<div class="feed-indicator" id="feedIndicator"><span class="dot"></span>실시간</div>

<script>
(function() {
  'use strict';

  var EV = {
    'job.unit_moveIn.created': '입주 생성',
    'job.unit_moveIn.completed': '입주 완료',
    'job.unit_moveIn.cancelled': '입주 취소',
    'job.unit_moveIn.activated': '입주 활성화',
    'job.unit_moveOut.created': '퇴거 생성',
    'job.unit_moveOut.blocked': '퇴거 차단',
    'job.unit_moveOut.completed': '퇴거 완료',
    'job.unit_moveOut.cancelled': '퇴거 취소',
    'job.unit_transfer.completed': '유닛 이전',
    'job.unit_transfer.pending': '유닛 이전 대기',
    'unitRental.markOverdue': '연체 차단',
    'unitRental.unmarkOverdue': '연체 해제',
    'unitRental.updated': '렌탈 변경',
    'unit.updated': '유닛 변경',
    'unit.synced': '유닛 동기화',
    'user.synced': '사용자 동기화',
    'scheduler.unit_moveOut.blocked': '퇴거 차단(스케줄러)',
    'user.updated': '고객 정보 변경',
    'user.created': '고객 생성',
    'webhook.retried': '웹훅 재시도'
  };

  var RENTAL_KEYS = {
    'customFields.smartcube_generateAccessCode': '출입코드 재생성',
    'customFields.smartcube_lockUnit': '수동 오버락',
    'customFields.smartcube_unlockUnit': '수동 오버락 해제',
    // startDate 변경 webhook은 현재 STG에서 발생하지 않는다(정책: moveIn.completed
    // 이후 startDate 변경 불가). 라벨은 과거 데이터 호환 및 향후 정책 완화 대비로 보존.
    'startDate': '시작일 변경',
    'customFields.gate_code': '코드 직접 변경'
  };

  // unit.updated의 changedKeys에 따라 실제 시나리오 라벨을 매핑.
  var UNIT_KEYS = {
    'customFields.smartcube_syncUnit': '유닛 동기화',
    'customFields.smartcube_id': 'smartcube_id 변경'
  };

  function label(t, entry) {
    if (entry && entry.payload) {
      try {
        var p = typeof entry.payload === 'string' ? JSON.parse(entry.payload) : entry.payload;
        var keys = (p.data && p.data.changedKeys) || [];
        if (t === 'unitRental.updated') {
          for (var i = 0; i < keys.length; i++) {
            if (RENTAL_KEYS[keys[i]]) return RENTAL_KEYS[keys[i]];
          }
        } else if (t === 'unit.updated') {
          for (var j = 0; j < keys.length; j++) {
            if (UNIT_KEYS[keys[j]]) return UNIT_KEYS[keys[j]];
          }
        }
      } catch(e) {}
    }
    return EV[t] || t;
  }

  // ── State ──
  var SEARCH_FIELDS = [
    { key: 'workId', label: '작업 ID' },
    { key: 'unitName', label: '유닛 이름' },
    { key: 'stgUnitId', label: '유닛 STG ID' },
    { key: 'unitId', label: '유닛 ID' },
    { key: 'unitKey', label: '유닛 areaCode' },
    { key: 'userId', label: '사용자 ID' },
    { key: 'userPhone', label: '사용자 전화번호' },
    { key: 'userName', label: '사용자 이름' }
  ];
  var currentSources = ['webhook', 'scheduler', 'site-sync', 'user-sync'];
  var currentStatus = 'all';
  var currentSite = 'all';
  var currentSchedSite = 'all';
  var currentSearchQuery = '';
  var currentSearchFields = SEARCH_FIELDS.map(function(field) { return field.key; });
  var currentPage = 1;
  var pageSize = 10;
  var stats = { lastEventAt: null };
  var recentLogs = [];
  var currentLogTotal = 0;
  var logFetching = false;
  var pendingMatchingResults = 0;
  var _reprocessingIds = {};
  var _resolvedCorrKeys = {}; // correlationKey → true (같은 작업 ID로 성공한 적 있음)

  // ── Utility ──
  function ago(iso) {
    if (!iso) return '-';
    var d = Date.now() - new Date(iso).getTime();
    if (d < 1000) return '방금';
    if (d < 60000) return Math.floor(d / 1000) + '초 전';
    if (d < 3600000) return Math.floor(d / 60000) + '분 전';
    if (d < 86400000) return Math.floor(d / 3600000) + '시간 전';
    return Math.floor(d / 86400000) + '일 전';
  }

  function clock(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    var parts = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(d);
    var map = {};
    parts.forEach(function(part) {
      if (part.type !== 'literal') map[part.type] = part.value;
    });
    return map.year + '.' + map.month + '.' + map.day + ' ' + map.hour + ':' + map.minute + ':' + map.second;
  }

  function esc(s) {
    var el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  function renderStats() {
    var text = stats.lastEventAt ? clock(stats.lastEventAt) : '-';
    document.getElementById('lastRecv').textContent = '마지막 수신: ' + text;
  }

  function renderSourceFilterLabel() {
    var btn = document.getElementById('sourceFilterBtn');
    if (!btn) return;
    if (!currentSources.length || currentSources.length === 4) {
      btn.textContent = '소스: 전체';
      return;
    }
    var labels = [];
    if (currentSources.indexOf('webhook') >= 0) labels.push('웹훅');
    if (currentSources.indexOf('scheduler') >= 0) labels.push('스케줄러');
    if (currentSources.indexOf('site-sync') >= 0) labels.push('동기화');
    if (currentSources.indexOf('user-sync') >= 0) labels.push('사용자동기화');
    btn.textContent = '소스: ' + labels.join(', ');
  }

  function renderSearchFieldLabel() {
    var btn = document.getElementById('searchFieldBtn');
    if (!btn) return;
    if (!currentSearchFields.length) {
      btn.textContent = '검색 필드: 없음';
      return;
    }
    if (!currentSearchFields.length || currentSearchFields.length === SEARCH_FIELDS.length) {
      btn.textContent = '검색 필드: 전체';
      return;
    }
    var labels = SEARCH_FIELDS
      .filter(function(field) { return currentSearchFields.indexOf(field.key) >= 0; })
      .map(function(field) { return field.label; });
    btn.textContent = '검색 필드: ' + labels.join(', ');
  }

  function normalizeSearchText(value) {
    return String(value || '').trim().toLowerCase();
  }

  function entryMatchesSearch(entry) {
    if (!currentSearchQuery) return true;
    var query = normalizeSearchText(currentSearchQuery);
    if (!query) return true;

    var payloadObj = null;
    try { payloadObj = typeof entry.payload === 'string' ? JSON.parse(entry.payload) : entry.payload; } catch(e) { payloadObj = entry.payload; }
    var meta = (payloadObj && payloadObj._syncMeta) || {};
    var unit = formatUnit(entry.areaCode, entry.showBoxNo);
    var unitKey = entry.areaCode ? entry.areaCode + ':' + (entry.showBoxNo != null ? entry.showBoxNo : '') : '';
    var searchTexts = {
      workId: [
        entry.id,
        entry.eventId,
        entry.businessCode,
        entry.correlationKey
      ],
      unitName: [
        unit ? unit.name : '',
        unit ? (unit.name + ' #' + unit.num) : ''
      ],
      stgUnitId: [entry.stgUnitId, meta.stgUnitId],
      unitId: [unit ? unit.num : '', entry.showBoxNo],
      unitKey: [unitKey],
      userId: [entry.stgUserId, meta.stgUserId],
      userPhone: [
        payloadObj && payloadObj.userPhone,
        payloadObj && payloadObj.data && payloadObj.data.userPhone,
        payloadObj && payloadObj.data && payloadObj.data.owner && payloadObj.data.owner.phone,
        payloadObj && payloadObj.data && payloadObj.data.user && payloadObj.data.user.phone,
        typeof entry.payload === 'string' ? entry.payload : JSON.stringify(payloadObj || {})
      ],
      userName: [
        entry.userName,
        meta.userName,
        payloadObj && payloadObj.data && payloadObj.data.owner && ((payloadObj.data.owner.lastName || '') + ' ' + (payloadObj.data.owner.firstName || '')),
        payloadObj && payloadObj.data && payloadObj.data.user && ((payloadObj.data.user.lastName || '') + ' ' + (payloadObj.data.user.firstName || ''))
      ]
    };

    return currentSearchFields.some(function(fieldKey) {
      var values = searchTexts[fieldKey] || [];
      return values.some(function(value) {
        return normalizeSearchText(value).indexOf(query) >= 0;
      });
    });
  }

  function renderPendingSearchNotice() {
    var note = document.getElementById('liveSearchNote');
    var text = document.getElementById('liveSearchNoteText');
    if (!note || !text) return;
    if (!currentSearchQuery || pendingMatchingResults <= 0 || currentPage === 1) {
      note.classList.remove('visible');
      text.textContent = '';
      return;
    }
    text.textContent = '현재 검색조건에 맞는 새 로그 ' + pendingMatchingResults + '건이 들어왔습니다.';
    note.classList.add('visible');
  }

  function syncSearchButtonState() {
    var btn = document.getElementById('logSearchBtn');
    if (!btn) return;
    btn.disabled = currentSearchFields.length === 0;
  }

  function clearPendingSearchNotice() {
    pendingMatchingResults = 0;
    renderPendingSearchNotice();
  }

  var OFFICES = {
    '001': '논현점', '002': '마곡점', '003': '선릉역점',
    '004': 'WB 논현', '005': 'WB 선릉역',
    '006': '고양점', '007': '금호점', '008': '목동점',
    '009': '송파점', '010': '서울숲 비즈허브', '011': '영등포점'
  };

  // showBoxNo는 STG unit.name과 동일한 표시 번호이므로 계산 없이 그대로 사용.
  // 과거에 쓰이던 group*1000+boxNo 공식은 약 절반의 unit에서 틀린 번호를 내보내는 버그였음.
  function formatUnit(areaCode, showBoxNo) {
    if (!areaCode) return null;
    var office = areaCode.substring(4, 7);
    return {
      office: office,
      name: OFFICES[office] || office,
      num: showBoxNo != null ? showBoxNo : 0,
    };
  }

  function isStgId(v) { return v && /^[a-f0-9]{24}$/.test(v); }

  function getCurrentSiteSyncOffice() {
    var mirror = document.getElementById('siteSyncOfficeMirror');
    if (mirror && mirror.value) return mirror.value;
    var primary = document.getElementById('siteSyncOffice');
    return primary ? primary.value : '001';
  }

  var _expandedIds = {};
  function logRowHtml(l, flash) {
    var rid = 'fr-' + (l.id || Math.random().toString(36).substr(2, 8));
    // 1급 컬럼 (attempt/maxAttempts) 우선, 없으면 payload 의 legacy 필드 fallback
    var retryAttempt = 0, retryMax = 0;
    if (typeof l.attempt === 'number' && l.attempt > 0) {
      retryAttempt = l.attempt;
      retryMax = l.maxAttempts || 3;
    } else {
      try {
        var p = typeof l.payload === 'string' ? JSON.parse(l.payload) : l.payload;
        if (p && p.attempt > 0) { retryAttempt = p.attempt; retryMax = p.maxAttempts || 3; }
      } catch(e) {}
    }
    // retry attempt > 1 이거나, retry 도중 발생한 error row 면 badge 표시
    var showBadge = retryAttempt > 1 || (l.status === 'error' && retryAttempt > 0);
    var retryBadge = showBadge ? ' <span style="font-size:9px;padding:1px 5px;border-radius:8px;background:rgba(251,191,36,0.2);color:var(--amber);font-weight:600">[' + retryAttempt + '/' + retryMax + ']</span>' : '';
    var chip = l.status === 'success'
      ? '<span class="chip ok">성공' + retryBadge + '</span>'
      : '<span class="chip fail">실패' + retryBadge + '</span>';
    var src = l.source || 'webhook';
    var srcLabel = src === 'scheduler'
      ? '스케줄러'
      : (src === 'site-sync' ? '동기화' : (src === 'user-sync' ? '사용자동기화' : '웹훅'));
    var srcBadge = '<span class="source-badge ' + src + '">' + srcLabel + '</span>';
    var ts = l.createdAt || l.receivedAt;
    var flashCls = flash ? (l.status === 'error' ? ' flash-err' : ' flash') : '';

    // payload._syncMeta 또는 payload.data에서 사용자 정보 fallback 추출
    var payloadObj = null;
    try { payloadObj = typeof l.payload === 'string' ? JSON.parse(l.payload) : l.payload; } catch(e) {}
    var meta = (payloadObj && payloadObj._syncMeta) || {};
    var resolvedUserName = l.userName || meta.userName || '';
    var resolvedUserId = l.stgUserId || meta.stgUserId || '';
    if (payloadObj && !resolvedUserName) {
      var d = payloadObj.data || {};
      var owner = d.owner || d.user || {};
      var ln = owner.lastName || owner.last_name || '';
      var fn = owner.firstName || owner.first_name || '';
      if (ln && fn) resolvedUserName = ln + ', ' + fn;
      else resolvedUserName = ln || fn || '';
    }
    if (payloadObj && !resolvedUserId) {
      var d2 = payloadObj.data || {};
      resolvedUserId = d2.ownerId || d2.userId || payloadObj.ownerId || payloadObj.userId || '';
    }

    var validUid = isStgId(resolvedUserId) ? resolvedUserId : null;
    var userCell = resolvedUserName
      ? esc(resolvedUserName) + (validUid ? '<br><span class="ev-sub">' + esc(validUid) + '</span>' : '')
      : (validUid ? '<span class="ev-sub">' + esc(validUid) + '</span>' : '-');
    var u = formatUnit(l.areaCode, l.showBoxNo);
    var unitCell = u
      ? esc(u.name) + ' <b>#' + u.num + '</b>'
        + '<br><span class="ev-sub">' + esc(l.areaCode + ':' + (l.showBoxNo ?? '')) + '</span>'
      : (l.areaCode ? esc(l.areaCode + ':' + (l.showBoxNo ?? '')) : '-');

    // Detail — show all fields
    var details = [];
    details.push({ label: 'ID', val: l.id != null ? String(l.id) : '-' });
    details.push({ label: '소스', val: srcLabel });
    details.push({ label: '이벤트', val: esc(label(l.eventType, l)) + ' <span style="color:var(--text3)">(' + esc(l.eventType) + ')</span>' });
    details.push({ label: 'Event ID', val: l.eventId ? esc(l.eventId) : '-' });
    details.push({ label: '상태', val: l.status === 'success' ? '<span style="color:var(--green)">성공</span>' : '<span style="color:var(--red)">실패</span>' });
    details.push({ label: '처리시간', val: l.durationMs + 'ms' });
    details.push({ label: '시각', val: clock(ts) });
    var uDetail = formatUnit(l.areaCode, l.showBoxNo);
    details.push({ label: '지점', val: uDetail ? esc(uDetail.name) : '-' });
    details.push({ label: '유닛', val: uDetail ? '#' + uDetail.num + ' <span style="color:var(--text3)">(' + esc(l.areaCode + ':' + (l.showBoxNo ?? '')) + ')</span>' : (l.areaCode ? esc(l.areaCode + ':' + (l.showBoxNo ?? '')) : '-') });
    details.push({ label: 'Unit ID (STG)', val: l.stgUnitId ? esc(l.stgUnitId) : '-' });
    details.push({ label: '사용자', val: resolvedUserName ? esc(resolvedUserName) : '-' });
    details.push({ label: 'User ID (STG)', val: validUid ? esc(validUid) : '-' });
    if (l.error) details.push({ label: '오류 내용', val: esc(l.error), err: true });
    if (l.correlationKey) details.push({ label: 'Correlation ID', val: '<span style="font-family:monospace;font-size:11px;color:var(--purple)">' + esc(l.correlationKey) + '</span>' });

    var detailHtml = '<div class="detail-wrap"><div class="detail-grid">';
    details.forEach(function(d) {
      detailHtml += '<div class="detail-item"><div class="detail-label">' + d.label + '</div>'
        + '<div class="detail-val' + (d.err ? ' err' : '') + '">' + d.val + '</div></div>';
    });
    detailHtml += '</div>';
    if (l.payload) {
      var payloadStr;
      try { payloadStr = typeof l.payload === 'string' ? JSON.stringify(JSON.parse(l.payload), null, 2) : JSON.stringify(l.payload, null, 2); }
      catch(e) { payloadStr = String(l.payload); }
      detailHtml += '<div class="detail-payload-label">Payload</div>'
        + '<div class="detail-payload">' + esc(payloadStr) + '</div>';
    }
    if (l.status === 'error') {
      var alreadyResolved = l.correlationKey && _resolvedCorrKeys[l.correlationKey];
      if (alreadyResolved) {
        detailHtml += '<div class="detail-actions"><span class="detail-hint" style="color:var(--green)">이 작업은 재시도 후 성공했습니다.</span></div>';
      } else {
        var actionHtml = '';
        if (l.replayable) {
          var disabled = _reprocessingIds[l.id] ? ' disabled' : '';
          var labelTxt = _reprocessingIds[l.id] ? '재처리 중...' : '재처리';
          actionHtml = '<button class="retry-btn" onclick="reprocessLog(' + l.id + ', event)"' + disabled + '>' + labelTxt + '</button>';
        } else {
          actionHtml = '<button class="retry-btn" disabled>재처리 불가</button>';
        }
        var hint = l.replayable ? '원본 payload/메타 기준으로 재실행됩니다.' : esc(l.replayReason || '재처리 정보가 부족합니다.');
        detailHtml += '<div class="detail-actions">' + actionHtml + '<span class="detail-hint">' + hint + '</span></div>';
      }
    }
    detailHtml += '</div>';

    var isOpen = !!_expandedIds[rid];
    var corrToken = l.correlationKey ? l.correlationKey.split(':').pop() || l.correlationKey : '';
    var corrShort = corrToken ? esc(corrToken.length > 12 ? corrToken.slice(0, 8) + '..' : corrToken) : '-';
    var corrCell = l.correlationKey
      ? '<span style="font-family:monospace;font-size:10px;color:var(--purple)">' + corrShort + '</span>'
      : '<span style="color:var(--text3);font-size:10px">-</span>';
    return '<tr class="feed-row' + flashCls + (isOpen ? ' expanded' : '') + '" onclick="toggleDetail(&#39;' + rid + '&#39;)" id="' + rid + '">'
      + '<td>' + corrCell + '</td>'
      + '<td class="ts">' + clock(ts) + '</td>'
      + '<td>' + srcBadge + '</td>'
      + '<td><span class="ev-name">' + esc(label(l.eventType, l)) + '</span><br><span class="ev-sub">' + esc(l.eventType) + '</span></td>'
      + '<td>' + userCell + '</td>'
      + '<td class="ev-name">' + unitCell + '</td>'
      + '<td>' + chip + '</td>'
      + '<td class="dur">' + l.durationMs + '<span style="color:var(--text3);font-size:10px">ms</span></td>'
      + '</tr>'
      + '<tr class="feed-detail' + (isOpen ? ' open' : '') + '" id="' + rid + '-detail"><td colspan="8">' + detailHtml + '</td></tr>';
  }

  function entryMatchesCurrentFilters(entry) {
    var source = entry.source || 'webhook';
    if (currentSources.indexOf(source) < 0) return false;
    if (currentStatus !== 'all' && entry.status !== currentStatus) return false;
    if (currentSite !== 'all' && entry.areaCode && entry.areaCode.substring(4, 7) !== currentSite) return false;
    if (!entryMatchesSearch(entry)) return false;
    return true;
  }

  async function refreshLogs(opts) {
    var options = opts || {};
    var preserveScroll = !!options.preserveScroll;
    var flashRecent = !!options.flashRecent;
    var scrollY = preserveScroll ? window.scrollY : null;
    var offset = (currentPage - 1) * pageSize;
    var params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
      sources: currentSources.join(',')
    });
    if (currentSite !== 'all') params.set('site', currentSite);
    if (currentStatus !== 'all') params.set('status', currentStatus);
    if (currentSearchQuery) {
      params.set('q', currentSearchQuery);
      params.set('searchFields', currentSearchFields.join(','));
    }

    logFetching = true;
    try {
      var res = await apiFetch('/monitoring/api/logs?' + params.toString());
      var data = await res.json();
      recentLogs = data.items || [];
      currentLogTotal = data.total || 0;
      clearPendingSearchNotice();
      recentLogs.forEach(function(e) {
        if (e.status === 'success' && e.correlationKey) _resolvedCorrKeys[e.correlationKey] = true;
      });
      renderRecentLogs(flashRecent);
    } finally {
      logFetching = false;
      if (preserveScroll && scrollY != null) {
        window.scrollTo({ top: scrollY });
      }
    }
  }

  function renderRecentLogs(flashFirst) {
    var body = document.getElementById('recentLogs');
    if (recentLogs.length === 0) {
      body.innerHTML = '<tr><td colspan="7" class="empty">이벤트 대기중...</td></tr>';
      document.getElementById('paging').innerHTML = '';
      return;
    }

    var totalPages = Math.max(1, Math.ceil(currentLogTotal / pageSize));
    if (currentPage > totalPages) currentPage = totalPages;
    var start = (currentPage - 1) * pageSize;
    var page = recentLogs;

    var html = '';
    page.forEach(function(l, i) {
      html += logRowHtml(l, flashFirst && currentPage === 1 && i === 0);
    });
    body.innerHTML = html;

    // Pagination controls
    var pg = '';
    if (totalPages > 1) {
      pg += '<button class="pg-btn" onclick="goPage(' + (currentPage - 1) + ')" ' + (currentPage === 1 ? 'disabled' : '') + '>&lsaquo; 이전</button>';

      // Always show page 1
      if (currentPage > 4) {
        pg += '<button class="pg-btn" onclick="goPage(1)">1</button>';
        if (currentPage > 5) pg += '<span class="pg-dots">...</span>';
      }

      // Show pages around current
      var from = Math.max(1, currentPage - 3);
      var to = Math.min(totalPages, currentPage + 3);
      for (var p = from; p <= to; p++) {
        pg += '<button class="pg-btn' + (p === currentPage ? ' active' : '') + '" onclick="goPage(' + p + ')">' + p + '</button>';
      }

      // Always show last page
      if (currentPage < totalPages - 3) {
        if (currentPage < totalPages - 4) pg += '<span class="pg-dots">...</span>';
        pg += '<button class="pg-btn" onclick="goPage(' + totalPages + ')">' + totalPages + '</button>';
      }

      pg += '<button class="pg-btn" onclick="goPage(' + (currentPage + 1) + ')" ' + (currentPage === totalPages ? 'disabled' : '') + '>다음 &rsaquo;</button>';
      pg += '<span class="pg-info">' + currentLogTotal + '건 중 ' + (start + 1) + '-' + Math.min(start + page.length, currentLogTotal) + '</span>';
    }
    document.getElementById('paging').innerHTML = pg;
  }

  // ── Pending scheduled tasks ──
  var pendingData = [];

  // 두 Date 객체의 "KST 달력일자" 차이를 반환.
  // 시간 차이 / 86400000 을 사용하면 같은 달력일이라도 오후에 조회하면 다음날로
  // 계산되는 오류가 발생. KST wall clock 기준 YYYY-MM-DD 를 UTC midnight으로
  // 정규화해서 정확한 일수 차이를 구한다.
  function kstCalendarDayUtcMs(date) {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    var map = {};
    parts.forEach(function(p) { if (p.type !== 'literal') map[p.type] = p.value; });
    return Date.UTC(
      parseInt(map.year, 10),
      parseInt(map.month, 10) - 1,
      parseInt(map.day, 10)
    );
  }

  function dday(isoDate) {
    var diff = Math.round(
      (kstCalendarDayUtcMs(new Date(isoDate)) - kstCalendarDayUtcMs(new Date())) / 86400000
    );
    if (diff === 0) return '<span style="color:var(--red);font-weight:700">D-DAY</span>';
    if (diff < 0) return '<span style="color:var(--text2)">D+' + (-diff) + '</span>';
    if (diff === 1) return '<span style="color:var(--amber);font-weight:700">D-1</span>';
    if (diff <= 3) return '<span style="color:var(--amber)">D-' + diff + '</span>';
    return '<span style="color:var(--text2)">D-' + diff + '</span>';
  }

  function formatDate(iso) {
    return clock(iso);
  }

  function renderPendingScheduled() { renderPending(); }
  function renderPending() {
    var filtered = currentSchedSite === 'all' ? pendingData : pendingData.filter(function(r) {
      return r.areaCode && r.areaCode.substring(4, 7) === currentSchedSite;
    });
    var inList = filtered.filter(function(r) { return r.type === 'moveIn'; });
    var outList = filtered.filter(function(r) { return r.type === 'moveOut'; });
    var total = filtered.length;

    var sel = document.getElementById('schedSelect');
    var counts = { tabSchedAll: total, tabSchedIn: inList.length, tabSchedOut: outList.length };
    document.getElementById('schedCount').textContent = (counts[sel.value] || 0) + '건';

    function schedUnitCell(areaCode, showBoxNo) {
      var u = formatUnit(areaCode, showBoxNo);
      var main = u ? esc(u.name) + ' <b>#' + u.num + '</b>' : esc(areaCode) + ':' + showBoxNo;
      return areaCode ? main + '<br><span class="ev-sub">' + esc(areaCode + ':' + showBoxNo) + '</span>' : main;
    }

    function schedUserCell(name, stgUserId) {
      var validId = isStgId(stgUserId) ? stgUserId : null;
      if (name) return esc(name) + (validId ? '<br><span class="ev-sub">' + esc(validId) + '</span>' : '');
      return validId ? '<span class="ev-sub">' + esc(validId) + '</span>' : '-';
    }

    // 전체 탭 — 날짜순 정렬 (API가 이미 정렬해서 반환)
    var all = filtered.map(function(r) {
      return { type: r.type === 'moveIn' ? 'in' : 'out', areaCode: r.areaCode, showBoxNo: r.showBoxNo, stgUnitId: r.stgUnitId, name: r.userName, stgUserId: r.stgUserId, date: r.scheduledDate };
    });

    var allBody = document.getElementById('schedAllBody');
    if (all.length === 0) {
      allBody.innerHTML = '<tr><td colspan="5" class="empty">예정된 작업 없음</td></tr>';
    } else {
      var h = '';
      all.forEach(function(r) {
        var badge = r.type === 'in'
          ? '<span class="sched-type in">입주</span>'
          : '<span class="sched-type out">퇴거</span>';
        h += '<tr>'
          + '<td>' + badge + '</td>'
          + '<td class="ev-name">' + schedUnitCell(r.areaCode, r.showBoxNo) + '</td>'
          + '<td>' + schedUserCell(r.name, r.stgUserId) + '</td>'
          + '<td class="ts">' + formatDate(r.date) + '</td>'
          + '<td>' + dday(r.date) + '</td>'
          + '</tr>';
      });
      allBody.innerHTML = h;
    }

    // 입주 대기 탭
    var inBody = document.getElementById('schedInBody');
    if (inList.length === 0) {
      inBody.innerHTML = '<tr><td colspan="4" class="empty">대기 중인 입주 없음</td></tr>';
    } else {
      var h2 = '';
      inList.forEach(function(r) {
        h2 += '<tr>'
          + '<td class="ev-name">' + schedUnitCell(r.areaCode, r.showBoxNo) + '</td>'
          + '<td>' + schedUserCell(r.userName, r.stgUserId) + '</td>'
          + '<td class="ts">' + formatDate(r.scheduledDate) + '</td>'
          + '<td>' + dday(r.scheduledDate) + '</td>'
          + '</tr>';
      });
      inBody.innerHTML = h2;
    }

    // 퇴거 예정 탭
    var outBody = document.getElementById('schedOutBody');
    if (outList.length === 0) {
      outBody.innerHTML = '<tr><td colspan="4" class="empty">예정된 퇴거 없음</td></tr>';
    } else {
      var h3 = '';
      outList.forEach(function(r) {
        h3 += '<tr>'
          + '<td class="ev-name">' + schedUnitCell(r.areaCode, r.showBoxNo) + '</td>'
          + '<td>' + schedUserCell(r.userName, r.stgUserId) + '</td>'
          + '<td class="ts">' + formatDate(r.scheduledDate) + '</td>'
          + '<td>' + dday(r.scheduledDate) + '</td>'
          + '</tr>';
      });
      outBody.innerHTML = h3;
    }
  }

  // ── Tab switching ──
  window.switchSchedTab = function(tabId) {
    document.querySelectorAll('#tabSchedAll,#tabSchedIn,#tabSchedOut').forEach(function(c) { c.classList.remove('active'); });
    document.getElementById(tabId).classList.add('active');
    renderPending();
  };

  function renderAll(flashRecent) {
    renderStats();
    renderRecentLogs(flashRecent);
    renderPending();
  }

  // ── Toast ──
  function toast(type, title, detail) {
    var c = document.getElementById('toastContainer');
    var el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = '<span class="toast-icon">' + (type === 'error' ? '&#9888;' : '&#10003;') + '</span>'
      + '<div class="toast-body"><div class="toast-title">' + esc(title) + '</div>'
      + (detail ? '<div class="toast-detail">' + esc(detail) + '</div>' : '')
      + '</div>';
    c.appendChild(el);
    requestAnimationFrame(function() {
      requestAnimationFrame(function() { el.classList.add('show'); });
    });
    setTimeout(function() {
      el.classList.remove('show');
      setTimeout(function() { el.remove(); }, 400);
    }, 4000);
  }

  // ── Feed indicator flash ──
  function flashFeed() {
    var fi = document.getElementById('feedIndicator');
    fi.classList.add('visible');
    clearTimeout(flashFeed._t);
    flashFeed._t = setTimeout(function() { fi.classList.remove('visible'); }, 2000);
  }

  // ── Pause ──
  window.toggleSourceMenu = function() {
    var menu = document.getElementById('sourceFilterMenu');
    if (!menu) return;
    menu.classList.toggle('open');
    document.getElementById('searchFieldMenu').classList.remove('open');
  };

  window.toggleAllSources = function(checked) {
    var cbs = document.querySelectorAll('.source-filter-cb');
    cbs.forEach(function(cb) { cb.checked = checked; });
    applySourceFilters();
  };

  window.applySourceFilters = function() {
    var selected = [];
    document.querySelectorAll('.source-filter-cb').forEach(function(cb) {
      if (cb.checked) selected.push(cb.value);
    });
    if (!selected.length) {
      document.getElementById('sourceAll').checked = true;
      document.querySelectorAll('.source-filter-cb').forEach(function(cb) { cb.checked = true; });
      selected = ['webhook', 'scheduler', 'site-sync', 'user-sync'];
    }
    currentSources = selected;
    document.getElementById('sourceAll').checked = selected.length === 4;
    renderSourceFilterLabel();
    currentPage = 1;
    refreshLogs({ preserveScroll: true });
  };

  window.toggleSearchFieldMenu = function() {
    var menu = document.getElementById('searchFieldMenu');
    if (!menu) return;
    menu.classList.toggle('open');
    document.getElementById('sourceFilterMenu').classList.remove('open');
  };

  window.toggleAllSearchFields = function(checked) {
    var cbs = document.querySelectorAll('.search-field-cb');
    cbs.forEach(function(cb) { cb.checked = checked; });
    applySearchFieldSelection();
  };

  window.applySearchFieldSelection = function() {
    var selected = [];
    document.querySelectorAll('.search-field-cb').forEach(function(cb) {
      if (cb.checked) selected.push(cb.value);
    });
    currentSearchFields = selected;
    document.getElementById('searchFieldAll').checked = selected.length === SEARCH_FIELDS.length;
    renderSearchFieldLabel();
    syncSearchButtonState();
  };

  window.applyLogSearch = function() {
    if (!currentSearchFields.length) return;
    var input = document.getElementById('logSearchInput');
    currentSearchQuery = input ? input.value.trim() : '';
    currentPage = 1;
    refreshLogs({ preserveScroll: true });
  };

  window.jumpToLatestMatchingLogs = function() {
    currentPage = 1;
    refreshLogs({ preserveScroll: true, flashRecent: true });
  };

  window.setSiteFilter = function(site) {
    currentSite = site;
    currentPage = 1;
    refreshLogs({ preserveScroll: true });
  };

  window.setSchedSiteFilter = function(site) {
    currentSchedSite = site;
    renderPendingScheduled();
  };

  window.setStatusFilter = function(status) {
    currentStatus = status;
    currentPage = 1;
    refreshLogs({ preserveScroll: true });
  };

  window.goPage = function(p) {
    currentPage = p;
    refreshLogs({ preserveScroll: true });
  }

  window.changePageSize = function(val) {
    pageSize = parseInt(val, 10);
    currentPage = 1;
    refreshLogs({ preserveScroll: true });
  };

  document.addEventListener('click', function(e) {
    var sourceWrap = document.getElementById('sourceFilterWrap');
    var sourceMenu = document.getElementById('sourceFilterMenu');
    if (sourceWrap && sourceMenu && !sourceWrap.contains(e.target)) {
      sourceMenu.classList.remove('open');
    }
    var searchWrap = document.getElementById('searchFieldWrap');
    var searchMenu = document.getElementById('searchFieldMenu');
    if (searchWrap && searchMenu && !searchWrap.contains(e.target)) {
      searchMenu.classList.remove('open');
    }
  });

  window.reprocessLog = async function(id, event) {
    if (event) event.stopPropagation();
    if (_reprocessingIds[id]) return;
    _reprocessingIds[id] = true;
    renderRecentLogs(false);
    try {
      var res = await apiFetch('/monitoring/api/errors/' + id + '/reprocess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      await res.json();
      toast('success', '재처리 요청 완료', '로그 #' + id + ' 재처리를 실행했습니다.');
      await refreshLogs({ preserveScroll: true });
    } catch (e) {
      toast('error', '재처리 실패', e.message || '알 수 없는 오류');
    } finally {
      delete _reprocessingIds[id];
      renderRecentLogs(false);
    }
  };

  window.togglePL = function(id) {
    var el = document.getElementById('p-' + id);
    if (el) el.classList.toggle('open');
  };

  window.toggleDetail = function(rid) {
    var row = document.getElementById(rid);
    var detail = document.getElementById(rid + '-detail');
    if (!row || !detail) return;
    var opening = !row.classList.contains('expanded');
    row.classList.toggle('expanded');
    detail.classList.toggle('open');
    if (opening) _expandedIds[rid] = true;
    else delete _expandedIds[rid];
  };

  // ── Group & Unit loading (STG-based) ──
  var _stgData = null; // cached STG response
  var _activeGroupCode = null;

  var STG_STATES = { occupied: '사용중', available: '빈칸', blocked: '차단', blocked_nonrevenue: '차단(비매출 사용자)' };
  var STG_STATE_COLORS = { occupied: 'var(--green)', available: 'var(--text3)', blocked: 'var(--amber)', blocked_nonrevenue: '#a78bfa' };
  var UNIT_TILE_STYLES = {
    occupied: {
      bg: 'rgba(74,154,181,0.26)',
      color: '#dff5ff',
      border: 'rgba(74,154,181,0.42)',
      selectedBg: '#4a9ab5',
      selectedColor: '#fff'
    },
    available: {
      bg: 'rgba(136,136,136,0.32)',
      color: '#f1f1f5',
      border: 'rgba(136,136,136,0.38)',
      selectedBg: '#888',
      selectedColor: '#fff'
    },
    blocked: {
      bg: 'rgba(200,138,48,0.28)',
      color: '#ffe7b6',
      border: 'rgba(200,138,48,0.40)',
      selectedBg: '#c88a30',
      selectedColor: '#fff'
    },
    blocked_nonrevenue: {
      bg: 'rgba(167,139,250,0.22)',
      color: '#e7defe',
      border: 'rgba(167,139,250,0.40)',
      selectedBg: '#a78bfa',
      selectedColor: '#fff'
    },
    overlocked: {
      bg: 'rgba(211,74,74,0.28)',
      color: '#ffd7d7',
      border: 'rgba(211,74,74,0.42)',
      selectedBg: '#d34a4a',
      selectedColor: '#fff'
    },
    unknown: {
      bg: 'var(--surface2)',
      color: 'var(--text3)',
      border: 'var(--border)',
      selectedBg: '#666',
      selectedColor: '#fff'
    }
  };

  var _selectedUnits = {}; // { 'groupCode:showBoxNo': true }
  var _unitViewMode = 'db'; // 'stg' | 'db'

  function updateUnitViewModeButtons() {
    var btnStg = document.getElementById('unitViewModeStg');
    var btnDb = document.getElementById('unitViewModeDb');
    if (!btnStg || !btnDb) return;
    if (_unitViewMode === 'stg') {
      btnStg.style.background = 'var(--accent)';
      btnStg.style.color = '#fff';
      btnDb.style.background = 'var(--surface3)';
      btnDb.style.color = 'var(--text3)';
    } else {
      btnDb.style.background = 'var(--accent)';
      btnDb.style.color = '#fff';
      btnStg.style.background = 'var(--surface3)';
      btnStg.style.color = 'var(--text3)';
    }
  }

  window.setUnitViewMode = function(mode) {
    if (mode !== 'stg' && mode !== 'db') return;
    if (_unitViewMode === mode) return;
    _unitViewMode = mode;
    updateUnitViewModeButtons();
    loadGroups();
  };

  window.loadGroups = function() {
    var officeCode = getCurrentSiteSyncOffice();
    var mirror = document.getElementById('siteSyncOfficeMirror');
    var browser = document.getElementById('siteSyncBrowser');
    var tabs = document.getElementById('groupTabs');
    var grid = document.getElementById('unitGrid');
    var sourceLabel = _unitViewMode === 'db' ? '호호락 DB' : 'STG';
    tabs.innerHTML = '<span style="display:flex;align-items:center;min-height:32px;font-size:11px;color:var(--text3)">' + sourceLabel + ' 유닛 로딩중...</span>';
    grid.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:338px;text-align:center;color:var(--text3);font-size:11px">로딩중...</div>';
    browser.style.display = 'block';
    if (mirror) mirror.value = officeCode;
    document.getElementById('unitSelectAll').checked = false;
    _stgData = null;
    _activeGroupCode = null;
    _selectedUnits = {};
    updateUnitViewModeButtons();

    var endpoint = _unitViewMode === 'db' ? '/monitoring/api/db-units' : '/monitoring/api/stg-units';
    apiFetch(endpoint + '?officeCode=' + officeCode)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        _stgData = data;
        if (!data.groups || !data.groups.length) {
          tabs.innerHTML = '<span style="display:flex;align-items:center;min-height:32px;font-size:11px;color:var(--text3)">등록된 그룹 없음</span>';
          grid.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:338px;text-align:center;color:var(--text3);font-size:11px">유닛 없음</div>';
          return;
        }
        renderGroupTabs();
        selectGroupTab(data.groups[0].groupCode);
      })
      .catch(function(e) {
        tabs.innerHTML = '<span style="display:flex;align-items:center;min-height:32px;font-size:11px;color:var(--red)">로딩 실패: ' + esc(e.message) + '</span>';
      });
  };

  window.syncSiteSyncOffice = function(officeCode) {
    loadGroups();
  };

  function renderGroupTabs() {
    if (!_stgData) return;
    var tabs = document.getElementById('groupTabs');
    var h = '';
    _stgData.groups.forEach(function(g) {
      var active = g.groupCode === _activeGroupCode;
      var gcEsc = esc(g.groupCode);
      var groupChecked = g.units.some(function(u) { return !!_selectedUnits[g.groupCode + ':' + u.showBoxNo]; });
      h += '<div style="display:flex;align-items:center;gap:0">'
        + '<label style="display:flex;align-items:center;height:32px;padding:0 4px 0 8px;border-radius:6px 0 0 6px;border:1px solid ' + (active ? 'rgba(108,140,255,0.3)' : 'var(--border)') + ';border-right:none;background:' + (active ? 'rgba(108,140,255,0.1)' : 'var(--surface2)') + ';cursor:pointer">'
        + '<input type="checkbox" class="group-cb" value="' + gcEsc + '"' + (groupChecked ? ' checked' : '') + ' onchange="toggleGroupUnits(&#39;' + gcEsc + '&#39;,this.checked)" style="width:14px;height:14px">'
        + '</label>'
        + '<button onclick="selectGroupTab(&#39;' + gcEsc + '&#39;)" style="height:32px;padding:0 14px 0 8px;border-radius:0 6px 6px 0;border:1px solid ' + (active ? 'rgba(108,140,255,0.3)' : 'var(--border)') + ';background:' + (active ? 'rgba(108,140,255,0.1)' : 'var(--surface2)') + ';color:' + (active ? 'var(--blue)' : 'var(--text2)') + ';font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap">'
        + g.groupCode + ' <span style="font-size:12px;font-weight:400;color:var(--text3)">(' + g.units.length + ')</span></button>'
        + '</div>';
    });
    tabs.innerHTML = h;
  }

  window.selectGroupTab = function(groupCode) {
    _activeGroupCode = groupCode;
    renderGroupTabs();
    syncActiveGroupSelectAll();
    renderUnitGrid(groupCode);
  };

  // sync 진행 중 SSE unit-success 이벤트가 내려올 때마다 _stgData 의 해당 유닛을
  // post-sync 상태로 갱신하고, 현재 탭이면 즉시 re-render. skipped 유닛은 건너뜀.
  // 뷰 주의: postNonRevenue / postUserName / postUserPhone 는 DB 규칙 기반이라
  //   - DB 뷰 → 그대로 반영
  //   - STG 뷰 → nonRevenue 는 STG unit.state='blocked' 기준이므로 건드리지 않음
  //     (STG blocked 유닛은 sync 에서 skip → ev.skipped=true 로 여기 진입 안 함)
  function applyUnitSyncUpdate(ev) {
    if (!_stgData || ev.skipped || !ev.groupCode || ev.showBoxNo == null) return;
    if (!ev.postState) return;
    var group = _stgData.groups.find(function(g) { return g.groupCode === ev.groupCode; });
    if (!group) return;
    var unit = group.units.find(function(u) { return u.showBoxNo === ev.showBoxNo; });
    if (!unit) return;
    unit.state = ev.postState;
    unit.overlocked = !!ev.postOverlocked;
    if (_unitViewMode === 'db') {
      if (ev.postNonRevenue) unit.nonRevenue = true;
      else delete unit.nonRevenue;
      unit.userName = ev.postUserName || '';
      unit.userPhone = ev.postUserPhone || '';
    }
    if (_activeGroupCode === ev.groupCode) renderUnitGrid(_activeGroupCode);
  }

  window.toggleGroupUnits = function(groupCode, checked) {
    if (!_stgData) return;
    var group = _stgData.groups.find(function(g) { return g.groupCode === groupCode; });
    if (!group) return;
    group.units.forEach(function(u) {
      var key = groupCode + ':' + u.showBoxNo;
      if (checked) _selectedUnits[key] = true;
      else delete _selectedUnits[key];
    });
    syncActiveGroupSelectAll();
    if (groupCode === _activeGroupCode) renderUnitGrid(groupCode);
  };

  function renderUnitGrid(groupCode) {
    if (!_stgData) return;
    var group = _stgData.groups.find(function(g) { return g.groupCode === groupCode; });
    var grid = document.getElementById('unitGrid');

    if (!group || !group.units.length) {
      grid.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text3);font-size:11px">유닛 없음</div>';
      return;
    }

    var rows = 10;
    var cols = Math.ceil(group.units.length / rows);
    var h = '<div style="display:grid;grid-template-rows:repeat(' + rows + ',1fr);grid-auto-flow:column;grid-auto-columns:60px;gap:4px;width:max-content;max-width:max-content">';
    group.units.forEach(function(u) {
      var key = groupCode + ':' + u.showBoxNo;
      var selected = !!_selectedUnits[key];
      var effectiveState = u.overlocked
        ? 'overlocked'
        : (u.nonRevenue ? 'blocked_nonrevenue' : u.state);
      var tile = UNIT_TILE_STYLES[effectiveState] || UNIT_TILE_STYLES.unknown;
      var bg = selected ? tile.selectedBg : tile.bg;
      var color = selected ? tile.selectedColor : tile.color;
      var baseBorder = selected ? 'rgba(255,255,255,0.2)' : tile.border;
      var border = '1px solid ' + baseBorder;

      var titleParts = [esc(u.name)];
      if (u.overlocked) titleParts.push('오버락');
      else if (u.state) titleParts.push(esc(u.state));
      if (u.userName || u.userPhone) {
        var who = [u.userName, u.userPhone].filter(Boolean).join(' · ');
        if (who) titleParts.push(esc(who));
      }

      h += '<div onclick="toggleUnit(&#39;' + esc(key) + '&#39;)" style="'
        + 'display:flex;align-items:center;justify-content:center;'
        + 'padding:6px 2px;border-radius:4px;cursor:pointer;user-select:none;'
        + 'background:' + bg + ';border:' + border + ';color:' + color + ';'
        + 'font-size:11px;font-weight:600;min-height:32px;'
        + '" title="' + titleParts.join(' — ') + '">'
        + u.name
        + '</div>';
    });
    h += '</div>';
    grid.innerHTML = h;
  }

  window.toggleUnit = function(key) {
    if (_selectedUnits[key]) delete _selectedUnits[key];
    else _selectedUnits[key] = true;
    syncActiveGroupSelectAll();
    renderGroupTabs();
    if (_activeGroupCode) renderUnitGrid(_activeGroupCode);
  };

  function syncActiveGroupSelectAll() {
    var unitSelectAll = document.getElementById('unitSelectAll');
    if (!unitSelectAll) return;
    if (!_stgData || !_activeGroupCode) {
      unitSelectAll.checked = false;
      return;
    }
    var group = _stgData.groups.find(function(g) { return g.groupCode === _activeGroupCode; });
    if (!group || !group.units.length) {
      unitSelectAll.checked = false;
      return;
    }
    var allChecked = true;
    group.units.forEach(function(u) {
      if (!_selectedUnits[_activeGroupCode + ':' + u.showBoxNo]) allChecked = false;
    });
    unitSelectAll.checked = allChecked;
  }

  window.toggleAllUnits = function(checked) {
    if (!_stgData || !_activeGroupCode) return;
    var group = _stgData.groups.find(function(g) { return g.groupCode === _activeGroupCode; });
    if (!group) return;
    group.units.forEach(function(u) {
      var key = _activeGroupCode + ':' + u.showBoxNo;
      if (checked) _selectedUnits[key] = true;
      else delete _selectedUnits[key];
    });
    syncActiveGroupSelectAll();
    renderGroupTabs();
    renderUnitGrid(_activeGroupCode);
  };

  function getSyncBody() {
    var officeCode = getCurrentSiteSyncOffice();
    var body = { officeCode: officeCode };

    var keys = Object.keys(_selectedUnits);
    if (keys.length === 0) {
      body.groupCodes = []; // 아무것도 선택 안 됨
      return body;
    }

    // 전체 선택인지 확인
    if (_stgData) {
      var totalUnits = 0;
      _stgData.groups.forEach(function(g) { totalUnits += g.units.length; });
      if (keys.length === totalUnits) return body; // 전체 → 필터 없이
    }

    // 선택된 유닛을 그룹별로 모아서 unitFilters로 전달
    var groupMap = {};
    keys.forEach(function(k) {
      var parts = k.split(':');
      var gc = parts[0], bn = parseInt(parts[1], 10);
      if (!groupMap[gc]) groupMap[gc] = [];
      groupMap[gc].push(bn);
    });

    // 그룹 전체 선택인 그룹은 groupCodes로, 일부만 선택은 unitFilters로
    var fullGroups = [];
    var partialFilters = [];
    Object.keys(groupMap).forEach(function(gc) {
      var group = _stgData && _stgData.groups.find(function(g) { return g.groupCode === gc; });
      if (group && groupMap[gc].length === group.units.length) {
        fullGroups.push(gc);
      } else {
        partialFilters.push({ groupCode: gc, showBoxNos: groupMap[gc] });
      }
    });

    if (partialFilters.length > 0) {
      body.unitFilters = partialFilters;
    }
    if (fullGroups.length > 0) {
      body.groupCodes = fullGroups;
    }
    return body;
  }

  // ── Site Sync ──
  var _siteSyncJobId = null;

  function siteSyncDone() {
    var btn = document.getElementById('siteSyncBtn');
    var stopBtn = document.getElementById('siteSyncStopBtn');
    btn.disabled = false;
    btn.textContent = '동기화 시작';
    btn.style.opacity = '1';
    stopBtn.style.display = 'none';
    _siteSyncJobId = null;
  }

  window.startSiteSync = function() {
    var officeCode = getCurrentSiteSyncOffice();
    var btn = document.getElementById('siteSyncBtn');
    var stopBtn = document.getElementById('siteSyncStopBtn');
    var status = document.getElementById('siteSyncStatus');
    var label = document.getElementById('siteSyncLabel');
    var count = document.getElementById('siteSyncCount');
    var bar = document.getElementById('siteSyncBar');
    var log = document.getElementById('siteSyncLog');

    btn.disabled = true;
    btn.style.opacity = '0.5';
    stopBtn.style.display = 'inline-block';
    status.style.display = 'block';
    label.textContent = '지점 유닛 목록 조회 중...';
    count.textContent = '';
    bar.style.width = '0%';
    bar.style.background = 'var(--blue)';
    log.innerHTML = '';

    apiFetch('/monitoring/api/site-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getSyncBody())
    }).then(function(res) { return res.json(); }).then(function(data) {
      if (data.error) {
        label.textContent = data.error;
        siteSyncDone();
        return;
      }
      _siteSyncJobId = data.jobId;
      label.textContent = '동기화 시작됨...';

      apiFetch('/monitoring/api/site-sync/stream?jobId=' + data.jobId).then(function(response) {
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buf = '';

        function read() {
          reader.read().then(function(result) {
            if (result.done) return;
            buf += decoder.decode(result.value, { stream: true });
            var lines = buf.split('\\n');
            buf = lines.pop();
            for (var i = 0; i < lines.length; i++) {
              var line = lines[i];
              if (line.indexOf('data:') === 0) {
                var raw = line.slice(5).trim();
                if (!raw) continue;
                try {
                  var ev = JSON.parse(raw);
                  var pct = ev.total > 0 ? Math.round(ev.current / ev.total * 100) : 0;
                  bar.style.width = pct + '%';
                  count.textContent = ev.current + ' / ' + ev.total;

                  if (ev.type === 'unit-retry') {
                    log.innerHTML += '<div style="color:var(--amber)">[' + ev.attempt + '/' + ev.maxAttempts + '] ' + esc(ev.unitName) + ' 재시도 — ' + esc(ev.error) + '</div>';
                  } else if (ev.type === 'unit-success') {
                    var retryTag = ev.attempt > 1 ? ' <span style="color:var(--amber)">[' + ev.attempt + '/' + ev.maxAttempts + ']</span>' : '';
                    var statusTag;
                    if (ev.skipped) statusTag = ' <span style="color:var(--text3)">· 건너뜀</span>';
                    else if (ev.changed) statusTag = ' <span style="color:var(--amber)">· 변경됨</span>';
                    else statusTag = ' <span style="color:var(--text3)">· 변경 없음</span>';
                    log.innerHTML += '<div style="color:var(--green)">[OK] ' + esc(ev.unitName) + retryTag + statusTag + '</div>';
                    applyUnitSyncUpdate(ev);
                  } else if (ev.type === 'unit-error') {
                    var retryTag2 = ev.attempt > 1 ? ' [' + ev.attempt + '/' + ev.maxAttempts + ']' : '';
                    log.innerHTML += '<div style="color:var(--red)">[FAIL] ' + esc(ev.unitName) + retryTag2 + ': ' + esc(ev.error) + '</div>';
                  } else if (ev.type === 'progress') {
                    label.textContent = '동기화 중... (' + pct + '%)';
                  } else if (ev.type === 'complete') {
                    bar.style.width = '100%';
                    bar.style.background = ev.failed > 0 ? 'var(--amber)' : 'var(--green)';
                    label.textContent = '완료: ' + ev.succeeded + '개 성공, ' + ev.failed + '개 실패';
                    siteSyncDone();
                    if (ev.error) log.innerHTML += '<div style="color:var(--red)">' + esc(ev.error) + '</div>';
                  } else if (ev.type === 'stopped') {
                    bar.style.background = 'var(--amber)';
                    label.textContent = '중지됨: ' + ev.succeeded + '개 성공, ' + ev.failed + '개 실패 (' + ev.current + '/' + ev.total + ')';
                    siteSyncDone();
                  }
                  log.scrollTop = log.scrollHeight;
                } catch(e) {}
              }
            }
            read();
          }).catch(function() {
            label.textContent = '연결 끊김';
            siteSyncDone();
          });
        }
        read();
      });
    }).catch(function(e) {
      label.textContent = '오류: ' + e.message;
      siteSyncDone();
    });
  };

  window.stopSiteSync = function() {
    if (!_siteSyncJobId) return;
    document.getElementById('siteSyncLabel').textContent = '중지 요청 중...';
    apiFetch('/monitoring/api/site-sync/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: _siteSyncJobId })
    }).catch(function() {});
  };

  // ── Sync Tab Switch ──
  window.switchSyncTab = function(tab) {
    var siteTab = document.getElementById('syncTabSite');
    var userTab = document.getElementById('syncTabUser');
    var siteContent = document.getElementById('siteSyncContent');
    var userContent = document.getElementById('userSyncContent');
    var siteActions = document.getElementById('siteSyncActions');
    var userActions = document.getElementById('userSyncActions');
    if (tab === 'site') {
      siteTab.style.background = 'var(--accent)'; siteTab.style.color = '';
      userTab.style.background = 'var(--surface3)'; userTab.style.color = 'var(--text3)';
      siteContent.style.display = ''; userContent.style.display = 'none';
      siteActions.style.display = 'flex'; userActions.style.display = 'none';
    } else {
      userTab.style.background = 'var(--amber)'; userTab.style.color = '#000';
      siteTab.style.background = 'var(--surface3)'; siteTab.style.color = 'var(--text3)';
      userContent.style.display = ''; siteContent.style.display = 'none';
      userActions.style.display = 'flex'; siteActions.style.display = 'none';
    }
  };

  // ── User Sync ──
  var _userSyncJobId = null;
  var _showSkipped = false;

  window.toggleUserSyncSkipped = function() {
    _showSkipped = document.getElementById('userSyncShowSkipped').checked;
    var items = document.querySelectorAll('.us-skip-row');
    for (var i = 0; i < items.length; i++) {
      items[i].style.display = _showSkipped ? '' : 'none';
    }
  };

  function userSyncDone() {
    document.getElementById('userSyncBtn').disabled = false;
    document.getElementById('userSyncStopBtn').style.display = 'none';
    _userSyncJobId = null;
  }

  window.startUserSync = function() {
    var btn = document.getElementById('userSyncBtn');
    btn.disabled = true;
    document.getElementById('userSyncStopBtn').style.display = '';
    document.getElementById('userSyncIdle').style.display = 'none';
    var status = document.getElementById('userSyncStatus');
    status.style.display = 'block';
    document.getElementById('userSyncLabel').textContent = '사용자 목록 조회 중...';
    document.getElementById('userSyncCount').textContent = '';
    document.getElementById('userSyncBar').style.width = '0%';
    document.getElementById('userSyncLog').innerHTML = '';

    apiFetch('/monitoring/api/user-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    }).then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) {
        document.getElementById('userSyncLabel').textContent = data.error;
        userSyncDone();
        return;
      }
      _userSyncJobId = data.jobId;
      document.getElementById('userSyncLabel').textContent = '동기화 진행 중...';

      apiFetch('/monitoring/api/user-sync/stream?jobId=' + data.jobId).then(function(response) {
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';

        function read() {
          reader.read().then(function(result) {
            if (result.done) { userSyncDone(); return; }
            buffer += decoder.decode(result.value, { stream: true });
            var lines = buffer.split('\\n');
            buffer = lines.pop();
            lines.forEach(function(line) {
              if (!line.startsWith('data: ')) return;
              try {
                var ev = JSON.parse(line.slice(6));
                var pct = ev.total > 0 ? Math.round((ev.current / ev.total) * 100) : 0;
                document.getElementById('userSyncBar').style.width = pct + '%';
                document.getElementById('userSyncCount').textContent = ev.current + '/' + ev.total
                  + ' (성공:' + (ev.succeeded || 0) + ' 실패:' + (ev.failed || 0) + ' 스킵:' + (ev.skipped || 0) + ')';

                if (ev.type === 'progress') {
                  document.getElementById('userSyncLabel').textContent = '동기화 진행 중... ' + pct + '%';
                }
                if (ev.type === 'user-retry') {
                  var logEl = document.getElementById('userSyncLog');
                  logEl.innerHTML += '<div style="color:var(--amber)">[' + ev.attempt + '/' + ev.maxAttempts + '] ' + esc(ev.userName || ev.userId || '') + ' 재시도 — ' + esc(ev.error || '') + '</div>';
                  logEl.scrollTop = logEl.scrollHeight;
                }
                if (ev.type === 'user-skipped') {
                  var logEl = document.getElementById('userSyncLog');
                  logEl.innerHTML += '<div class="us-skip-row" style="color:var(--text3);display:' + (_showSkipped ? '' : 'none') + '">⊘ ' + esc(ev.userName || ev.userId || '') + ' — ' + esc(ev.error || '스킵') + '</div>';
                  logEl.scrollTop = logEl.scrollHeight;
                }
                if (ev.type === 'user-success' || ev.type === 'user-error') {
                  var logEl = document.getElementById('userSyncLog');
                  var color = ev.type === 'user-success' ? 'var(--green)' : 'var(--red)';
                  var icon = ev.type === 'user-success' ? '✓' : '✗';
                  var retryInfo = ev.attempt > 1 ? ' <span style="color:var(--amber)">[' + ev.attempt + '/' + ev.maxAttempts + ']</span>' : '';
                  logEl.innerHTML += '<div>' + '<span style="color:' + color + '">' + icon + '</span> ' + esc(ev.userName || ev.userId || '') + retryInfo + (ev.error ? ' — <span style="color:var(--red)">' + esc(ev.error) + '</span>' : '') + '</div>';
                  logEl.scrollTop = logEl.scrollHeight;
                }
                if (ev.type === 'complete') {
                  document.getElementById('userSyncLabel').textContent = '완료 — 성공:' + ev.succeeded + ' 실패:' + ev.failed + ' 스킵:' + ev.skipped;
                  document.getElementById('userSyncBar').style.width = '100%';
                  userSyncDone();
                }
                if (ev.type === 'stopped') {
                  document.getElementById('userSyncLabel').textContent = '중지됨 — ' + ev.current + '/' + ev.total;
                  userSyncDone();
                }
              } catch(e) {}
            });
            read();
          });
        }
        read();
      });
    }).catch(function(e) {
      document.getElementById('userSyncLabel').textContent = '오류: ' + e.message;
      userSyncDone();
    });
  };

  window.stopUserSync = function() {
    if (!_userSyncJobId) return;
    document.getElementById('userSyncLabel').textContent = '중지 요청 중...';
    apiFetch('/monitoring/api/user-sync/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: _userSyncJobId })
    }).catch(function() {});
  };

  // ── Process a single SSE entry ──
  function processEntry(entry) {
    stats.lastEventAt = entry.createdAt || entry.receivedAt;

    if (entry.status === 'success' && entry.correlationKey) {
      _resolvedCorrKeys[entry.correlationKey] = true;
    }

    if (entryMatchesCurrentFilters(entry)) {
      currentLogTotal++;
      if (currentPage === 1) {
        recentLogs.unshift(entry);
        if (recentLogs.length > pageSize) recentLogs.pop();
      } else if (currentSearchQuery) {
        pendingMatchingResults++;
        renderPendingSearchNotice();
      }
    }

    if (entry.status === 'error') {
    }
  }

  // ── API fetch helper (ngrok-skip-browser-warning 헤더는 ngrok 터널링 환경 대응용 잔재, 비-ngrok 에서는 무시됨) ──
  var defaultHeaders = { 'ngrok-skip-browser-warning': 'true', 'Accept': 'application/json' };
  var authRedirectInProgress = false;
  function redirectToMonitoringLogin() {
    if (authRedirectInProgress) return;
    authRedirectInProgress = true;
    window.location.href = '/login';
  }
  function apiFetch(url, opts) {
    var o = opts || {};
    o.headers = Object.assign({}, defaultHeaders, o.headers || {});
    return fetch(url, o).then(function(res) {
      if (res.status === 401) {
        redirectToMonitoringLogin();
        return Promise.reject(new Error('unauthorized'));
      }
      var ct = res.headers.get('content-type') || '';
      if (!res.ok || ct.indexOf('text/html') !== -1) {
        return Promise.reject(new Error('API error: ' + res.status));
      }
      return res;
    });
  }

  // ── Initial load ──
  async function init() {
    try {
      var [sRes, lRes, pRes] = await Promise.all([
        apiFetch('/monitoring/api/stats'),
        apiFetch('/monitoring/api/logs?limit=' + pageSize + '&offset=0&sources=' + currentSources.join(',')),
        apiFetch('/monitoring/api/pending')
      ]);
      stats = await sRes.json();
      var logData = await lRes.json();
      recentLogs = logData.items || [];
      currentLogTotal = logData.total || 0;
      pendingData = await pRes.json();
      renderSourceFilterLabel();
      renderSearchFieldLabel();
      syncSearchButtonState();
      renderAll(false);
    } catch (e) {
      console.error('Init error:', e);
      if (!authRedirectInProgress) {
        setTimeout(init, 3000);
      }
    }
  }

  init();
  loadGroups();

  // ── SSE (fetch-based) ──
  function connectSSE() {
    var badge = document.getElementById('connBadge');
    var txt = document.getElementById('connText');
    var ctrl = new AbortController();

    apiFetch('/monitoring/api/stream').then(function(response) {
      if (!response.ok || !response.body) {
        throw new Error('SSE connect failed: ' + response.status);
      }
      badge.className = 'conn-badge live';
      txt.textContent = '연결됨';

      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';

      function read() {
        reader.read().then(function(result) {
          if (result.done) { throw new Error('stream ended'); }
          buf += decoder.decode(result.value, { stream: true });
          var lines = buf.split('\\n');
          buf = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('data:') === 0) {
              var raw = line.slice(5).trim();
              if (!raw) continue;
              try {
                var entry = JSON.parse(raw);
                processEntry(entry);
                renderStats();
                renderRecentLogs(true);
                flashFeed();
                if (entry.status === 'error') {
                  var ep; try { ep = typeof entry.payload === 'string' ? JSON.parse(entry.payload) : entry.payload; } catch(e2) { ep = null; }
                  if (!ep || !ep.retrying) {
                    toast('error', label(entry.eventType) + ' 실패', entry.error || '알 수 없는 오류');
                  }
                }
              } catch(e) {}
            }
          }
          read();
        }).catch(reconnect);
      }
      read();
    }).catch(reconnect);

    function reconnect() {
      if (authRedirectInProgress) return;
      badge.className = 'conn-badge dead';
      txt.textContent = '연결 끊김';
      ctrl.abort();
      setTimeout(function() {
        txt.textContent = '재연결중...';
        connectSSE();
      }, 3000);
    }
  }

  connectSSE();

  // ── Live timers ──
  setInterval(function() {
    renderStats();
  }, 1000);

  // ── Pending refresh (every 60s) ──
  setInterval(async function() {
    try {
      var pRes = await apiFetch('/monitoring/api/pending');
      pendingData = await pRes.json();
      renderPending();
    } catch(e) {}
  }, 60000);

  // ── Test Email ──
  async function loadTestEmailConfig() {
    try {
      var res = await apiFetch('/monitoring/api/test-email/config');
      var cfg = await res.json();
      var host = document.getElementById('testEmailHost');
      var port = document.getElementById('testEmailPort');
      var from = document.getElementById('testEmailFrom');
      var note = document.getElementById('testEmailConfigNote');
      if (host) host.value = cfg.host || '(미설정)';
      if (port) port.value = cfg.port != null ? String(cfg.port) : '';
      if (from) from.value = cfg.from || '';
      if (note) {
        if (!cfg.transporterReady) {
          note.textContent = 'SMTP 설정 없음 (HOST/USER/PASS 입력 후 서버 재시작)';
          note.style.color = 'var(--red)';
        } else {
          note.textContent = '전송 준비 완료';
          note.style.color = 'var(--green)';
        }
      }
    } catch (e) {
      var note = document.getElementById('testEmailConfigNote');
      if (note) {
        note.textContent = '설정 조회 실패: ' + (e.message || e);
        note.style.color = 'var(--red)';
      }
    }
  }

  window.sendTestEmail = async function() {
    var to = document.getElementById('testEmailTo').value.trim();
    var subject = document.getElementById('testEmailSubject').value;
    var body = document.getElementById('testEmailBody').value;
    var btn = document.getElementById('testEmailBtn');
    var result = document.getElementById('testEmailResult');

    if (!to) {
      result.textContent = '수신자 이메일을 입력하세요';
      result.style.color = 'var(--red)';
      return;
    }

    btn.disabled = true;
    btn.textContent = '전송 중...';
    result.textContent = '';

    try {
      var res = await apiFetch('/monitoring/api/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: to, subject: subject, body: body }),
      });
      var data = await res.json();
      if (data.ok) {
        result.textContent = '✓ 전송 성공' + (data.messageId ? ' (messageId: ' + data.messageId + ')' : '');
        result.style.color = 'var(--green)';
      } else {
        result.textContent = '✗ ' + (data.error || '전송 실패');
        result.style.color = 'var(--red)';
      }
    } catch (e) {
      result.textContent = '✗ ' + (e.message || '전송 실패');
      result.style.color = 'var(--red)';
    } finally {
      btn.disabled = false;
      btn.textContent = '전송';
    }
  };

  loadTestEmailConfig();
})();
</script>
</body>
</html>`;

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Solomon's Key — Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root {
    --bg: #0b0b0f;
    --fg: #e5e7eb;
    --muted: #6b7280;
    --gold: #d4a73a;
    --panel: #16161d;
    --border: #262630;
    --accent: #2563eb;
    --danger: #dc2626;
    --success: #10b981;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font-family: ui-monospace,Menlo,Consolas,monospace;
    font-size: 13px; line-height: 1.5;
  }
  header {
    padding: 16px 24px; border-bottom: 1px solid var(--border);
    display: flex; justify-content: space-between; align-items: baseline;
  }
  header h1 { margin: 0; color: var(--gold); font-size: 18px; font-weight: 600; }
  header .meta { color: var(--muted); font-size: 11px; }
  main { padding: 16px 24px; display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); }
  section {
    background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
    padding: 12px 14px;
  }
  section h2 { margin: 0 0 8px; font-size: 12px; color: var(--gold); text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td, th { padding: 4px 6px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 400; font-size: 11px; }
  tr:last-child td { border-bottom: none; }
  .pill { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 11px; }
  .pill.ok { background: rgba(16,185,129,0.15); color: var(--success); }
  .pill.warn { background: rgba(212,167,58,0.15); color: var(--gold); }
  .pill.err { background: rgba(220,38,38,0.15); color: var(--danger); }
  .empty { color: var(--muted); font-style: italic; padding: 4px 0; }
  .refresh { color: var(--muted); font-size: 11px; margin-left: 8px; }
</style>
</head>
<body>
<header>
  <h1>Solomon's Key</h1>
  <div class="meta">dashboard · <span id="stamp">—</span> <span class="refresh">refresh 10s</span></div>
</header>
<main>
  <section><h2>Agents</h2><div id="agents" class="empty">loading…</div></section>
  <section><h2>Sessions</h2><div id="sessions" class="empty">loading…</div></section>
  <section><h2>Active missions</h2><div id="missions" class="empty">loading…</div></section>
  <section><h2>Token usage (today)</h2><div id="usage" class="empty">loading…</div></section>
  <section><h2>Recent activity</h2><div id="hive" class="empty">loading…</div></section>
  <section><h2>Audit log</h2><div id="audit" class="empty">loading…</div></section>
</main>
<script>
(function(){
  const qs = new URLSearchParams(location.search);
  const tok = qs.get('token') || '';
  const h = { 'x-dashboard-token': tok };

  function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmtTime(ms){ if (!ms) return '—'; try { return new Date(ms).toISOString().replace('T',' ').slice(0,19); } catch { return String(ms); } }

  function renderTable(rows, cols) {
    if (!rows || !rows.length) return '<div class="empty">(empty)</div>';
    const thead = '<tr>' + cols.map(c => '<th>'+esc(c.label)+'</th>').join('') + '</tr>';
    const body = rows.map(r => '<tr>' + cols.map(c => '<td>' + (c.render ? c.render(r) : esc(r[c.key])) + '</td>').join('') + '</tr>').join('');
    return '<table>' + thead + body + '</table>';
  }

  async function fetchJson(path) {
    const r = await fetch(path, { headers: h });
    if (!r.ok) throw new Error(path + ' ' + r.status);
    return r.json();
  }

  async function tick() {
    try {
      const [status, missions, usage, hive, audit] = await Promise.all([
        fetchJson('/api/status'),
        fetchJson('/api/missions?active=1'),
        fetchJson('/api/usage'),
        fetchJson('/api/hive?limit=25'),
        fetchJson('/api/audit?limit=25'),
      ]);

      document.getElementById('agents').innerHTML = renderTable(status.agents, [
        { key: 'id', label: 'id' },
        { key: 'title', label: 'title' },
        { key: 'model', label: 'model' },
        { key: 'tools', label: 'tools', render: r => esc((r.tools||[]).join(',')) },
      ]);

      document.getElementById('sessions').innerHTML = renderTable(status.sessions, [
        { key: 'chat_id', label: 'chat' },
        { key: 'agent_id', label: 'agent' },
        { key: 'locked', label: 'state', render: r => '<span class="pill '+(r.locked?'err':'ok')+'">'+(r.locked?'locked':'unlocked')+'</span>' },
        { key: 'last_activity', label: 'last', render: r => esc(fmtTime(r.last_activity)) },
      ]);

      document.getElementById('missions').innerHTML = renderTable(missions.rows, [
        { key: 'id', label: 'id', render: r => esc(String(r.id).slice(0,8)) },
        { key: 'title', label: 'title' },
        { key: 'status', label: 'status' },
        { key: 'agent_id', label: 'agent', render: r => esc(r.agent_id || 'main') },
      ]);

      document.getElementById('usage').innerHTML =
        '<div>input: <b>'+esc(usage.total.input_tokens.toLocaleString())+'</b> · output: <b>'+esc(usage.total.output_tokens.toLocaleString())+'</b></div>'+
        '<div>cost: <b>$'+Number(usage.total.cost_usd).toFixed(4)+'</b> · today: <b>$'+Number(usage.daily).toFixed(4)+'</b></div>';

      document.getElementById('hive').innerHTML = renderTable(hive.rows, [
        { key: 'agent_id', label: 'agent' },
        { key: 'action', label: 'action' },
        { key: 'summary', label: 'summary', render: r => esc(String(r.summary||'').slice(0,80)) },
        { key: 'timestamp', label: 'when', render: r => esc(fmtTime(r.timestamp)) },
      ]);

      document.getElementById('audit').innerHTML = renderTable(audit.rows, [
        { key: 'chat_id', label: 'chat' },
        { key: 'agent_id', label: 'agent' },
        { key: 'action', label: 'action' },
        { key: 'detail', label: 'detail', render: r => esc(String(r.detail||'').slice(0,60)) },
      ]);

      document.getElementById('stamp').textContent = fmtTime(Date.now());
    } catch (err) {
      document.getElementById('stamp').textContent = 'error: ' + (err.message || err);
    }
  }
  tick();
  setInterval(tick, 10000);
})();
</script>
</body>
</html>`;

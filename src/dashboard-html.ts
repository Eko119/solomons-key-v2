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
    --accent-dim: rgba(37,99,235,0.15);
    --input-bg: #0b0b0f;
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
  nav {
    display: flex; gap: 8px; padding: 8px 24px;
    border-bottom: 1px solid var(--border); background: var(--panel);
    overflow-x: auto;
  }
  nav a {
    color: var(--muted); text-decoration: none; padding: 4px 10px;
    border-radius: 4px; font-size: 12px; white-space: nowrap;
  }
  nav a:hover { color: var(--fg); background: var(--accent-dim); }
  main { padding: 16px 24px; display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); }
  .mktg-row {
    padding: 0 24px 24px; display: grid; gap: 16px;
    grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  }
  section {
    background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
    padding: 12px 14px;
  }
  section h2 { margin: 0 0 8px; font-size: 12px; color: var(--gold); text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600; }
  section h3 { margin: 12px 0 6px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td, th { padding: 4px 6px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 400; font-size: 11px; }
  tr:last-child td { border-bottom: none; }
  tr.selected { background: var(--accent-dim); }
  .pill { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 11px; }
  .pill.ok { background: rgba(16,185,129,0.15); color: var(--success); }
  .pill.warn { background: rgba(212,167,58,0.15); color: var(--gold); }
  .pill.err { background: rgba(220,38,38,0.15); color: var(--danger); }
  .pill.info { background: var(--accent-dim); color: var(--accent); }
  .empty { color: var(--muted); font-style: italic; padding: 4px 0; }
  .refresh { color: var(--muted); font-size: 11px; margin-left: 8px; }
  input, select, textarea {
    background: var(--input-bg); color: var(--fg);
    border: 1px solid var(--border); border-radius: 4px;
    padding: 4px 8px; font-family: inherit; font-size: 12px;
  }
  textarea { width: 100%; min-height: 60px; resize: vertical; }
  button {
    background: var(--accent); color: var(--fg);
    border: 1px solid var(--accent); border-radius: 4px;
    padding: 4px 10px; cursor: pointer; font-family: inherit; font-size: 12px;
  }
  button:hover { background: var(--accent-dim); color: var(--accent); }
  button.danger { background: var(--danger); border-color: var(--danger); }
  button.danger:hover { background: rgba(220,38,38,0.15); color: var(--danger); }
  button.ghost { background: transparent; color: var(--muted); border-color: var(--border); }
  button.ghost:hover { color: var(--fg); }
  .inline-form { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; align-items: center; }
  .inline-form input, .inline-form select { flex: 1; min-width: 100px; }
  .stat { display: inline-block; margin-right: 12px; }
  .stat b { color: var(--fg); }
  .stat label { color: var(--muted); font-size: 11px; margin-right: 4px; }
  pre.report {
    background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
    padding: 8px; font-size: 11px; white-space: pre-wrap; max-height: 320px; overflow: auto;
  }
  @media (max-width: 720px) {
    header { flex-direction: column; align-items: flex-start; gap: 4px; }
    nav { padding: 6px 12px; }
    main, .mktg-row { padding-left: 12px; padding-right: 12px; }
  }
</style>
</head>
<body>
<header>
  <h1>Solomon's Key</h1>
  <div class="meta">dashboard · <span id="stamp">—</span> <span class="refresh">refresh 10s</span></div>
</header>
<nav>
  <a href="#agents">Agents</a>
  <a href="#sessions">Sessions</a>
  <a href="#missions">Missions</a>
  <a href="#usage">Usage</a>
  <a href="#hive">Activity</a>
  <a href="#audit">Audit</a>
  <a href="#schedule-section">Schedule</a>
  <a href="#mktg-clients-section">Clients</a>
  <a href="#mktg-leads-section">Leads</a>
  <a href="#mktg-scrape-section">Scrape</a>
  <a href="#mktg-outreach-section">Outreach</a>
  <a href="#mktg-calendar-section">Calendar</a>
  <a href="#mktg-report-section">Report</a>
</nav>
<main>
  <section id="agents-section"><h2>Agents</h2><div id="agents" class="empty">loading…</div></section>
  <section id="sessions-section"><h2>Sessions</h2><div id="sessions" class="empty">loading…</div></section>
  <section id="missions-section"><h2>Active missions</h2><div id="missions" class="empty">loading…</div></section>
  <section id="usage-section"><h2>Token usage (today)</h2><div id="usage" class="empty">loading…</div></section>
  <section id="hive-section"><h2>Recent activity</h2><div id="hive" class="empty">loading…</div></section>
  <section id="audit-section"><h2>Audit log</h2><div id="audit" class="empty">loading…</div></section>
  <section id="schedule-section"><h2>Schedule</h2><div id="schedule" class="empty">loading…</div></section>
</main>
<div class="mktg-row">
  <section id="mktg-clients-section">
    <h2>Marketing clients</h2>
    <div id="mktg-clients" class="empty">loading…</div>
    <h3>New client</h3>
    <div class="inline-form">
      <input id="newc-name" placeholder="name">
      <input id="newc-industry" placeholder="industry">
      <select id="newc-platform">
        <option value="instagram">instagram</option>
        <option value="twitter">twitter</option>
        <option value="linkedin">linkedin</option>
        <option value="tiktok">tiktok</option>
      </select>
      <input id="newc-voice" placeholder="brand voice">
      <button id="newc-btn">Create</button>
    </div>
    <div id="mktg-settings" style="display:none;">
      <h3>Edit settings</h3>
      <div class="inline-form">
        <input id="setc-name" placeholder="name">
        <input id="setc-industry" placeholder="industry">
        <select id="setc-platform">
          <option value="">(unchanged)</option>
          <option value="instagram">instagram</option>
          <option value="twitter">twitter</option>
          <option value="linkedin">linkedin</option>
          <option value="tiktok">tiktok</option>
        </select>
        <input id="setc-voice" placeholder="brand voice">
        <button id="setc-btn">Save</button>
      </div>
    </div>
  </section>
  <section id="mktg-leads-section">
    <h2>Leads</h2>
    <div id="mktg-leads-summary" class="empty">select a client</div>
    <div id="mktg-leads"></div>
  </section>
  <section id="mktg-scrape-section">
    <h2>Scrape</h2>
    <div class="inline-form">
      <select id="scrape-platform">
        <option value="instagram">instagram</option>
        <option value="twitter">twitter</option>
        <option value="linkedin">linkedin</option>
        <option value="tiktok">tiktok</option>
      </select>
      <input id="scrape-targets" placeholder="targets, comma-separated">
      <input id="scrape-max" placeholder="max" type="number" min="1" style="max-width: 70px;">
      <button id="scrape-btn">Queue scrape</button>
    </div>
    <div id="mktg-scrape" class="empty">select a client</div>
  </section>
  <section id="mktg-outreach-section">
    <h2>Outreach queue</h2>
    <div class="inline-form">
      <button id="draft-btn">Draft DMs for enriched leads</button>
    </div>
    <div id="mktg-outreach" class="empty">select a client</div>
  </section>
  <section id="mktg-calendar-section">
    <h2>Content calendar</h2>
    <div class="inline-form">
      <select id="cal-platform">
        <option value="instagram">instagram</option>
        <option value="twitter">twitter</option>
        <option value="linkedin">linkedin</option>
        <option value="tiktok">tiktok</option>
      </select>
      <button id="cal-btn">Generate 14-day calendar</button>
    </div>
    <div id="mktg-calendar" class="empty">select a client</div>
  </section>
  <section id="mktg-report-section">
    <h2>Weekly report</h2>
    <div class="inline-form">
      <button id="report-btn">Generate report</button>
    </div>
    <div id="mktg-report" class="empty">select a client</div>
  </section>
</div>
<script>
(function(){
  var qs = new URLSearchParams(location.search);
  var tok = qs.get('token') || '';
  var h = { 'x-dashboard-token': tok };
  var jsonHeaders = { 'x-dashboard-token': tok, 'content-type': 'application/json' };
  var selectedClientId = null;

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function fmtTime(ms){ if (!ms) return '—'; try { return new Date(ms).toISOString().replace('T',' ').slice(0,19); } catch (_e) { return String(ms); } }
  function pill(kind, label){ return '<span class="pill '+esc(kind)+'">'+esc(label)+'</span>'; }

  function renderTable(rows, cols) {
    if (!rows || !rows.length) return '<div class="empty">(empty)</div>';
    var thead = '<tr>' + cols.map(function(c){ return '<th>'+esc(c.label)+'</th>'; }).join('') + '</tr>';
    var body = rows.map(function(r){
      var tr = (r._selected ? '<tr class="selected">' : '<tr>');
      return tr + cols.map(function(c){ return '<td>' + (c.render ? c.render(r) : esc(r[c.key])) + '</td>'; }).join('') + '</tr>';
    }).join('');
    return '<table>' + thead + body + '</table>';
  }

  async function fetchJson(path) {
    var r = await fetch(path, { headers: h });
    if (!r.ok) throw new Error(path + ' ' + r.status);
    return r.json();
  }
  async function postJson(path, body) {
    var r = await fetch(path, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body || {}) });
    var j = null;
    try { j = await r.json(); } catch (_e) {}
    return { status: r.status, json: j };
  }

  function selectClient(id) {
    selectedClientId = id;
    document.getElementById('mktg-settings').style.display = id ? '' : 'none';
    refreshMarketingPanels();
  }

  async function renderClients() {
    try {
      var data = await fetchJson('/api/marketing/clients');
      var rows = (data.clients || []).map(function(c){ return Object.assign({}, c, { _selected: c.id === selectedClientId }); });
      document.getElementById('mktg-clients').innerHTML = renderTable(rows, [
        { key: 'name', label: 'name' },
        { key: 'industry', label: 'industry' },
        { key: 'targetPlatform', label: 'platform', render: function(r){ return pill('info', r.targetPlatform); } },
        { key: 'id', label: '', render: function(r){
          var sel = r.id === selectedClientId ? 'selected' : 'select';
          return '<button class="ghost" onclick="window.__mktg.selectClient('+JSON.stringify(r.id)+')">'+esc(sel)+'</button>';
        } },
      ]);
    } catch (err) {
      document.getElementById('mktg-clients').innerHTML = '<div class="empty">error: '+esc(err.message || String(err))+'</div>';
    }
  }

  async function createClient() {
    var name = document.getElementById('newc-name').value.trim();
    var industry = document.getElementById('newc-industry').value.trim();
    var platform = document.getElementById('newc-platform').value;
    var voice = document.getElementById('newc-voice').value.trim();
    if (!name || !industry || !voice) return;
    var res = await postJson('/api/marketing/clients', { name: name, industry: industry, targetPlatform: platform, brandVoice: voice });
    if (res.status === 201) {
      document.getElementById('newc-name').value = '';
      document.getElementById('newc-industry').value = '';
      document.getElementById('newc-voice').value = '';
      await renderClients();
    } else {
      alert('Create failed: ' + (res.json && res.json.error || res.status));
    }
  }

  async function saveSettings() {
    if (!selectedClientId) return;
    var body = {};
    var name = document.getElementById('setc-name').value.trim();
    var industry = document.getElementById('setc-industry').value.trim();
    var platform = document.getElementById('setc-platform').value;
    var voice = document.getElementById('setc-voice').value.trim();
    if (name) body.name = name;
    if (industry) body.industry = industry;
    if (platform) body.targetPlatform = platform;
    if (voice) body.brandVoice = voice;
    if (Object.keys(body).length === 0) return;
    var res = await postJson('/api/marketing/clients/'+encodeURIComponent(selectedClientId)+'/settings', body);
    if (res.status !== 200) {
      alert('Save failed: ' + (res.json && res.json.error || res.status));
      return;
    }
    document.getElementById('setc-name').value = '';
    document.getElementById('setc-industry').value = '';
    document.getElementById('setc-platform').value = '';
    document.getElementById('setc-voice').value = '';
    await renderClients();
  }

  async function renderLeads() {
    var box = document.getElementById('mktg-leads');
    var summary = document.getElementById('mktg-leads-summary');
    if (!selectedClientId) { summary.className = 'empty'; summary.textContent = 'select a client'; box.innerHTML = ''; return; }
    try {
      var data = await fetchJson('/api/marketing/clients/'+encodeURIComponent(selectedClientId)+'/leads');
      summary.className = '';
      summary.innerHTML = '<span class="stat"><label>total</label><b>'+esc(String(data.leads.length))+'</b></span>';
      box.innerHTML = renderTable(data.leads.slice(0, 50), [
        { key: 'platform', label: 'platform' },
        { key: 'displayName', label: 'name' },
        { key: 'profileUrl', label: 'profile', render: function(r){ return '<a href="'+esc(r.profileUrl)+'" target="_blank" rel="noopener">'+esc(r.profileUrl)+'</a>'; } },
        { key: 'status', label: 'status', render: function(r){ return pill('info', r.status); } },
      ]);
    } catch (err) {
      box.innerHTML = '<div class="empty">error: '+esc(err.message || String(err))+'</div>';
    }
  }

  async function renderScrapeJobs() {
    var box = document.getElementById('mktg-scrape');
    if (!selectedClientId) { box.className = 'empty'; box.textContent = 'select a client'; return; }
    try {
      var data = await fetchJson('/api/marketing/clients/'+encodeURIComponent(selectedClientId)+'/scrape/jobs');
      box.className = '';
      box.innerHTML = renderTable(data.jobs, [
        { key: 'id', label: 'id' },
        { key: 'platform', label: 'platform' },
        { key: 'status', label: 'status', render: function(r){
          var k = r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'err' : r.status === 'running' ? 'warn' : 'info';
          return pill(k, r.status);
        } },
        { key: 'leadsFound', label: 'leads' },
        { key: 'createdAt', label: 'created', render: function(r){ return esc(fmtTime(r.createdAt)); } },
      ]);
    } catch (err) {
      box.innerHTML = '<div class="empty">error: '+esc(err.message || String(err))+'</div>';
    }
  }

  async function submitScrape() {
    if (!selectedClientId) { alert('Select a client first'); return; }
    var platform = document.getElementById('scrape-platform').value;
    var rawTargets = document.getElementById('scrape-targets').value;
    var max = parseInt(document.getElementById('scrape-max').value, 10);
    var targets = rawTargets.split(',').map(function(s){ return s.trim(); }).filter(function(s){ return s.length > 0; });
    if (targets.length === 0) { alert('Enter at least one target'); return; }
    var body = { platform: platform, searchTargets: targets };
    if (Number.isFinite(max) && max > 0) body.maxLeads = max;
    var res = await postJson('/api/marketing/clients/'+encodeURIComponent(selectedClientId)+'/scrape', body);
    if (res.status === 202) {
      document.getElementById('scrape-targets').value = '';
      await renderScrapeJobs();
    } else {
      alert('Scrape failed: ' + (res.json && res.json.error || res.status));
    }
  }

  async function renderOutreach() {
    var box = document.getElementById('mktg-outreach');
    if (!selectedClientId) { box.className = 'empty'; box.textContent = 'select a client'; return; }
    try {
      var data = await fetchJson('/api/marketing/clients/'+encodeURIComponent(selectedClientId)+'/outreach');
      box.className = '';
      box.innerHTML = renderTable(data.queue, [
        { key: 'id', label: 'id' },
        { key: 'leadId', label: 'lead' },
        { key: 'draftMessage', label: 'draft', render: function(r){ return esc(String(r.draftMessage || '').slice(0, 100)); } },
        { key: 'status', label: 'status', render: function(r){
          var k = r.status === 'sent' ? 'ok' : r.status === 'rejected' ? 'err' : r.status === 'approved' ? 'warn' : 'info';
          return pill(k, r.status);
        } },
        { key: 'id', label: '', render: function(r){
          if (r.status !== 'pending' && r.status !== 'approved') return '';
          var qid = JSON.stringify(r.id);
          var cid = JSON.stringify(selectedClientId);
          var btns = '';
          if (r.status === 'pending') btns += '<button onclick="window.__mktg.approveOutreach('+cid+','+qid+')">Approve</button> ';
          btns += '<button class="ghost" onclick="window.__mktg.rejectOutreach('+cid+','+qid+')">Reject</button> ';
          if (r.status === 'approved') btns += '<button class="ghost" onclick="window.__mktg.markSent('+cid+','+qid+')">Mark sent</button>';
          return btns;
        } },
      ]);
    } catch (err) {
      box.innerHTML = '<div class="empty">error: '+esc(err.message || String(err))+'</div>';
    }
  }

  async function approveOutreach(cid, qid) {
    var res = await postJson('/api/marketing/clients/'+encodeURIComponent(cid)+'/outreach/'+qid+'/approve');
    if (res.status === 200) await renderOutreach();
  }
  async function rejectOutreach(cid, qid) {
    var note = prompt('Rejection note (optional):') || '';
    var res = await postJson('/api/marketing/clients/'+encodeURIComponent(cid)+'/outreach/'+qid+'/reject', { note: note });
    if (res.status === 200) await renderOutreach();
  }
  async function markSent(cid, qid) {
    var res = await postJson('/api/marketing/clients/'+encodeURIComponent(cid)+'/outreach/'+qid+'/sent');
    if (res.status === 200) await renderOutreach();
  }
  async function draftOutreach() {
    if (!selectedClientId) { alert('Select a client first'); return; }
    var res = await postJson('/api/marketing/clients/'+encodeURIComponent(selectedClientId)+'/outreach/draft');
    if (res.status === 202) alert('Drafting queued. Refresh in a moment.');
    else alert('Draft failed: ' + (res.json && res.json.error || res.status));
  }

  async function renderCalendar() {
    var box = document.getElementById('mktg-calendar');
    if (!selectedClientId) { box.className = 'empty'; box.textContent = 'select a client'; return; }
    try {
      var data = await fetchJson('/api/marketing/clients/'+encodeURIComponent(selectedClientId)+'/calendar');
      box.className = '';
      box.innerHTML = renderTable(data.posts, [
        { key: 'platform', label: 'platform' },
        { key: 'scheduledFor', label: 'when', render: function(r){ return esc(fmtTime(r.scheduledFor)); } },
        { key: 'postText', label: 'post', render: function(r){ return esc(String(r.postText || '').slice(0, 120)); } },
        { key: 'status', label: 'status', render: function(r){ return pill('info', r.status || 'scheduled'); } },
      ]);
    } catch (err) {
      box.innerHTML = '<div class="empty">error: '+esc(err.message || String(err))+'</div>';
    }
  }

  async function generateCalendar() {
    if (!selectedClientId) { alert('Select a client first'); return; }
    var platform = document.getElementById('cal-platform').value;
    var res = await postJson('/api/marketing/clients/'+encodeURIComponent(selectedClientId)+'/calendar/generate', { platform: platform });
    if (res.status === 202) alert('Calendar generation queued. Refresh in a moment.');
    else alert('Generate failed: ' + (res.json && res.json.error || res.status));
  }

  async function renderReport() {
    var box = document.getElementById('mktg-report');
    if (!selectedClientId) { box.className = 'empty'; box.textContent = 'select a client'; return; }
    box.className = 'empty';
    box.textContent = 'click "Generate report"';
  }

  async function generateReport() {
    if (!selectedClientId) { alert('Select a client first'); return; }
    var box = document.getElementById('mktg-report');
    box.className = '';
    box.innerHTML = '<div class="empty">generating…</div>';
    try {
      var data = await fetchJson('/api/marketing/clients/'+encodeURIComponent(selectedClientId)+'/report');
      box.innerHTML = '<div class="empty">generated '+esc(fmtTime(data.generatedAt))+'</div><pre class="report">'+esc(data.report)+'</pre>';
    } catch (err) {
      box.innerHTML = '<div class="empty">error: '+esc(err.message || String(err))+'</div>';
    }
  }

  async function renderSchedule() {
    try {
      var data = await fetchJson('/api/schedule');
      document.getElementById('schedule').innerHTML = renderTable(data.rows || data.tasks || data, [
        { key: 'id', label: 'id', render: function(r){ return esc(String(r.id || '').slice(0, 10)); } },
        { key: 'cron', label: 'cron' },
        { key: 'description', label: 'description', render: function(r){ return esc(String(r.description || r.command || '').slice(0, 60)); } },
      ]);
    } catch (err) {
      document.getElementById('schedule').innerHTML = '<div class="empty">error: '+esc(err.message || String(err))+'</div>';
    }
  }

  function refreshMarketingPanels() {
    renderClients();
    renderLeads();
    renderScrapeJobs();
    renderOutreach();
    renderCalendar();
    renderReport();
  }

  window.__mktg = {
    selectClient: selectClient,
    approveOutreach: approveOutreach,
    rejectOutreach: rejectOutreach,
    markSent: markSent,
  };

  async function tick() {
    try {
      var results = await Promise.all([
        fetchJson('/api/status'),
        fetchJson('/api/missions?active=1'),
        fetchJson('/api/usage'),
        fetchJson('/api/hive?limit=25'),
        fetchJson('/api/audit?limit=25'),
      ]);
      var status = results[0], missions = results[1], usage = results[2], hive = results[3], audit = results[4];

      document.getElementById('agents').innerHTML = renderTable(status.agents, [
        { key: 'id', label: 'id' },
        { key: 'title', label: 'title' },
        { key: 'model', label: 'model' },
        { key: 'tools', label: 'tools', render: function(r){ return esc((r.tools||[]).join(',')); } },
      ]);

      document.getElementById('sessions').innerHTML = renderTable(status.sessions, [
        { key: 'chat_id', label: 'chat' },
        { key: 'agent_id', label: 'agent' },
        { key: 'locked', label: 'state', render: function(r){ return '<span class="pill '+(r.locked?'err':'ok')+'">'+(r.locked?'locked':'unlocked')+'</span>'; } },
        { key: 'last_activity', label: 'last', render: function(r){ return esc(fmtTime(r.last_activity)); } },
      ]);

      document.getElementById('missions').innerHTML = renderTable(missions.rows, [
        { key: 'id', label: 'id', render: function(r){ return esc(String(r.id).slice(0,8)); } },
        { key: 'title', label: 'title' },
        { key: 'status', label: 'status' },
        { key: 'agent_id', label: 'agent', render: function(r){ return esc(r.agent_id || 'main'); } },
      ]);

      document.getElementById('usage').innerHTML =
        '<div>input: <b>'+esc(usage.total.input_tokens.toLocaleString())+'</b> · output: <b>'+esc(usage.total.output_tokens.toLocaleString())+'</b></div>'+
        '<div>cost: <b>$'+Number(usage.total.cost_usd).toFixed(4)+'</b> · today: <b>$'+Number(usage.daily).toFixed(4)+'</b></div>';

      document.getElementById('hive').innerHTML = renderTable(hive.rows, [
        { key: 'agent_id', label: 'agent' },
        { key: 'action', label: 'action' },
        { key: 'summary', label: 'summary', render: function(r){ return esc(String(r.summary||'').slice(0,80)); } },
        { key: 'timestamp', label: 'when', render: function(r){ return esc(fmtTime(r.timestamp)); } },
      ]);

      document.getElementById('audit').innerHTML = renderTable(audit.rows, [
        { key: 'chat_id', label: 'chat' },
        { key: 'agent_id', label: 'agent' },
        { key: 'action', label: 'action' },
        { key: 'detail', label: 'detail', render: function(r){ return esc(String(r.detail||'').slice(0,60)); } },
      ]);

      renderClients();
      renderSchedule();

      document.getElementById('stamp').textContent = fmtTime(Date.now());
    } catch (err) {
      document.getElementById('stamp').textContent = 'error: ' + (err.message || err);
    }
  }

  document.getElementById('newc-btn').addEventListener('click', createClient);
  document.getElementById('setc-btn').addEventListener('click', saveSettings);
  document.getElementById('scrape-btn').addEventListener('click', submitScrape);
  document.getElementById('draft-btn').addEventListener('click', draftOutreach);
  document.getElementById('cal-btn').addEventListener('click', generateCalendar);
  document.getElementById('report-btn').addEventListener('click', generateReport);

  tick();
  setInterval(tick, 10000);
})();
</script>
</body>
</html>`;

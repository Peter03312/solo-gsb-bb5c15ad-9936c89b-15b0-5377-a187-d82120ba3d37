'use strict';

const $ = (sel) => document.querySelector(sel);
let state = { version: null, artworks: [], slots: [] };
let draft = [];          // 未开始时段草稿
let draftSeq = 0;        // 草稿行本地序号
let editingArtworkId = null;
let finishingSlotId = null;

// ---------- 工具 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function minutes(s, e) {
  if (!s || !e) return null;
  const ms = new Date(s).getTime(), me = new Date(e).getTime();
  if (Number.isNaN(ms) || Number.isNaN(me)) return null;
  return Math.round((me - ms) / 60000);
}
function statusBadge(s) {
  if (s.status === 'running') return '<span class="badge badge-running">进行中·冻结</span>';
  if (s.status === 'finished') return '<span class="badge badge-finished">已结束</span>';
  if (s.blocked) return '<span class="badge badge-blocked">不可启动</span>';
  return '<span class="badge badge-scheduled">未开始</span>';
}
let toastTimer = null;
function toast(kind, text) {
  const el = $('#toast');
  el.className = `toast ${kind}`;
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 8000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `请求失败 (${res.status})`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

// ---------- 数据加载 ----------
async function loadState(resetDraft = true) {
  state = await api('/api/state');
  $('#versionTag').textContent = `v${state.version}`;
  if (resetDraft) draft = state.slots.filter((s) => s.status === 'scheduled').map(serverRowToDraft);
  renderAll();
}
function serverRowToDraft(s) {
  return {
    cid: `s${s.id}`,
    savedId: s.id,
    hall: s.hall,
    start: s.plannedStart,
    end: s.plannedEnd,
    lux: s.plannedLux,
    artworkIds: s.artworks.map((a) => a.id),
    blocked: s.blocked,
    blockedReason: s.blockedReason,
  };
}
function newDraftRow() {
  return { cid: `d${++draftSeq}`, hall: '', start: '', end: '', lux: 50, artworkIds: [] };
}

// ---------- 渲染：作品 ----------
function renderArtworks() {
  const tb = $('#artworkTable tbody');
  if (!state.artworks.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="9">还没有作品，点击「录入作品」开始</td></tr>';
    return;
  }
  tb.innerHTML = state.artworks.map((a) => `
    <tr>
      <td class="art-name">${esc(a.name)}</td>
      <td class="num">${fmt(a.limit)}</td>
      <td class="num">${fmt(a.existing)}</td>
      <td class="num">${fmt(a.used)}</td>
      <td class="num">${fmt(a.reserved)}<span class="reserved-detail">${fmt(a.reservedRunning)} / ${fmt(a.reservedScheduled)}</span></td>
      <td class="num">${fmt(a.committed)}</td>
      <td class="num ${a.over ? 'neg' : 'pos'}">${a.over ? '−' + fmt(Math.abs(a.balance)) : fmt(a.balance)}</td>
      <td class="note-text">${esc(a.note)}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-sm" data-act="edit-art" data-id="${a.id}">编辑</button>
          <button class="btn btn-sm btn-danger" data-act="del-art" data-id="${a.id}">删除</button>
        </div>
      </td>
    </tr>
  `).join('');
}

// ---------- 渲染：冻结时段（进行中/已结束） ----------
function segmentRowsHtml(segments) {
  if (!segments || !segments.length) return '<div class="seg-empty">无分段数据</div>';
  return `
    <table class="seg-table">
      <thead><tr><th class="num">#</th><th>开始</th><th>结束</th><th class="num">分钟</th><th class="num">照度(lux)</th><th class="num">曝光(lux·min)</th></tr></thead>
      <tbody>
        ${segments.map((g) => `
          <tr>
            <td class="num">${g.index}</td>
            <td class="mono">${esc(g.start)}</td>
            <td class="mono">${esc(g.end)}</td>
            <td class="num">${fmt(g.minutes)}</td>
            <td class="num">${fmt(g.lux)}</td>
            <td class="num">${fmt(g.exposure)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function correctionsHtml(corrections) {
  if (!corrections || !corrections.length) return '';
  const list = corrections.slice().reverse(); // 最新更正在前
  return `
    <div class="corr-list">
      <div class="corr-title">更正记录（${corrections.length}）</div>
      ${list.map((c) => `
        <div class="corr-item">
          <div class="corr-head">
            <span class="corr-reason">理由：${esc(c.reason)}</span>
            <span class="corr-meta">${esc(c.createdAt)} · 更正后版本 v${c.version}</span>
          </div>
          <div class="corr-flow">
            <span class="mono">${esc(c.before.start)} ～ ${esc(c.before.end)}</span>
            ${c.before.lux === null ? `多段（${c.before.segments.length} 段）` : `单一照度 ${fmt(c.before.lux)} lux`}
            → 曝光 <strong>${fmt(c.before.exposure)}</strong>
            <span class="corr-arrow">⇒</span>
            <span class="mono">${esc(c.after.start)} ～ ${esc(c.after.end)}</span>
            ${c.after.lux === null ? `多段（${c.after.segments.length} 段）` : `单一照度 ${fmt(c.after.lux)} lux`}
            → 曝光 <strong>${fmt(c.after.exposure)}</strong>
          </div>
          <details><summary>查看更正后分段</summary>${segmentRowsHtml(c.after.segments)}</details>
        </div>`).join('')}
    </div>`;
}

function renderFrozen() {
  const tb = $('#frozenTable tbody');
  const rows = state.slots
    .filter((s) => s.status === 'running' || s.status === 'finished')
    .sort((a, b) => a.seq - b.seq);
  if (!rows.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="11">暂无进行中或已结束时段</td></tr>';
    return;
  }
  tb.innerHTML = rows.map((s) => {
    const luxText = s.actualLux === null
      ? (s.actualSegments && s.actualSegments.length > 1 ? `多段（${s.actualSegments.length}）` : '—')
      : fmt(s.actualLux);
    const hasDetail = s.status === 'finished';
    return `
    <tr>
      <td>${s.seq}</td>
      <td>${esc(s.hall)}</td>
      <td>${statusBadge(s)}</td>
      <td class="mono" style="font-family:var(--mono);font-size:12.5px;white-space:nowrap">
        ${esc(s.plannedStart)}<br>～ ${esc(s.plannedEnd)}
      </td>
      <td class="num">${fmt(s.plannedLux)}</td>
      <td class="num">${fmt(s.plannedExposure)}</td>
      <td class="mono" style="font-family:var(--mono);font-size:12.5px;white-space:nowrap">
        ${s.actualStart ? `${esc(s.actualStart)}<br>～ ${esc(s.actualEnd)}` : '—（冻结中）'}
      </td>
      <td class="num">${luxText}</td>
      <td class="num">${s.actualExposure === null ? '—' : fmt(s.actualExposure)}</td>
      <td><div class="art-chips">${s.artworks.map((a) => `<span class="chip">${esc(a.name)}</span>`).join('')}</div></td>
      <td>
        <div class="row-actions">
          ${s.status === 'running'
            ? `<button class="btn btn-sm btn-primary" data-act="finish" data-id="${s.id}">结束补记</button>`
            : `<button class="btn btn-sm" data-act="toggle-detail" data-id="${s.id}">▸ 分段/更正</button>
               <button class="btn btn-sm" data-act="correct" data-id="${s.id}">分段更正</button>`}
        </div>
      </td>
    </tr>
    ${hasDetail ? `
    <tr class="detail-row hidden" data-detail="${s.id}">
      <td colspan="11">
        <div class="seg-detail">
          <div class="seg-block">
            <div class="corr-title">实际照度分段（合计 ${fmt(s.actualExposure)} lux·min）</div>
            ${segmentRowsHtml(s.actualSegments)}
          </div>
          ${correctionsHtml(s.corrections)}
        </div>
      </td>
    </tr>` : ''}
  `;
  }).join('');
}

// 展开 / 收起分段详情
function setDetailOpen(id, open) {
  const detail = document.querySelector(`tr[data-detail="${id}"]`);
  const btn = document.querySelector(`button[data-act="toggle-detail"][data-id="${id}"]`);
  if (!detail) return;
  detail.classList.toggle('hidden', !open);
  if (btn) btn.textContent = open ? '▾ 收起' : '▸ 分段/更正';
}
$('#frozenTable').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act="toggle-detail"]');
  if (!btn) return;
  const id = btn.dataset.id;
  const detail = document.querySelector(`tr[data-detail="${id}"]`);
  if (!detail) return;
  setDetailOpen(id, detail.classList.contains('hidden'));
});

// ---------- 渲染：未开始草稿 ----------
function renderDraft() {
  const tb = $('#scheduleTable tbody');
  if (!draft.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="8">没有未开始时段，点击「新增时段」，或从下方整批保存</td></tr>';
    return;
  }
  const artOptions = (selected) => state.artworks
    .map((a) => `<option value="${a.id}" ${selected.includes(a.id) ? 'selected' : ''}>${esc(a.name)}</option>`)
    .join('');

  tb.innerHTML = draft.map((r) => {
    const mins = minutes(r.start, r.end);
    const expo = mins !== null && mins >= 0 && Number(r.lux) >= 0 ? Math.round(mins * Number(r.lux)) : null;
    const gaps = (r.blockedReason && r.blockedReason.gaps) || [];
    const gapHtml = gaps.length ? `
      <tr class="blocked-tag-row">
        <td colspan="8" class="blocked-cell">
          <strong>⛔ 预算不足，禁止启动。</strong> 调整排期后重新核算。
          <ul class="gap-list">
            ${gaps.map((g) => `<li>作品「${esc(g.artworkName)}」：当前可用余额 ${fmt(g.has)}，本时段需要 ${fmt(g.need)}，缺口 <strong>${fmt(g.gap)}</strong> lux·min</li>`).join('')}
          </ul>
        </td>
      </tr>` : '';
    return `
      <tr data-cid="${esc(r.cid)}">
        <td><input type="text" value="${esc(r.hall)}" data-f="hall" placeholder="如：一号厅" style="width:110px" /></td>
        <td><input type="datetime-local" class="mono" value="${esc(r.start)}" data-f="start" /></td>
        <td><input type="datetime-local" class="mono" value="${esc(r.end)}" data-f="end" /></td>
        <td><input type="number" min="0" step="1" value="${esc(r.lux)}" data-f="lux" /></td>
        <td class="num">${mins === null ? '–' : mins < 0 ? '✗' : mins}</td>
        <td class="cell-expo ${r.blocked ? 'neg' : ''}">${expo === null || expo < 0 ? '–' : fmt(expo)}</td>
        <td><select multiple size="3" data-f="artworkIds">${artOptions(r.artworkIds)}</select></td>
        <td>
          <div class="row-actions">
            ${r.savedId ? `<button class="btn btn-sm btn-primary" data-act="start" data-id="${r.savedId}">▶ 启动</button>` : ''}
            <button class="btn btn-sm btn-danger" data-act="del-draft">删除</button>
          </div>
        </td>
      </tr>
      ${gapHtml}
    `;
  }).join('');
}

function renderAll() {
  renderArtworks();
  renderFrozen();
  renderDraft();
}

// ---------- 草稿交互 ----------
function syncRowFromDom(tr) {
  const cid = tr.dataset.cid;
  const row = draft.find((r) => r.cid === cid);
  if (!row) return;
  tr.querySelectorAll('[data-f]').forEach((el) => {
    const f = el.dataset.f;
    if (f === 'artworkIds') {
      row.artworkIds = Array.from(el.selectedOptions).map((o) => Number(o.value));
    } else if (f === 'lux') {
      row.lux = el.value;
    } else {
      row[f] = el.value;
    }
  });
  // 草稿一旦被改动，清除服务端的核算标记，保存后以服务端结果为准
  row.blocked = false;
  row.blockedReason = null;
  row.savedId = undefined;
}

$('#addSlotBtn').addEventListener('click', () => {
  if (!state.artworks.length) return toast('warn', '请先录入至少一件作品');
  draft.push(newDraftRow());
  renderDraft();
});
$('#resetDraftBtn').addEventListener('click', () => {
  draft = state.slots.filter((s) => s.status === 'scheduled').map(serverRowToDraft);
  renderDraft();
});

$('#scheduleTable').addEventListener('change', (e) => {
  const tr = e.target.closest('tr[data-cid]');
  if (tr) { syncRowFromDom(tr); renderDraft(); }
});
$('#scheduleTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const tr = e.target.closest('tr[data-cid]');
  if (btn.dataset.act === 'del-draft' && tr) {
    syncRowFromDom(tr);
    draft = draft.filter((r) => r.cid !== tr.dataset.cid);
    renderDraft();
  }
  if (btn.dataset.act === 'start') {
    syncRowFromDom(tr);
    await startSlot(Number(btn.dataset.id));
  }
});

// ---------- 整批保存 ----------
function formatBatchError(payload) {
  const lines = [];
  (payload.errors || []).forEach((x) => lines.push(`• ${x.message}`));
  (payload.conflicts || []).forEach((c) => {
    lines.push(`• 作品「${c.artworkName}」时段重叠：\n    ${c.slotA.label}\n    ${c.slotB.label}`);
  });
  (payload.budgetExceeded || []).forEach((b) => {
    lines.push(`• 作品「${b.artworkName}」预算超限：已用 ${fmt(b.used)} + 预占 = ${fmt(b.projected)}，上限 ${fmt(b.limit)}，超出 ${fmt(b.overflow)} lux·min`);
  });
  return lines.join('\n') || '整批校验失败';
}

$('#saveScheduleBtn').addEventListener('click', async () => {
  // 先把 DOM 中未触发 change 的输入同步进来
  document.querySelectorAll('#scheduleTable tbody tr[data-cid]').forEach(syncRowFromDom);
  try {
    const body = {
      version: state.version,
      slots: draft.map((r) => ({
        cid: r.cid, hall: r.hall, start: r.start, end: r.end,
        lux: r.lux === '' ? null : Number(r.lux),
        artworkIds: r.artworkIds,
      })),
    };
    const next = await api('/api/schedule', { method: 'POST', body });
    applyNewState(next);
    const blocked = next.slots.filter((s) => s.blocked);
    if (blocked.length) {
      const detail = blocked.map((s) => {
        const gaps = (s.blockedReason.gaps || []).map((g) =>
          `「${g.artworkName}」缺口 ${fmt(g.gap)}（可用 ${fmt(g.has)} / 需 ${fmt(g.need)}）`).join('；');
        return `#${s.seq} ${s.hall} ${s.plannedStart}~${s.plannedEnd}：${gaps}`;
      }).join('\n');
      toast('warn', `整批已保存并重新核算，以下时段按开始顺序不可启动：\n${detail}`);
    } else {
      toast('success', '整批校验通过，排期已保存');
    }
  } catch (err) {
    await handleMutationError(err);
  }
});

async function startSlot(id) {
  try {
    const next = await api(`/api/slots/${id}/start`, { method: 'POST' });
    applyNewState(next);
    toast('success', '时段已启动：原排期冻结，预占保留');
  } catch (err) {
    if (err.status === 422 && err.payload && err.payload.blockedReason) {
      const gaps = (err.payload.blockedReason.gaps || []).map((g) =>
        `「${g.artworkName}」缺口 ${fmt(g.gap)}（可用 ${fmt(g.has)} / 需 ${fmt(g.need)}）`).join('\n');
      toast('error', `禁止启动：预算不足\n${gaps}\n请调整排期后重新核算`);
    } else {
      toast('error', err.message);
    }
  }
}

// ---------- 结束补记（单照度 / 多段照度） ----------
let finishMode = 'single';
let fnSegRows = [];

// 分段行：每段 开始/结束/照度
function segRowHtml(row) {
  return `
    <div class="seg-row">
      <span class="seg-idx">第 <span class="seg-idx-n">${row.idx}</span> 段</span>
      <input type="datetime-local" class="mono" data-k="start" value="${esc(row.start || '')}" title="段开始" />
      <span class="seg-tilde">～</span>
      <input type="datetime-local" class="mono" data-k="end" value="${esc(row.end || '')}" title="段结束" />
      <input type="number" min="0" step="1" data-k="lux" value="${esc(row.lux ?? '')}" placeholder="lux" title="段照度（非负）" />
      <span class="seg-expo"></span>
      <button type="button" class="btn btn-sm btn-danger" data-k="del">删</button>
    </div>`;
}

function rowIndex(container, div) {
  return Array.from(container.querySelectorAll('.seg-row')).indexOf(div);
}
function syncSegRow(container, rows, div) {
  const i = rowIndex(container, div);
  const row = rows[i];
  if (!row) return;
  div.querySelectorAll('[data-k]').forEach((el) => {
    if (el.dataset.k === 'del') return;
    if (el.dataset.k === 'lux') row.lux = el.value === '' ? null : Number(el.value);
    else row[el.dataset.k] = el.value;
  });
}
function paintSegExpo(container, rows) {
  let total = 0, ok = rows.length > 0;
  container.querySelectorAll('.seg-row').forEach((div, i) => {
    const r = rows[i];
    const m = r ? minutes(r.start, r.end) : null;
    const node = div.querySelector('.seg-expo');
    if (r && m !== null && m > 0 && Number.isFinite(r.lux) && r.lux >= 0) {
      const v = Math.round(m * r.lux);
      total += v;
      if (node) node.textContent = `${m}分×${r.lux}=${fmt(v)}`;
    } else {
      ok = false;
      if (node) node.textContent = '';
    }
  });
  return { total, ok };
}

function renderFnSegments() {
  const el = $('#fn_segments');
  el.innerHTML = fnSegRows.map((r, i) => segRowHtml({ ...r, idx: i + 1 })).join('');
  updateFinishPreview();
}
$('#fn_segments').addEventListener('change', (e) => {
  const div = e.target.closest('.seg-row');
  if (div) { syncSegRow($('#fn_segments'), fnSegRows, div); updateFinishPreview(); }
});
$('#fn_segments').addEventListener('click', (e) => {
  if (!e.target.closest('[data-k="del"]')) return;
  const div = e.target.closest('.seg-row');
  const i = rowIndex($('#fn_segments'), div);
  if (i >= 0) fnSegRows.splice(i, 1);
  renderFnSegments();
});
$('#fn_addSeg').addEventListener('click', () => {
  const prev = fnSegRows[fnSegRows.length - 1];
  fnSegRows.push({
    start: prev ? prev.end : $('#fn_actualStart').value,
    end: prev ? '' : $('#fn_actualEnd').value,
    lux: 0,
  });
  if (fnSegRows.length === 1) fnSegRows[0].end = $('#fn_actualEnd').value;
  renderFnSegments();
});
$('#fn_actualStart').addEventListener('change', () => {
  if (fnSegRows.length) { fnSegRows[0].start = $('#fn_actualStart').value; renderFnSegments(); }
});
$('#fn_actualEnd').addEventListener('change', () => {
  if (fnSegRows.length) { fnSegRows[fnSegRows.length - 1].end = $('#fn_actualEnd').value; renderFnSegments(); }
});

document.querySelectorAll('input[name="fn_mode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    finishMode = document.querySelector('input[name="fn_mode"]:checked').value;
    $('#fn_single').classList.toggle('hidden', finishMode !== 'single');
    $('#fn_multi').classList.toggle('hidden', finishMode !== 'multi');
    // 首次切到多段模式：用实际起止预填一整段，照度沿用单一照度输入框
    if (finishMode === 'multi' && fnSegRows.length === 0) {
      fnSegRows.push({
        start: $('#fn_actualStart').value,
        end: $('#fn_actualEnd').value,
        lux: Number($('#fn_lux').value) || 0,
      });
      renderFnSegments();
    }
    updateFinishPreview();
  });
});

$('#frozenTable').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act="finish"]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const slot = state.slots.find((s) => s.id === id);
  finishingSlotId = id;
  finishMode = 'single';
  document.querySelector('input[name="fn_mode"][value="single"]').checked = true;
  $('#fn_single').classList.remove('hidden');
  $('#fn_multi').classList.add('hidden');
  $('#fn_start').value = slot.plannedStart;
  $('#fn_end').value = slot.plannedEnd;
  $('#fn_lux').value = slot.plannedLux;
  $('#fn_actualStart').value = slot.plannedStart;
  $('#fn_actualEnd').value = slot.plannedEnd;
  fnSegRows = [];
  renderFnSegments(); // 初始空，点保存时单段自动生成
  $('#fn_error').classList.add('hidden');
  updateFinishPreview();
  $('#finishModal').classList.remove('hidden');
});
function updateFinishPreview() {
  if (finishMode === 'single') {
    const mins = minutes($('#fn_start').value, $('#fn_end').value);
    const lux = Number($('#fn_lux').value);
    const el = $('#fn_preview');
    if (mins !== null && mins > 0 && lux >= 0) el.textContent = fmt(Math.round(mins * lux));
    else el.textContent = '–';
    return;
  }
  // 多段：按 Σ 分钟×照度
  const ranges = $('#fn_actualStart').value && $('#fn_actualEnd').value
    ? minutes($('#fn_actualStart').value, $('#fn_actualEnd').value) : null;
  const { total, ok } = paintSegExpo($('#fn_segments'), fnSegRows);
  if (ranges !== null && ranges <= 0) $('#fn_multiPreview').textContent = '–';
  else $('#fn_multiPreview').textContent = ok && ranges > 0 ? fmt(total) : '–';
}
['fn_start', 'fn_end', 'fn_lux'].forEach((id) => $('#' + id).addEventListener('input', updateFinishPreview));

function finishErrorsToText(payload) {
  const lines = [];
  if (payload && payload.error && payload.error.message) lines.push(payload.error.message);
  (payload && payload.errors || []).forEach((x) => {
    if (x.message) lines.push(`• ${x.message}`);
  });
  return lines.join('\n');
}

$('#fn_save').addEventListener('click', async () => {
  try {
    let next, path, body;
    if (finishMode === 'single') {
      path = `/api/slots/${finishingSlotId}/finish`;
      body = {
        actualStart: $('#fn_start').value,
        actualEnd: $('#fn_end').value,
        actualLux: Number($('#fn_lux').value),
      };
    } else {
      path = `/api/slots/${finishingSlotId}/settle`;
      document.querySelectorAll('#fn_segments .seg-row').forEach((div) => syncSegRow($('#fn_segments'), fnSegRows, div));
      const segs = fnSegRows.map((r) => ({
        start: r.start, end: r.end, lux: r.lux === null || r.lux === undefined ? null : Number(r.lux),
      }));
      body = {
        version: state.version,
        actualStart: $('#fn_actualStart').value,
        actualEnd: $('#fn_actualEnd').value,
        segments: segs,
      };
    }
    next = await api(path, { method: 'POST', body });
    $('#finishModal').classList.add('hidden');
    applyNewState(next);
    if (next.blockedAfterFinish && next.blockedAfterFinish.length) {
      const detail = next.blockedAfterFinish.map((s) => {
        const gaps = (s.blockedReason.gaps || []).map((g) =>
          `「${g.artworkName}」缺口 ${fmt(g.gap)}（可用 ${fmt(g.has)} / 需 ${fmt(g.need)}）`).join('；');
        return `#${s.seq} ${s.hall} ${s.plannedStart}~${s.plannedEnd}：${gaps}`;
      }).join('\n');
      toast('warn', `已结算，实际曝光 ${fmt(next.justFinishedExposure)} lux·min 已替换预占。\n超量导致以下后续时段预算不足、不可开始：\n${detail}\n请调整排期后重新核算`);
    } else {
      toast('success', `已结束并补记，实际曝光 ${fmt(next.justFinishedExposure)} lux·min 已替换预占`);
    }
  } catch (err) {
    if (err.status === 409 && err.payload && err.payload.state) {
      $('#finishModal').classList.add('hidden');
      applyNewState(err.payload.state);
      toast('error', `${err.message}\n页面已刷新为最新预算，请重新结算`);
      return;
    }
    $('#fn_error').textContent = finishMode === 'multi' ? finishErrorsToText(err.payload || { error: { message: err.message } }) : err.message;
    $('#fn_error').classList.remove('hidden');
  }
});

// ---------- 已结束时段分段更正 ----------
let correctingSlotId = null;
let crSegRows = [];
let crBeforeExposure = 0;

function renderCrSegments() {
  const el = $('#cr_segments');
  el.innerHTML = crSegRows.map((r, i) => segRowHtml({ ...r, idx: i + 1 })).join('');
  updateCorrectPreview();
}
$('#cr_segments').addEventListener('change', (e) => {
  const div = e.target.closest('.seg-row');
  if (div) { syncSegRow($('#cr_segments'), crSegRows, div); updateCorrectPreview(); }
});
$('#cr_segments').addEventListener('click', (e) => {
  if (!e.target.closest('[data-k="del"]')) return;
  const div = e.target.closest('.seg-row');
  const i = rowIndex($('#cr_segments'), div);
  if (i >= 0) crSegRows.splice(i, 1);
  renderCrSegments();
});
$('#cr_addSeg').addEventListener('click', () => {
  const slot = state.slots.find((s) => s.id === correctingSlotId);
  const prev = crSegRows[crSegRows.length - 1];
  crSegRows.push({
    start: prev ? prev.end : (slot ? slot.actualStart : ''),
    end: slot && !prev ? slot.actualEnd : '',
    lux: 0,
  });
  renderCrSegments();
});

$('#frozenTable').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act="correct"]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const slot = state.slots.find((s) => s.id === id);
  if (!slot) return;
  correctingSlotId = id;
  $('#cr_slot').textContent = `#${slot.seq} ${slot.hall} · ${slot.artworks.map((a) => a.name).join('、')}`;
  $('#cr_range').textContent = `${slot.actualStart} ～ ${slot.actualEnd}（${slot.actualMinutes} 分钟）`;
  $('#cr_reason').value = '';
  $('#cr_error').classList.add('hidden');
  crBeforeExposure = slot.actualExposure || 0;
  crSegRows = (slot.actualSegments && slot.actualSegments.length
    ? slot.actualSegments
    : [{ index: 1, start: slot.actualStart, end: slot.actualEnd, lux: slot.actualLux }]
  ).map((g) => ({ start: g.start, end: g.end, lux: g.lux }));
  renderCrSegments();
  $('#correctModal').classList.remove('hidden');
});

function updateCorrectPreview() {
  const { total, ok } = paintSegExpo($('#cr_segments'), crSegRows);
  $('#cr_preview').textContent = ok ? fmt(total) : '–';
  const diff = total - crBeforeExposure;
  const diffEl = $('#cr_diff');
  if (ok) {
    diffEl.textContent = diff === 0 ? '总量不变　' : (diff > 0 ? `较原总量 +${fmt(diff)}　` : `较原总量 ${fmt(diff)}　`);
    diffEl.style.color = diff > 0 ? 'var(--danger)' : (diff < 0 ? 'var(--ok)' : 'var(--muted)');
  } else {
    diffEl.textContent = '';
  }
}

$('#cr_save').addEventListener('click', async () => {
  document.querySelectorAll('#cr_segments .seg-row').forEach((div) => syncSegRow($('#cr_segments'), crSegRows, div));
  const reason = $('#cr_reason').value.trim();
  if (!reason) {
    $('#cr_error').textContent = '请填写更正理由';
    $('#cr_error').classList.remove('hidden');
    return;
  }
  try {
    const next = await api(`/api/slots/${correctingSlotId}/correct`, {
      method: 'POST',
      body: {
        version: state.version,
        reason,
        segments: crSegRows.map((r) => ({ start: r.start, end: r.end, lux: r.lux === null ? null : Number(r.lux) })),
      },
    });
    $('#correctModal').classList.add('hidden');
    applyNewState(next);
    setDetailOpen(correctingSlotId, true);
    const c = next.correction;
    toast('success',
      `分段更正成功：曝光 ${fmt(c.beforeExposure)} → ${fmt(c.afterExposure)} lux·min（新总量替换旧总量，不重复累计），作品已用量与后续不可启动核算已同步重算`);
  } catch (err) {
    if (err.status === 409 && err.payload && err.payload.state) {
      $('#correctModal').classList.add('hidden');
      applyNewState(err.payload.state);
      toast('error', `${err.message}\n页面已刷新为最新预算，请重新更正`);
      return;
    }
    $('#cr_error').textContent = finishErrorsToText(err.payload || { error: { message: err.message } });
    $('#cr_error').classList.remove('hidden');
  }
});

// ---------- 作品弹窗 ----------
function openArtworkModal(a) {
  editingArtworkId = a ? a.id : null;
  $('#artworkModalTitle').textContent = a ? '编辑作品' : '录入作品';
  $('#aw_name').value = a ? a.name : '';
  $('#aw_limit').value = a ? a.limit : '';
  $('#aw_existing').value = a ? a.existing : '';
  $('#aw_note').value = a ? a.note : '';
  $('#aw_error').classList.add('hidden');
  $('#artworkModal').classList.remove('hidden');
}
$('#addArtworkBtn').addEventListener('click', () => openArtworkModal(null));

$('#artworkTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.act === 'edit-art') {
    openArtworkModal(state.artworks.find((a) => a.id === id));
  }
  if (btn.dataset.act === 'del-art') {
    const a = state.artworks.find((x) => x.id === id);
    if (!confirm(`确定删除作品「${a.name}」吗？`)) return;
    try {
      const next = await api(`/api/artworks/${id}`, { method: 'DELETE', body: { version: state.version } });
      applyNewState(next);
      toast('success', '作品已删除');
    } catch (err) { await handleMutationError(err); }
  }
});

$('#aw_save').addEventListener('click', async () => {
  const payload = {
    version: state.version,
    name: $('#aw_name').value,
    limit: Number($('#aw_limit').value),
    existing: Number($('#aw_existing').value),
    note: $('#aw_note').value,
  };
  try {
    const next = editingArtworkId
      ? await api(`/api/artworks/${editingArtworkId}`, { method: 'PUT', body: payload })
      : await api('/api/artworks', { method: 'POST', body: payload });
    applyNewState(next);
    $('#artworkModal').classList.add('hidden');
    toast('success', editingArtworkId ? '作品已更新' : '作品已录入');
  } catch (err) {
    if (err.status === 409) { $('#artworkModal').classList.add('hidden'); }
    await handleMutationError(err);
  }
});

// ---------- 通用 ----------
function applyNewState(next) {
  state = next;
  $('#versionTag').textContent = `v${state.version}`;
  draft = state.slots.filter((s) => s.status === 'scheduled').map(serverRowToDraft);
  renderAll();
}
async function handleMutationError(err) {
  if (err.status === 409 && err.payload && err.payload.state) {
    applyNewState(err.payload.state);
    toast('error', `${err.message}\n本地草稿已被服务端最新预算替换，请重新调整后再提交`);
    return;
  }
  if (err.status === 422 && err.payload) toast('error', formatBatchError(err.payload));
  else toast('error', err.message);
}

document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => b.closest('.modal-mask').classList.add('hidden')));
document.querySelectorAll('.modal-mask').forEach((m) =>
  m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));

$('#refreshBtn').addEventListener('click', () => loadState(true).then(() => toast('success', '已刷新为最新预算')));

loadState().catch((err) => toast('error', `初始化加载失败：${err.message}`));

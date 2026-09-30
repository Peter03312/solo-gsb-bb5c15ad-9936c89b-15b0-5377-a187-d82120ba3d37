'use strict';

const $ = (sel) => document.querySelector(sel);
let state = { version: null, artworks: [], slots: [] };
let draft = [];          // 未开始时段草稿
let draftSeq = 0;        // 草稿行本地序号
let editingArtworkId = null;
let finishingSlotId = null;
let correctingSlotId = null;
let fnSegments = [];     // 结束弹窗分段编辑数据
let crSegments = [];     // 更正弹窗分段编辑数据
const expandedSlots = new Set(); // 展开分段/更正记录的已结束时段

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
function segPills(s) {
  if (!s.actualSegments || !s.actualSegments.length) return '';
  return s.actualSegments.map((g) => `
    <span class="seg-pill">${esc(String(g.start).slice(5))} ~ ${esc(String(g.end).slice(5))}
      · ${g.minutes} 分 · <b>${fmt(g.lux)}</b> lux · ${fmt(g.exposure)}</span>`).join('');
}
function correctionList(s) {
  if (!s.corrections || !s.corrections.length) return '';
  const items = s.corrections.map((c) => `
    <div class="corr-item">
      <div class="corr-head"><span>第 ${c.seqNo} 次更正</span><span>${esc(c.createdAt)}</span></div>
      <div class="corr-reason">理由：${esc(c.reason)}</div>
      <div class="corr-nums">
        曝光 ${fmt(c.before.exposure)} <span class="arrow">→</span> ${fmt(c.after.exposure)} lux·min
        ｜ 时间 ${c.before.minutes} <span class="arrow">→</span> ${c.after.minutes} 分
        ｜ 分段 ${c.before.segments.length} <span class="arrow">→</span> ${c.after.segments.length} 段
      </div>
      <div>${segPills({ actualSegments: c.after.segments })}</div>
    </div>`).join('');
  return `<div class="detail-block"><div class="detail-title">更正记录（${s.corrections.length}）</div>${items}</div>`;
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
    const multi = s.status === 'finished' && s.segmentCount > 1;
    const luxCell = s.actualLux === null
      ? (multi ? `多段<span class="multi-lux-hint">${s.segmentCount} 段照度</span>` : '—')
      : fmt(s.actualLux);
    const actions = s.status === 'running'
      ? `<button class="btn btn-sm btn-primary" data-act="finish" data-id="${s.id}">结束补记</button>`
      : `<div class="row-actions">
           <button class="btn btn-sm" data-act="toggle-detail" data-id="${s.id}">${expandedSlots.has(s.id) ? '收起明细' : '分段/更正'}</button>
           <button class="btn btn-sm" data-act="correct" data-id="${s.id}">分段更正</button>
         </div>`;
    const detailOpen = expandedSlots.has(s.id);
    const detailRow = detailOpen ? `
      <tr class="detail-row">
        <td colspan="11"><div class="detail-inner">
          <div class="detail-block">
            <div class="detail-title">实际照度分段（${s.segmentCount || 0}）</div>
            ${segPills(s) || '<span style="color:var(--muted);font-size:12px">无分段数据</span>'}
          </div>
          ${correctionList(s)}
        </div></td>
      </tr>` : '';
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
      <td class="num">${luxCell}</td>
      <td class="num">${s.actualExposure === null ? '—' : fmt(s.actualExposure)}</td>
      <td><div class="art-chips">${s.artworks.map((a) => `<span class="chip">${esc(a.name)}</span>`).join('')}</div></td>
      <td>${actions}</td>
    </tr>
    ${detailRow}`;
  }).join('');
}

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
  (payload.segmentErrors || []).forEach((x) => lines.push(`• ${x}`));
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

// ---------- 分段编辑器（结束 / 更正弹窗共用） ----------
function segRowHtml(list, prefix, g, i) {
  const mins = minutes(g.start, g.end);
  const valid = mins !== null && mins > 0;
  const expo = valid && g.lux !== '' && g.lux != null && Number(g.lux) >= 0 ? Math.round(mins * Number(g.lux)) : null;
  return `
    <div class="seg-row" data-idx="${i}">
      <span class="seg-idx">${i + 1}</span>
      <input type="datetime-local" class="mono" data-seg="start" value="${esc(g.start || '')}" />
      <span>~</span>
      <input type="datetime-local" class="mono" data-seg="end" value="${esc(g.end || '')}" />
      <input type="number" class="seg-lux" data-seg="lux" min="0" step="1" value="${esc(g.lux === '' || g.lux == null ? '' : g.lux)}" placeholder="lux" title="照度 lux" />
      <span class="seg-mins">${valid ? mins + ' 分' : ''}${expo !== null ? '<br>' + fmt(expo) : ''}</span>
      <button type="button" class="seg-del" data-seg="del" title="删除该段">✕</button>
    </div>`;
}
function segMinsLabel(g) {
  const mins = minutes(g.start, g.end);
  const valid = mins !== null && mins > 0;
  const expo = valid && g.lux !== '' && g.lux != null && Number(g.lux) >= 0 ? Math.round(mins * Number(g.lux)) : null;
  return `${valid ? mins + ' 分' : ''}${expo !== null ? '<br>' + fmt(expo) : ''}`;
}
function renderSegList(container, list, prefix) {
  container.innerHTML = list.map((g, i) => segRowHtml(list, prefix, g, i)).join('');
}
function syncSegFromDom(container, list) {
  container.querySelectorAll('.seg-row').forEach((row) => {
    const i = Number(row.dataset.idx);
    if (!list[i]) return;
    row.querySelectorAll('[data-seg]').forEach((el) => {
      const f = el.dataset.seg;
      if (f === 'del') return;
      if (f === 'lux') list[i].lux = el.value === '' ? '' : Number(el.value);
      else list[i][f] = el.value;
    });
  });
}
// 仅就地刷新每行“时长/曝光”标签，不重建 DOM，避免输入时丢失焦点
function refreshSegLabels(container, list) {
  container.querySelectorAll('.seg-row').forEach((row) => {
    const i = Number(row.dataset.idx);
    const label = row.querySelector('.seg-mins');
    if (label && list[i]) label.innerHTML = segMinsLabel(list[i]);
  });
}
function segTotals(list) {
  let total = 0, valid = list.length > 0;
  for (const g of list) {
    const mins = minutes(g.start, g.end);
    if (mins === null || mins <= 0 || g.lux === '' || g.lux == null || !(Number(g.lux) >= 0)) { valid = false; continue; }
    total += mins * Number(g.lux);
  }
  return { valid, totalMins: (() => {
    let m = 0;
    for (const g of list) { const x = minutes(g.start, g.end); if (x !== null && x > 0) m += x; }
    return m;
  })(), exposure: Math.round(total) };
}
function bindSegEditor(containerId, addBtnId, listRef, onChange) {
  const container = $('#' + containerId);
  $('#' + addBtnId).addEventListener('click', () => {
    syncSegFromDom(container, listRef());
    const prev = listRef()[listRef().length - 1];
    listRef().push({ start: prev ? prev.end : '', end: '', lux: '' });
    renderSegList(container, listRef(), containerId);
    onChange();
  });
  container.addEventListener('click', (e) => {
    if (!e.target.closest('[data-seg="del"]')) return;
    const row = e.target.closest('.seg-row');
    syncSegFromDom(container, listRef());
    listRef().splice(Number(row.dataset.idx), 1);
    renderSegList(container, listRef(), containerId);
    onChange();
  });
  container.addEventListener('input', () => {
    syncSegFromDom(container, listRef());
    refreshSegLabels(container, listRef());
    onChange();
  });
  container.addEventListener('change', () => {
    syncSegFromDom(container, listRef());
    refreshSegLabels(container, listRef());
    onChange();
  });
}

// ---------- 结束补记弹窗（单一 / 多段） ----------
$('#frozenTable').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  const slot = state.slots.find((s) => s.id === id);

  if (act === 'toggle-detail') {
    if (expandedSlots.has(id)) expandedSlots.delete(id); else expandedSlots.add(id);
    renderFrozen();
    return;
  }
  if (act === 'finish') {
    finishingSlotId = id;
    $('#fn_start').value = slot.plannedStart;
    $('#fn_end').value = slot.plannedEnd;
    $('#fn_lux').value = slot.plannedLux;
    document.querySelector('input[name="fn_mode"][value="single"]').checked = true;
    fnSegments = [{ start: slot.plannedStart, end: slot.plannedEnd, lux: slot.plannedLux }];
    renderSegList($('#fn_segments'), fnSegments, 'fn');
    toggleFnMode();
    $('#fn_error').classList.add('hidden');
    $('#finishModal').classList.remove('hidden');
    return;
  }
  if (act === 'correct') {
    openCorrectModal(slot);
  }
});

function toggleFnMode() {
  const mode = document.querySelector('input[name="fn_mode"]:checked').value;
  const multi = mode === 'segments';
  $('#fn_singleBox').classList.toggle('hidden', multi);
  $('#fn_segBox').classList.toggle('hidden', !multi);
  updateFinishPreview();
}
document.querySelectorAll('input[name="fn_mode"]').forEach((r) => r.addEventListener('change', () => {
  syncFinishInputs();
  toggleFnMode();
}));

function syncFinishInputs() {
  if (!document.querySelector('input[name="fn_mode"][value="segments"]').checked) return;
  syncSegFromDom($('#fn_segments'), fnSegments);
}
function updateFinishPreview() {
  const mode = document.querySelector('input[name="fn_mode"]:checked').value;
  const rangeMins = minutes($('#fn_start').value, $('#fn_end').value);
  if (mode === 'single') {
    const lux = Number($('#fn_lux').value);
    if (rangeMins !== null && rangeMins > 0 && lux >= 0) {
      $('#fn_preview').textContent = fmt(Math.round(rangeMins * lux));
      $('#fn_totalMins').textContent = rangeMins;
    } else { $('#fn_preview').textContent = '–'; $('#fn_totalMins').textContent = '–'; }
  } else {
    refreshSegLabels($('#fn_segments'), fnSegments);
    const t = segTotals(fnSegments);
    $('#fn_preview').textContent = t.valid ? fmt(t.exposure) : '–';
    $('#fn_totalMins').textContent = t.valid ? t.totalMins : '–';
  }
}
['fn_start', 'fn_end', 'fn_lux'].forEach((id) => $('#' + id).addEventListener('input', updateFinishPreview));
bindSegEditor('fn_segments', 'fn_addSeg', () => fnSegments, updateFinishPreview);

$('#fn_save').addEventListener('click', async () => {
  const mode = document.querySelector('input[name="fn_mode"]:checked').value;
  const actualStart = $('#fn_start').value;
  const actualEnd = $('#fn_end').value;
  try {
    let next;
    if (mode === 'single') {
      next = await api(`/api/slots/${finishingSlotId}/finish`, {
        method: 'POST',
        body: { actualStart, actualEnd, actualLux: Number($('#fn_lux').value) },
      });
    } else {
      syncSegFromDom($('#fn_segments'), fnSegments);
      next = await api(`/api/slots/${finishingSlotId}/settle`, {
        method: 'POST',
        body: {
          version: state.version,
          actualStart, actualEnd,
          segments: fnSegments.map((g) => ({ start: g.start, end: g.end, lux: g.lux === '' ? null : Number(g.lux) })),
        },
      });
    }
    $('#finishModal').classList.add('hidden');
    applyNewState(next);
    const expo = next.justFinishedExposure;
    if (next.blockedAfterFinish && next.blockedAfterFinish.length) {
      const detail = next.blockedAfterFinish.map((s) => {
        const gaps = (s.blockedReason.gaps || []).map((g) =>
          `「${g.artworkName}」缺口 ${fmt(g.gap)}（可用 ${fmt(g.has)} / 需 ${fmt(g.need)}）`).join('；');
        return `#${s.seq} ${s.hall} ${s.plannedStart}~${s.plannedEnd}：${gaps}`;
      }).join('\n');
      toast('warn', `已结算，实际曝光 ${fmt(expo)} lux·min 已替换预占。\n超量导致以下后续时段预算不足、不可开始：\n${detail}\n请调整排期后重新核算`);
    } else {
      toast('success', `已结束并补记，实际曝光 ${fmt(expo)} lux·min 已替换预占`);
    }
  } catch (err) {
    if (err.status === 409) {
      $('#finishModal').classList.add('hidden');
      return handleMutationError(err);
    }
    $('#fn_error').textContent = err.payload && err.payload.segmentErrors
      ? err.payload.segmentErrors.map((x) => `• ${x}`).join('\n')
      : err.message;
    $('#fn_error').classList.remove('hidden');
  }
});

// ---------- 已结束时段分段更正弹窗 ----------
function openCorrectModal(slot) {
  correctingSlotId = slot.id;
  crSegments = (slot.actualSegments && slot.actualSegments.length
    ? slot.actualSegments
    : [{ start: slot.actualStart, end: slot.actualEnd, lux: slot.actualLux ?? '' }]
  ).map((g) => ({ start: g.start, end: g.end, lux: g.lux }));
  $('#cr_range').innerHTML = `原实际区间 <strong>${esc(slot.actualStart)}</strong> ～ <strong>${esc(slot.actualEnd)}</strong>`
    + `（共 ${slot.actualMinutes} 分）｜更正前曝光 <strong>${fmt(slot.actualExposure)}</strong> lux·min`;
  $('#cr_beforeExpo').textContent = fmt(slot.actualExposure);
  $('#cr_reason').value = '';
  $('#cr_error').classList.add('hidden');
  renderSegList($('#cr_segments'), crSegments, 'cr');
  updateCorrectPreview();
  $('#correctModal').classList.remove('hidden');
}
function updateCorrectPreview() {
  syncSegFromDom($('#cr_segments'), crSegments);
  const t = segTotals(crSegments);
  $('#cr_preview').textContent = t.valid ? fmt(t.exposure) : '–';
  $('#cr_totalMins').textContent = t.valid ? t.totalMins : '–';
}
bindSegEditor('cr_segments', 'cr_addSeg', () => crSegments, updateCorrectPreview);

$('#cr_save').addEventListener('click', async () => {
  syncSegFromDom($('#cr_segments'), crSegments);
  const reason = $('#cr_reason').value.trim();
  try {
    const next = await api(`/api/slots/${correctingSlotId}/correct`, {
      method: 'POST',
      body: {
        version: state.version,
        reason,
        segments: crSegments.map((g) => ({ start: g.start, end: g.end, lux: g.lux === '' ? null : Number(g.lux) })),
      },
    });
    $('#correctModal').classList.add('hidden');
    applyNewState(next);
    expandedSlots.add(correctingSlotId);
    renderFrozen();
    const c = next.correction;
    const dir = c.after.exposure - c.before.exposure;
    const head = `已提交第 ${c.seqNo} 次更正：曝光 ${fmt(c.before.exposure)} → ${fmt(c.after.exposure)} lux·min`
      + (dir === 0 ? '（总量不变）' : dir > 0 ? `（+${fmt(dir)}）` : `（−${fmt(Math.abs(dir))}）`);
    if (next.blockedAfterFinish && next.blockedAfterFinish.length) {
      const detail = next.blockedAfterFinish.map((s) => {
        const gaps = (s.blockedReason.gaps || []).map((g) =>
          `「${g.artworkName}」缺口 ${fmt(g.gap)}（可用 ${fmt(g.has)} / 需 ${fmt(g.need)}）`).join('；');
        return `#${s.seq} ${s.hall}：${gaps}`;
      }).join('\n');
      toast('warn', `${head}\n新总量已替换旧总量并重算，以下后续时段不可启动：\n${detail}`);
    } else {
      toast('success', `${head}，已用量与后续可启动状态已同步重算`);
    }
  } catch (err) {
    if (err.status === 409) {
      $('#correctModal').classList.add('hidden');
      return handleMutationError(err);
    }
    $('#cr_error').textContent = err.payload && err.payload.segmentErrors
      ? err.payload.segmentErrors.map((x) => `• ${x}`).join('\n')
      : err.message;
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

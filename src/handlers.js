'use strict';
const B = require('./budget');

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

// 检查并发版本（过期则 409 并返回最新预算）
function requireVersion(db, body) {
  const current = db.prepare('SELECT version FROM meta WHERE id = 1').get().version;
  const got = Number(body && body.version);
  if (!Number.isInteger(got) || got !== current) {
    throw new HttpError(409, 'VERSION_STALE', `版本已过期：当前版本 v${current}，请基于最新预算重新调整`, {
      stale: true,
      state: B.summarize(db),
    });
  }
  return current;
}

const parseId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) { reject(new HttpError(413, 'BODY_TOO_LARGE', '请求体过大')); req.destroy(); }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new HttpError(400, 'BAD_JSON', '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

// ---------- 作品 ----------
function validateArtwork(body, db, selfId = null) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new HttpError(422, 'VALIDATION', '作品名称不能为空', { field: 'name' });
  if (name.length > 100) throw new HttpError(422, 'VALIDATION', '作品名称过长（最多 100 字）', { field: 'name' });
  const dup = db.prepare('SELECT id FROM artworks WHERE name = ?').get(name);
  if (dup && dup.id !== selfId) throw new HttpError(422, 'VALIDATION', `作品名称「${name}」已存在`, { field: 'name' });

  const limit = Number(body.limit);
  const existing = Number(body.existing);
  if (!B.isNonNegNumber(limit)) throw new HttpError(422, 'VALIDATION', '曝光上限必须为非负数值', { field: 'limit' });
  if (!B.isNonNegNumber(existing)) throw new HttpError(422, 'VALIDATION', '既有累计量必须为非负数值', { field: 'existing' });
  if (existing > limit + 1e-9) {
    throw new HttpError(422, 'VALIDATION', '既有累计量不得超过展期曝光上限', { field: 'existing' });
  }
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
  return { name, limit, existing, note };
}

function createArtwork(db, body) {
  requireVersion(db, body);
  const d = validateArtwork(body, db);
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO artworks (name, limit_amount, existing_amount, note) VALUES (?, ?, ?, ?)')
      .run(d.name, d.limit, d.existing, d.note);
    B.recomputeBlocked(db);
    B.bumpVersion(db);
    return B.summarize(db);
  });
  return tx.immediate();
}

function updateArtwork(db, id, body) {
  requireVersion(db, body);
  const d = validateArtwork(body, db, id);
  const tx = db.transaction(() => {
    const r = db.prepare('UPDATE artworks SET name = ?, limit_amount = ?, existing_amount = ?, note = ? WHERE id = ?')
      .run(d.name, d.limit, d.existing, d.note, id);
    if (r.changes === 0) throw new HttpError(404, 'NOT_FOUND', `作品 #${id} 不存在`);
    B.recomputeBlocked(db);
    B.bumpVersion(db);
    return B.summarize(db);
  });
  return tx.immediate();
}

function deleteArtwork(db, id, body) {
  requireVersion(db, body);
  const tx = db.transaction(() => {
    const ref = db.prepare('SELECT COUNT(*) AS c FROM slot_artworks WHERE artwork_id = ?').get(id).c;
    if (ref > 0) throw new HttpError(409, 'IN_USE', `作品 #${id} 已被 ${ref} 个时段引用，不能删除；请先调整排期`);
    const r = db.prepare('DELETE FROM artworks WHERE id = ?').run(id);
    if (r.changes === 0) throw new HttpError(404, 'NOT_FOUND', `作品 #${id} 不存在`);
    B.bumpVersion(db);
    return B.summarize(db);
  });
  return tx.immediate();
}

// ---------- 排期整批调整 ----------
function describeSlot(s) {
  return {
    cid: s.cid, hall: s.hall, start: s.start, end: s.end, lux: s.lux,
    artworkIds: s.artworkIds,
    label: `${s.hall || '(未填展厅)'} ${s.start || '?'} ~ ${s.end || '?'}`,
  };
}

// 整批校验并替换全部“未开始”时段。进行中/已结束时段冻结，不允许改动。
function replaceSchedule(db, body) {
  requireVersion(db, body);
  if (!body || !Array.isArray(body.slots)) {
    throw new HttpError(422, 'VALIDATION', '请求需要 slots 数组（整批未开始时段）');
  }

  const artworks = B.loadArtworks(db);
  const artIds = new Set(artworks.map((a) => a.id));
  const artName = new Map(artworks.map((a) => [a.id, a.name]));

  const proposed = [];
  const errors = [];

  body.slots.forEach((raw, idx) => {
    const cid = raw && raw.cid != null ? String(raw.cid) : `#${idx + 1}`;
    const where = () => `第 ${idx + 1} 行 [${cid}]`;
    const hall = typeof raw.hall === 'string' ? raw.hall.trim() : '';
    if (!hall) errors.push({ cid, message: `${where()}：展厅不能为空` });

    const s = B.parseDateTime(raw.start, `${where()} 开始时间`);
    const e = B.parseDateTime(raw.end, `${where()} 结束时间`);
    if (s.error) errors.push({ cid, message: s.error });
    if (e.error) errors.push({ cid, message: e.error });
    if (!s.error && !e.error && e.minutes <= s.minutes) {
      errors.push({ cid, message: `${where()}：时序无效，结束时间必须晚于开始时间` });
    }

    const lux = Number(raw.lux);
    if (!B.isNonNegNumber(lux)) errors.push({ cid, message: `${where()}：照度必须为非负数值` });

    let ids = raw.artworkIds;
    if (!Array.isArray(ids) || ids.length === 0) {
      errors.push({ cid, message: `${where()}：至少选择一件展出作品` });
      ids = [];
    }
    const numIds = [];
    for (const x of ids || []) {
      const n = Number(x);
      if (!Number.isInteger(n) || !artIds.has(n)) {
        errors.push({ cid, message: `${where()}：作品 #${x} 不存在` });
      } else if (!numIds.includes(n)) numIds.push(n);
    }

    proposed.push({
      cid, hall,
      start: s.error ? null : raw.start,
      startMin: s.error ? null : s.minutes,
      end: e.error ? null : raw.end,
      endMin: e.error ? null : e.minutes,
      lux: B.isNonNegNumber(lux) ? lux : 0,
      artworkIds: numIds,
    });
  });

  if (errors.length) throw new HttpError(422, 'BATCH_REJECTED', '整批已拒绝：存在无效时段', { errors });

  // 1) 同作品时段重叠：新时段之间
  const overlapConflicts = [];
  const byArt = new Map();
  proposed.forEach((s) => s.artworkIds.forEach((aid) => {
    if (!byArt.has(aid)) byArt.set(aid, []);
    byArt.get(aid).push(s);
  }));
  const pairKey = new Set();
  const addOverlap = (aid, a, b, kind) => {
    const k1 = `${aid}|${a.cid}|${b.cid}`;
    if (pairKey.has(k1)) return;
    pairKey.add(k1);
    overlapConflicts.push({
      artworkId: aid, artworkName: artName.get(aid), kind,
      slotA: describeSlot(a), slotB: describeSlot(b),
    });
  };
  for (const [aid, list] of byArt) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.startMin < b.endMin && b.startMin < a.endMin) addOverlap(aid, a, b, 'new-new');
      }
    }
  }

  // 新时段与冻结时段（进行中，按冻结的原计划区间；已结束按实际区间）之间
  const frozen = B.loadSlots(db).filter((s) => s.status !== 'scheduled');
  for (const p of proposed) {
    for (const f of frozen) {
      const intersects = p.artworkIds.some((aid) => f.artworkIds.includes(aid));
      if (!intersects) continue;
      let fs, fe;
      if (f.status === 'finished') {
        const a = B.parseDateTime(f.actual_start);
        const b = B.parseDateTime(f.actual_end);
        fs = a.minutes; fe = b.minutes;
      } else {
        const a = B.parseDateTime(f.planned_start);
        const b = B.parseDateTime(f.planned_end);
        fs = a.minutes; fe = b.minutes;
      }
      if (p.startMin < fe && fs < p.endMin) {
        const fView = {
          cid: `saved#${f.id}`, hall: f.hall,
          start: f.status === 'finished' ? f.actual_start : f.planned_start,
          end: f.status === 'finished' ? f.actual_end : f.planned_end,
          lux: f.status === 'finished' ? f.actual_lux : f.planned_lux,
          artworkIds: f.artworkIds,
          label: `${f.hall} ${f.status === 'finished' ? f.actual_start : f.planned_start} ~ ${f.status === 'finished' ? f.actual_end : f.planned_end}（${f.status === 'finished' ? '已结束' : '进行中·冻结'}）`,
        };
        for (const aid of p.artworkIds) {
          if (f.artworkIds.includes(aid)) addOverlap(aid, p, fView, 'new-frozen');
        }
      }
    }
  }

  if (overlapConflicts.length) {
    throw new HttpError(422, 'BATCH_REJECTED', '整批已拒绝：存在同作品时段重叠', {
      conflicts: overlapConflicts,
    });
  }

  // 2) 预算：既有 + 进行中预占 + 本批未开始预占 <= 上限
  const used = new Map(artworks.map((a) => [a.id, a.existing_amount]));
  for (const f of frozen) {
    for (const aid of f.artworkIds) {
      if (!used.has(aid)) continue;
      if (f.status === 'finished') used.set(aid, used.get(aid) + (f.actual_exposure || 0));
      else used.set(aid, used.get(aid) + (B.plannedExposure(f) || 0));
    }
  }

  const budgetExceeded = [];
  const needByArt = new Map(artworks.map((a) => [a.id, 0]));
  for (const p of proposed) {
    const expo = B.round3((p.endMin - p.startMin) * p.lux);
    for (const aid of p.artworkIds) needByArt.set(aid, (needByArt.get(aid) || 0) + expo);
  }
  for (const a of artworks) {
    const projected = B.round3(used.get(a.id) + needByArt.get(a.id));
    if (projected > a.limit_amount + 1e-9) {
      budgetExceeded.push({
        artworkId: a.id,
        artworkName: a.name,
        limit: a.limit_amount,
        used: B.round3(used.get(a.id)),
        projected,
        overflow: B.round3(projected - a.limit_amount),
      });
    }
  }
  if (budgetExceeded.length) {
    throw new HttpError(422, 'BATCH_REJECTED', '整批已拒绝：有作品预占后将超过展期上限', {
      budgetExceeded,
    });
  }

  // 全部通过：整批替换
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM slot_artworks WHERE slot_id IN (SELECT id FROM slots WHERE status = 'scheduled')").run();
    db.prepare("DELETE FROM slots WHERE status = 'scheduled'").run();

    const insSlot = db.prepare(`
      INSERT INTO slots (hall, seq, status, planned_start, planned_end, planned_lux)
      VALUES (?, 0, 'scheduled', ?, ?, ?)
    `);
    const insLink = db.prepare('INSERT INTO slot_artworks (slot_id, artwork_id) VALUES (?, ?)');
    for (const p of proposed) {
      const sid = insSlot.run(p.hall, p.start, p.end, p.lux).lastInsertRowid;
      p.artworkIds.forEach((aid) => insLink.run(sid, aid));
    }

    // 重新统一编号：开始时间升序，相同则按插入顺序
    const all = B.loadSlots(db).sort((a, b) => {
      const sa = B.parseDateTime(a.planned_start).minutes;
      const sb = B.parseDateTime(b.planned_start).minutes;
      return sa - sb || a.id - b.id;
    });
    const updSeq = db.prepare('UPDATE slots SET seq = ? WHERE id = ?');
    all.forEach((s, i) => updSeq.run(i + 1, s.id));

    B.recomputeBlocked(db);
    B.bumpVersion(db);
    return B.summarize(db);
  });
  return tx.immediate();
}

// ---------- 时段生命周期 ----------

// 解析并校验分段照度：每段含 start/end/lux（非负），
// 按实际分钟 × lux 求曝光；分段须首尾衔接、无重叠且完整覆盖 [actualStart, actualEnd]。
// 成功返回 { segments, exposure }；任一不满足抛 SEGMENTS_INVALID（整批拒绝）。
function parseSegments(body, actualStartStr, actualEndStr, where) {
  const errors = [];
  const raws = body && Array.isArray(body.segments) ? body.segments : null;
  if (!raws) {
    throw new HttpError(422, 'SEGMENTS_INVALID', '请求需要 segments 数组（至少一段，含 start/end/lux）', {
      errors: [{ message: 'segments 必须是非空数组' }],
    });
  }
  if (raws.length === 0) {
    throw new HttpError(422, 'SEGMENTS_INVALID', '分段不能为空：至少需要一段', {
      errors: [{ message: 'segments 长度为 0' }],
    });
  }

  const parsed = [];
  raws.forEach((raw, i) => {
    const at = () => `第 ${i + 1} 段`;
    const s = B.parseDateTime(raw && raw.start, `${where} ${at()} 开始时间`);
    const e = B.parseDateTime(raw && raw.end, `${where} ${at()} 结束时间`);
    if (s.error) errors.push({ index: i + 1, message: s.error });
    if (e.error) errors.push({ index: i + 1, message: e.error });
    if (!s.error && !e.error && e.minutes <= s.minutes) {
      errors.push({ index: i + 1, message: `${where} ${at()}：时长必须为正，结束须晚于开始` });
    }
    const lux = Number(raw && raw.lux);
    if (!B.isNonNegNumber(lux)) {
      errors.push({ index: i + 1, message: `${where} ${at()}：照度必须为非负数值` });
    }
    parsed.push({
      index: i + 1,
      start: s.error ? null : raw.start, startMin: s.error ? null : s.minutes,
      end: e.error ? null : raw.end, endMin: e.error ? null : e.minutes,
      lux: B.isNonNegNumber(lux) ? lux : null,
      minutes: !s.error && !e.error ? e.minutes - s.minutes : null,
      exposure: !s.error && !e.error && B.isNonNegNumber(lux)
        ? B.round3((e.minutes - s.minutes) * lux) : null,
    });
  });

  // 区间覆盖：首段起点须等于实际开始；后续段首尾衔接（同时杜绝缺口与重叠）；末段须等于实际结束。
  // 各段本身时间已合法时才参与衔接比较，避免无效时间产生连带误报。
  const as = B.parseDateTime(actualStartStr, `${where} 实际开始时间`);
  const ae = B.parseDateTime(actualEndStr, `${where} 实际结束时间`);
  if (parsed.every((g) => g.startMin !== null && g.endMin !== null)) {
    if (!as.error && parsed[0].startMin !== as.minutes) {
      errors.push({ index: 1, message: `分段未完整覆盖实际区间：首段开始 ${parsed[0].start} 必须等于实际开始 ${actualStartStr}` });
    }
    for (let i = 1; i < parsed.length; i++) {
      if (parsed[i].startMin !== parsed[i - 1].endMin) {
        const relation = parsed[i].startMin < parsed[i - 1].endMin ? '存在重叠' : '存在缺口';
        errors.push({
          index: i + 1,
          message: `${where} 分段未首尾衔接：第 ${i} 段结束 ${parsed[i - 1].end} 与第 ${i + 1} 段开始 ${parsed[i].start} ${relation}`,
        });
      }
    }
    const last = parsed[parsed.length - 1];
    if (!ae.error && last.endMin !== ae.minutes) {
      errors.push({
        index: parsed.length,
        message: `分段未完整覆盖实际区间：末段结束 ${last.end} 必须等于实际结束 ${actualEndStr}`,
      });
    }
  }

  if (errors.length) {
    throw new HttpError(422, 'SEGMENTS_INVALID', '分段校验未通过：分段须首尾衔接、无重叠且完整覆盖实际区间', { errors });
  }

  const exposure = B.segmentsExposure(parsed);
  return { segments: parsed, exposure };
}

// 整段替换某时段的分段行
function replaceSlotSegments(db, slotId, segments) {
  db.prepare('DELETE FROM slot_segments WHERE slot_id = ?').run(slotId);
  const ins = db.prepare(`
    INSERT INTO slot_segments (slot_id, seg_index, seg_start, seg_end, lux, exposure)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  segments.forEach((g) => ins.run(slotId, g.index, g.start, g.end, g.lux, g.exposure));
}

// 当前分段的可持久化快照（用于更正记录）
function segmentsSnapshot(segments) {
  return segments.map((g) => ({
    index: g.index, start: g.start, end: g.end,
    lux: g.lux, minutes: g.minutes, exposure: g.exposure,
  }));
}

function nowIsoLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function startSlot(db, id) {
  const tx = db.transaction(() => {
    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
    if (!slot) throw new HttpError(404, 'NOT_FOUND', `时段 #${id} 不存在`);
    if (slot.status !== 'scheduled') {
      throw new HttpError(422, 'NOT_STARTABLE', `时段 #${id} 当前状态为 ${slot.status}，仅未开始时段可以启动`);
    }
    if (slot.blocked) {
      let reason = {};
      try { reason = JSON.parse(slot.blocked_reason || '{}'); } catch { /* noop */ }
      throw new HttpError(422, 'BLOCKED', `时段 #${id} 预算不足，禁止启动；请先调整排期后重新核算`, {
        blockedReason: reason,
      });
    }
    // 开始：冻结原排期，预占保留
    db.prepare("UPDATE slots SET status = 'running' WHERE id = ?").run(id);
    B.recomputeBlocked(db);
    B.bumpVersion(db);
    return B.summarize(db);
  });
  return tx.immediate();
}

function finishSlot(db, id, body) {
  const as = B.parseDateTime(body.actualStart, '实际开始时间');
  const ae = B.parseDateTime(body.actualEnd, '实际结束时间');
  if (as.error) throw new HttpError(422, 'VALIDATION', as.error);
  if (ae.error) throw new HttpError(422, 'VALIDATION', ae.error);
  if (ae.minutes <= as.minutes) throw new HttpError(422, 'VALIDATION', '时序无效：实际结束必须晚于实际开始');
  const lux = Number(body.actualLux);
  if (!B.isNonNegNumber(lux)) throw new HttpError(422, 'VALIDATION', '实际照度必须为非负数值');
  const minutes = ae.minutes - as.minutes;
  const exposure = B.round3(minutes * lux);

  const tx = db.transaction(() => {
    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
    if (!slot) throw new HttpError(404, 'NOT_FOUND', `时段 #${id} 不存在`);
    if (slot.status !== 'running') {
      throw new HttpError(422, 'NOT_RUNNING', `时段 #${id} 当前状态为 ${slot.status}，仅进行中时段可以结束补记`);
    }
    // 实际曝光替换该时段预占
    db.prepare(`
      UPDATE slots SET status = 'finished',
        actual_start = ?, actual_end = ?, actual_lux = ?, actual_exposure = ?
      WHERE id = ?
    `).run(body.actualStart, body.actualEnd, lux, exposure, id);
    // 单照度结算同样落为一段，页面/API 统一按分段展示
    replaceSlotSegments(db, id, [{
      index: 1, start: body.actualStart, end: body.actualEnd,
      lux, minutes, exposure,
    }]);

    B.recomputeBlocked(db);
    B.bumpVersion(db);
    const state = B.summarize(db);
    const blocked = state.slots
      .filter((s) => s.status === 'scheduled' && s.blocked)
      .sort((a, b) => a.seq - b.seq);
    return { ...state, justFinishedExposure: exposure, blockedAfterFinish: blocked };
  });
  return tx.immediate();
}

// 多段照度结算（进行中时段）：实际起止 + 多段照度，按 Σ实际分钟×lux 求和。
// 分段须首尾衔接、无重叠且完整覆盖实际区间，否则整批拒绝（不改结算、不增版本）。
// 必须携带当前 version，过期返回 409 与最新预算。
function settleSlot(db, id, body) {
  requireVersion(db, body);
  const as = B.parseDateTime(body.actualStart, '实际开始时间');
  const ae = B.parseDateTime(body.actualEnd, '实际结束时间');
  if (as.error) throw new HttpError(422, 'VALIDATION', as.error);
  if (ae.error) throw new HttpError(422, 'VALIDATION', ae.error);
  if (ae.minutes <= as.minutes) throw new HttpError(422, 'VALIDATION', '时序无效：实际结束必须晚于实际开始');

  const { segments, exposure } = parseSegments(body, body.actualStart, body.actualEnd, '多段结算');
  const multi = segments.length > 1;

  const tx = db.transaction(() => {
    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
    if (!slot) throw new HttpError(404, 'NOT_FOUND', `时段 #${id} 不存在`);
    if (slot.status !== 'running') {
      throw new HttpError(422, 'NOT_RUNNING', `时段 #${id} 当前状态为 ${slot.status}，仅进行中时段可以结算`);
    }
    db.prepare(`
      UPDATE slots SET status = 'finished',
        actual_start = ?, actual_end = ?, actual_lux = ?, actual_exposure = ?
      WHERE id = ?
    `).run(body.actualStart, body.actualEnd, multi ? null : segments[0].lux, exposure, id);
    replaceSlotSegments(db, id, segments);

    B.recomputeBlocked(db);
    B.bumpVersion(db);
    const state = B.summarize(db);
    const blocked = state.slots
      .filter((s) => s.status === 'scheduled' && s.blocked)
      .sort((a, b) => a.seq - b.seq);
    return { ...state, justFinishedExposure: exposure, blockedAfterFinish: blocked };
  });
  return tx.immediate();
}

// 已结束时段更正：按原实际起止提交带理由的完整分段更正。
// 新总量替换旧总量（不重复累计），记录更正前后曝光和时间，并同步重算
// 作品已用量、后续时段不可启动状态及缺口。必须携带当前 version。
function correctSlot(db, id, body) {
  requireVersion(db, body);
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) throw new HttpError(422, 'VALIDATION', '更正理由不能为空', { field: 'reason' });
  if (reason.length > 500) throw new HttpError(422, 'VALIDATION', '更正理由过长（最多 500 字）', { field: 'reason' });

  const tx = db.transaction(() => {
    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
    if (!slot) throw new HttpError(404, 'NOT_FOUND', `时段 #${id} 不存在`);
    if (slot.status !== 'finished') {
      throw new HttpError(422, 'NOT_FINISHED', `时段 #${id} 当前状态为 ${slot.status}，仅已结束时段可以更正`);
    }

    // 更正必须沿用原实际起止；分段完整覆盖该区间
    const actualStart = slot.actual_start;
    const actualEnd = slot.actual_end;
    const { segments, exposure } = parseSegments(body, actualStart, actualEnd, '分段更正');
    const multi = segments.length > 1;

    // 事务内裸查的 slot 未挂载 segments，需显式读取当前分段作为更正前快照
    const curSegs = db.prepare('SELECT * FROM slot_segments WHERE slot_id = ? ORDER BY seg_index, id').all(id)
      .map((g) => ({
        index: g.seg_index, start: g.seg_start, end: g.seg_end, lux: g.lux,
        minutes: B.minutesBetween(g.seg_start, g.seg_end), exposure: g.exposure,
      }));
    const slotWithSegs = { ...slot, segments: curSegs };
    const beforeSegments = segmentsSnapshot(B.effectiveSegments(slotWithSegs));
    const before = {
      start: slot.actual_start, end: slot.actual_end,
      lux: beforeSegments.length === 1 ? beforeSegments[0].lux : null,
      exposure: B.round3(slot.actual_exposure || 0),
      segments: beforeSegments,
    };

    db.prepare(`
      UPDATE slots SET actual_start = ?, actual_end = ?, actual_lux = ?, actual_exposure = ?
      WHERE id = ?
    `).run(actualStart, actualEnd, multi ? null : segments[0].lux, exposure, id);
    replaceSlotSegments(db, id, segments);

    B.recomputeBlocked(db);
    B.bumpVersion(db);
    const version = db.prepare('SELECT version FROM meta WHERE id = 1').get().version;

    db.prepare(`
      INSERT INTO slot_corrections
        (slot_id, reason,
         before_start, before_end, before_lux, before_exposure, before_segments_json,
         after_start, after_end, after_lux, after_exposure, after_segments_json,
         version_after, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, reason,
      before.start, before.end, before.lux, before.exposure, JSON.stringify(before.segments),
      actualStart, actualEnd, multi ? null : segments[0].lux, exposure, JSON.stringify(segmentsSnapshot(segments)),
      version, nowIsoLocal()
    );

    const state = B.summarize(db);
    return {
      ...state,
      correction: {
        slotId: id, reason,
        beforeExposure: before.exposure, afterExposure: exposure,
        beforeMinutes: B.minutesBetween(before.start, before.end),
        afterMinutes: B.minutesBetween(actualStart, actualEnd),
        beforeStart: before.start, beforeEnd: before.end,
        afterStart: actualStart, afterEnd: actualEnd,
        segments: segmentsSnapshot(segments),
        version,
      },
    };
  });
  return tx.immediate();
}

module.exports = {
  HttpError, readBody, parseId,
  createArtwork, updateArtwork, deleteArtwork,
  replaceSchedule, startSlot, finishSlot, settleSlot, correctSlot,
};

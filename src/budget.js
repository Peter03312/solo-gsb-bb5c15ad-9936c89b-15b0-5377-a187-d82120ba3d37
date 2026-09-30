'use strict';

// ---------- 时间 ----------
// 统一使用本地时间字符串 YYYY-MM-DDTHH:mm（HTML datetime-local 的格式）
const DT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

function parseDateTime(str, field) {
  if (typeof str !== 'string') {
    return { error: `${field || '时间'}格式无效，应为 YYYY-MM-DDTHH:mm` };
  }
  const m = str.trim().match(DT_RE);
  if (!m) return { error: `${field || '时间'}格式无效，应为 YYYY-MM-DDTHH:mm` };
  const [, y, mo, d, h, mi, s] = m;
  const year = +y, month = +mo, day = +d, hour = +h, min = +mi, sec = s ? +s : 0;
  const date = new Date(year, month - 1, day, hour, min, sec, 0);
  // 回卷校验（如 2 月 30 日会被 Date 自动进位，必须拒绝）
  if (
    date.getFullYear() !== year || date.getMonth() !== month - 1 ||
    date.getDate() !== day || date.getHours() !== hour ||
    date.getMinutes() !== min || date.getSeconds() !== sec ||
    month < 1 || month > 12 || day < 1 || day > 31 ||
    hour > 23 || min > 59 || sec > 59
  ) {
    return { error: `${field || '时间'}不是合法日期时间` };
  }
  return { date, minutes: Math.floor(date.getTime() / 60000) };
}

function minutesBetween(startStr, endStr) {
  const s = parseDateTime(startStr);
  const e = parseDateTime(endStr);
  if (s.error || e.error) return null;
  return e.minutes - s.minutes;
}

const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

function isNonNegNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// ---------- 读取 ----------
function loadArtworks(db) {
  return db.prepare('SELECT * FROM artworks ORDER BY id').all();
}

function loadSlots(db) {
  const slots = db.prepare('SELECT * FROM slots ORDER BY planned_start, seq, id').all();
  const links = db.prepare('SELECT * FROM slot_artworks').all();
  const segs = db.prepare('SELECT * FROM slot_segments ORDER BY slot_id, seg_index, id').all();
  const corrections = db.prepare('SELECT * FROM slot_corrections ORDER BY slot_id, id').all();
  const bySlot = new Map();
  for (const l of links) {
    if (!bySlot.has(l.slot_id)) bySlot.set(l.slot_id, []);
    bySlot.get(l.slot_id).push(l.artwork_id);
  }
  const segBySlot = new Map();
  for (const g of segs) {
    if (!segBySlot.has(g.slot_id)) segBySlot.set(g.slot_id, []);
    segBySlot.get(g.slot_id).push(g);
  }
  const corrBySlot = new Map();
  for (const c of corrections) {
    if (!corrBySlot.has(c.slot_id)) corrBySlot.set(c.slot_id, []);
    corrBySlot.get(c.slot_id).push(c);
  }
  for (const s of slots) {
    s.artworkIds = (bySlot.get(s.id) || []).slice();
    s.segments = (segBySlot.get(s.id) || []).map((g) => ({
      index: g.seg_index,
      start: g.seg_start,
      end: g.seg_end,
      lux: g.lux,
      minutes: minutesBetween(g.seg_start, g.seg_end),
      exposure: g.exposure,
    }));
    s.corrections = (corrBySlot.get(s.id) || []).map(correctionDto);
  }
  return slots;
}

function correctionDto(c) {
  const parse = (t) => { try { return JSON.parse(t); } catch { return []; } };
  return {
    id: c.id,
    reason: c.reason,
    before: {
      start: c.before_start, end: c.before_end, lux: c.before_lux,
      exposure: c.before_exposure, segments: parse(c.before_segments_json),
    },
    after: {
      start: c.after_start, end: c.after_end, lux: c.after_lux,
      exposure: c.after_exposure, segments: parse(c.after_segments_json),
    },
    version: c.version_after,
    createdAt: c.created_at,
  };
}

function plannedExposure(slot) {
  const mins = minutesBetween(slot.planned_start, slot.planned_end);
  if (mins === null || mins < 0) return null;
  return round3(mins * slot.planned_lux);
}

function actualExposure(slot) {
  if (slot.actual_start == null || slot.actual_end == null || slot.actual_lux == null) return null;
  const mins = minutesBetween(slot.actual_start, slot.actual_end);
  if (mins === null || mins < 0) return null;
  return round3(mins * slot.actual_lux);
}

// 有效分段：优先读取 slot_segments；旧库已结束时段若尚无分段行，
// 按其单照度（actualStart/End/actualLux）合成一段用于展示与更正快照。
function effectiveSegments(slot) {
  if (Array.isArray(slot.segments) && slot.segments.length) return slot.segments;
  if (slot.actual_start != null && slot.actual_end != null && slot.actual_lux != null) {
    const mins = minutesBetween(slot.actual_start, slot.actual_end);
    if (mins !== null && mins >= 0) {
      return [{
        index: 1, start: slot.actual_start, end: slot.actual_end,
        lux: slot.actual_lux, minutes: mins, exposure: round3(mins * slot.actual_lux),
      }];
    }
  }
  return [];
}

function segmentsExposure(segments) {
  return round3(segments.reduce((sum, g) => sum + (g.exposure || 0), 0));
}

function slotDto(slot, artworksById) {
  const planned = plannedExposure(slot);
  const actual = slot.status === 'finished' ? slot.actual_exposure : actualExposure(slot);
  const segments = effectiveSegments(slot);
  const multiSegment = segments.length > 1;
  let blockedReason = null;
  try { blockedReason = JSON.parse(slot.blocked_reason || '{}'); } catch { blockedReason = {}; }
  return {
    id: slot.id,
    hall: slot.hall,
    seq: slot.seq,
    status: slot.status,
    plannedStart: slot.planned_start,
    plannedEnd: slot.planned_end,
    plannedLux: slot.planned_lux,
    plannedMinutes: planned === null ? null : minutesBetween(slot.planned_start, slot.planned_end),
    plannedExposure: planned,
    actualStart: slot.actual_start,
    actualEnd: slot.actual_end,
    // 单段结算时返回该段照度；多段结算时为 null（逐段照度见 actualSegments）
    actualLux: multiSegment ? null : slot.actual_lux,
    actualMinutes: actual === null ? null : minutesBetween(slot.actual_start, slot.actual_end),
    actualExposure: actual,
    actualSegments: segments,
    corrections: slot.corrections || [],
    blocked: !!slot.blocked,
    blockedReason,
    artworks: slot.artworkIds.map((id) => {
      const a = artworksById.get(id);
      return { id, name: a ? a.name : `#${id}` };
    }),
  };
}

// ---------- 汇总 ----------
function summarize(db) {
  const artworks = loadArtworks(db);
  const slots = loadSlots(db);
  const artworksById = new Map(artworks.map((a) => [a.id, a]));

  const acc = new Map();
  for (const a of artworks) {
    acc.set(a.id, { used: a.existing_amount, reservedRunning: 0, reservedScheduled: 0 });
  }

  for (const slot of slots) {
    const expo = plannedExposure(slot);
    const actual = slot.status === 'finished' ? slot.actual_exposure : null;
    for (const aid of slot.artworkIds) {
      if (!acc.has(aid)) continue;
      const row = acc.get(aid);
      if (slot.status === 'finished') row.used += actual || 0;
      else if (slot.status === 'running') row.reservedRunning += expo || 0;
      else row.reservedScheduled += expo || 0; // 含被标记为不可启动的时段
    }
  }

  const artworkDtos = artworks.map((a) => {
    const r = acc.get(a.id);
    const used = round3(r.used);
    const reserved = round3(r.reservedRunning + r.reservedScheduled);
    const committed = round3(used + reserved);
    const balance = round3(a.limit_amount - committed);
    return {
      id: a.id,
      name: a.name,
      limit: a.limit_amount,
      existing: a.existing_amount,
      note: a.note,
      used,
      reserved,
      reservedRunning: round3(r.reservedRunning),
      reservedScheduled: round3(r.reservedScheduled),
      committed,
      balance,
      over: balance < 0,
    };
  });

  return {
    version: db.prepare('SELECT version FROM meta WHERE id = 1').get().version,
    artworks: artworkDtos,
    slots: slots.map((s) => slotDto(s, artworksById)),
  };
}

// ---------- 预算核算：按开始时间/编号顺序标记不可启动的时段 ----------
// 规则：按时序逐个尝试放入未开始时段，任一关联作品余额不足即标记为不可启动
// 并记下缺口；被标记的时段视为不会启动，不再占用后续预算。
function recomputeBlocked(db) {
  const slots = loadSlots(db);
  const artworks = loadArtworks(db);
  const used = new Map(artworks.map((a) => [a.id, a.existing_amount]));
  const names = new Map(artworks.map((a) => [a.id, a.name]));
  const limits = new Map(artworks.map((a) => [a.id, a.limit_amount]));

  for (const s of slots) {
    if (s.status === 'finished') {
      for (const aid of s.artworkIds) if (used.has(aid)) used.set(aid, used.get(aid) + (s.actual_exposure || 0));
    } else if (s.status === 'running') {
      const expo = plannedExposure(s) || 0;
      for (const aid of s.artworkIds) if (used.has(aid)) used.set(aid, used.get(aid) + expo);
    }
  }

  const ordered = slots
    .filter((s) => s.status === 'scheduled')
    .sort((a, b) =>
      minutesBetween('2000-01-01T00:00', a.planned_start) - minutesBetween('2000-01-01T00:00', b.planned_start) ||
      a.seq - b.seq || a.id - b.id
    );

  const upd = db.prepare('UPDATE slots SET blocked = ?, blocked_reason = ? WHERE id = ?');
  for (const s of ordered) {
    const expo = plannedExposure(s) || 0;
    const gaps = [];
    for (const aid of s.artworkIds) {
      if (!used.has(aid)) continue;
      const projected = used.get(aid) + expo;
      if (projected > limits.get(aid) + 1e-9) {
        gaps.push({
          artworkId: aid,
          artworkName: names.get(aid),
          has: round3(limits.get(aid) - used.get(aid)),         // 当前可用余额
          need: round3(expo),                                    // 本时段需求
          gap: round3(projected - limits.get(aid)),              // 缺口
        });
      }
    }
    if (gaps.length > 0) {
      upd.run(1, JSON.stringify({ gaps }), s.id);
      // 不可启动：不占用后续预算
    } else {
      upd.run(0, '{}', s.id);
      for (const aid of s.artworkIds) if (used.has(aid)) used.set(aid, used.get(aid) + expo);
    }
  }
  // 进行中 / 已结束时段不参与“不可启动”标记
  db.prepare("UPDATE slots SET blocked = 0, blocked_reason = '{}' WHERE status != 'scheduled'").run();
}

function bumpVersion(db) {
  db.prepare('UPDATE meta SET version = version + 1 WHERE id = 1').run();
}

module.exports = {
  parseDateTime,
  minutesBetween,
  round3,
  isNonNegNumber,
  loadArtworks,
  loadSlots,
  plannedExposure,
  actualExposure,
  effectiveSegments,
  segmentsExposure,
  correctionDto,
  summarize,
  recomputeBlocked,
  bumpVersion,
};

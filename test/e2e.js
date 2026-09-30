'use strict';
// 端到端规则验证（使用临时内存数据库逻辑通过 HTTP 接口验证）
const BASE = process.env.BASE || 'http://localhost:8080';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({})).then((j) => j || {});
  return { status: res.status, json };
}
const getState = async () => (await call('GET', '/api/state')).json;

(async () => {
  console.log('# 1. 整批校验：负值 / 无效时序');
  let r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'a', hall: 'X', start: '2026-10-05T10:00', end: '2026-10-05T09:00', lux: 100, artworkIds: [3] },
    { cid: 'b', hall: 'Y', start: '2026-10-06T10:00', end: '2026-10-06T11:00', lux: -5, artworkIds: [3] },
    { cid: 'c', hall: 'Z', start: '2026-02-30T10:00', end: '2026-10-06T11:00', lux: 5, artworkIds: [3] },
  ]});
  ok(r.status === 422 && r.json.errors.length === 3, `拒绝三种无效输入（得到 ${r.status}, ${r.json.errors?.length} 条）`);
  let st = await getState();
  ok(st.version === 1, '被拒绝后版本不变、数据不变');

  console.log('# 2. 同作品时段重叠（新-新 / 新-冻结）');
  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'p1', hall: '二号厅', start: '2026-10-10T10:00', end: '2026-10-10T12:00', lux: 100, artworkIds: [3] },
    { cid: 'p2', hall: '三号厅', start: '2026-10-10T11:00', end: '2026-10-10T13:00', lux: 100, artworkIds: [3] },
  ]});
  ok(r.status === 422 && r.json.conflicts?.length === 1, '新时段互相重叠被拒绝');
  ok(r.json.conflicts[0].artworkId === 3 && r.json.conflicts[0].slotA.cid === 'p1', '冲突指出作品与两个时段');

  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'f1', hall: '一号厅', start: '2026-09-30T10:00', end: '2026-09-30T11:00', lux: 100, artworkIds: [1] },
  ]});
  ok(r.status === 422 && r.json.conflicts?.[0]?.kind === 'new-frozen', '与进行中冻结时段重叠被拒绝');
  // 不同作品同一时间允许
  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'ok1', hall: '一号厅', start: '2026-09-30T10:00', end: '2026-09-30T11:00', lux: 100, artworkIds: [3] },
  ]});
  ok(r.status === 200, '不同作品同展厅时间重叠允许（仅按作品约束）');

  console.log('# 3. 预算超限整批拒绝');
  st = await getState(); // version 现在 2
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    { cid: 'big', hall: '四号厅', start: '2026-11-01T08:00', end: '2026-11-01T20:00', lux: 500, artworkIds: [2] },
  ]});
  ok(r.status === 422 && r.json.budgetExceeded?.[0]?.artworkId === 2,
     `超量拒绝并指出作品与超出值（overflow=${r.json.budgetExceeded?.[0]?.overflow}）`);
  st = await getState();
  ok(st.version === 2, '超量拒绝后版本不变');

  console.log('# 4. 过期版本并发拒绝');
  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'v', hall: '五号厅', start: '2026-12-01T10:00', end: '2026-12-01T11:00', lux: 10, artworkIds: [3] },
  ]});
  ok(r.status === 409 && r.json.error?.code === 'VERSION_STALE' && r.json.state.version === 2,
     `过期版本返回 409 与最新预算（state v${r.json.state?.version}）`);

  console.log('# 5. 合法整批保存 + 版本递增 + 重新编号');
  r = await call('POST', '/api/schedule', { version: 2, slots: [
    { cid: 'x', hall: '二号厅', start: '2026-10-20T10:00', end: '2026-10-20T12:00', lux: 120, artworkIds: [1, 2] },
    { cid: 'y', hall: '三号厅', start: '2026-10-19T09:00', end: '2026-10-19T10:00', lux: 80, artworkIds: [3] },
  ]});
  ok(r.status === 200 && r.json.version === 3, `整批保存成功，版本→${r.json.version}`);
  const sched = r.json.slots.filter((s) => s.status === 'scheduled').sort((a, b) => a.seq - b.seq);
  ok(sched.length === 2 && sched[0].hall === '三号厅' && sched[0].seq === 3 && sched[1].seq === 4,
     '按开始时间重新编号（冻结时段在前）');
  ok(sched.every((s) => !s.blocked), '预算充足：无不可启动时段');

  console.log('# 6. 启动进行中时段不允许 / 启动未开始时段');
  const target = sched[0]; // 三号厅 W3
  r = await call('POST', `/api/slots/2/start`);
  ok(r.status === 422 && r.json.error?.code === 'NOT_STARTABLE', '已在进行中的时段不能再次启动');
  r = await call('POST', `/api/slots/${target.id}/start`);
  ok(r.status === 200, '未开始时段可启动');
  st = r.json;
  const running3 = st.slots.find((s) => s.id === target.id);
  ok(running3.status === 'running', '状态变为进行中');
  ok(st.version === 4, '启动后版本 +1');
  // 启动后再保存排期：该时段必须从可编辑集合消失，且仍不可被重叠
  r = await call('POST', '/api/schedule', { version: 4, slots: [
    { cid: 'ov', hall: '三号厅', start: '2026-10-19T09:30', end: '2026-10-19T10:30', lux: 50, artworkIds: [3] },
  ]});
  ok(r.status === 422 && r.json.conflicts?.[0]?.kind === 'new-frozen', '启动后冻结：新排期与其重叠被拒');
  // 空批次合法
  r = await call('POST', '/api/schedule', { version: 4, slots: [] });
  ok(r.status === 200 && r.json.slots.filter((s) => s.status === 'scheduled').length === 0, '空批次合法（清空未开始排期）');

  console.log('# 7. 结束补记：无效时序拒绝');
  r = await call('POST', `/api/slots/${target.id}/finish`, {
    actualStart: '2026-10-19T10:00', actualEnd: '2026-10-19T09:00', actualLux: 100,
  });
  ok(r.status === 422, '实际结束早于开始被拒绝');
  r = await call('POST', `/api/slots/${target.id}/finish`, {
    actualStart: '2026-10-19T09:00', actualEnd: '2026-10-19T10:00', actualLux: -1,
  });
  ok(r.status === 422, '负照度被拒绝');

  console.log('# 8. 超量结算 → 后续时段按顺序标为不可启动并禁止启动');
  // 先重建排期：W1、W2 在进行中时段(2号 240min*200)之后
  st = await getState();
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    { cid: 'w1s', hall: '二号厅', start: '2026-10-01T10:00', end: '2026-10-01T12:00', lux: 180, artworkIds: [1] }, // 21600
    { cid: 'w2s', hall: '二号厅', start: '2026-10-02T10:00', end: '2026-10-02T13:00', lux: 150, artworkIds: [2, 3] }, // 27000
    { cid: 'w3s', hall: '三号厅', start: '2026-10-03T09:30', end: '2026-10-03T11:00', lux: 220, artworkIds: [3] }, // 19800
  ]});
  ok(r.status === 200, '恢复三条未开始时段');
  const beforeFinish = r.json;
  const w1Slot = beforeFinish.slots.find((s) => s.hall === '二号厅' && s.plannedStart.startsWith('2026-10-01'));
  const w2Slot = beforeFinish.slots.find((s) => s.hall === '二号厅' && s.plannedStart.startsWith('2026-10-02'));
  ok(!w1Slot.blocked && !w2Slot.blocked, '结算前均可启动');

  // 结束 slot 2（W1+W2），实际 300 lux × 240 = 72000，远超冻结预占 48000
  r = await call('POST', '/api/slots/2/finish', {
    actualStart: '2026-09-30T09:00', actualEnd: '2026-09-30T13:00', actualLux: 300,
  });
  ok(r.status === 200 && r.json.justFinishedExposure === 72000, `实际曝光 ${r.json.justFinishedExposure} 替换预占`);
  // W1: 12000+22400+72000 = 106400, 余 13600 < 21600 → 缺口 8000
  // W2: 20000+72000 = 92000, 余 8000 < 27000 → 缺口 19000
  const blockedIds = r.json.blockedAfterFinish.map((s) => s.id);
  ok(blockedIds.length === 2 && blockedIds[0] === w1Slot.id,
     `按开始顺序标出不可开始时段：#${r.json.blockedAfterFinish.map((s) => s.seq).join(', #')}`);
  const g1 = w1Slot ? r.json.blockedAfterFinish.find((s) => s.id === w1Slot.id).blockedReason.gaps[0] : null;
  ok(g1 && g1.artworkId === 1 && g1.gap === 8000 && g1.has === 13600 && g1.need === 21600,
     `W1 缺口数据正确（has=${g1?.has}, need=${g1?.need}, gap=${g1?.gap}）`);

  // 尝试启动被拦截时段
  r = await call('POST', `/api/slots/${w1Slot.id}/start`);
  ok(r.status === 422 && r.json.error?.code === 'BLOCKED' && r.json.blockedReason.gaps[0].gap === 8000,
     '预算不足时段禁止启动并返回缺口');

  // W3 时段（10-03）：由于 w2s 联展 W3 但被跳过（不占预算），W3 独立时段应仍可启动
  const w3Only = r.json ? null : null;
  st = await getState();
  const w3slot = st.slots.find((s) => s.plannedStart.startsWith('2026-10-03'));
  ok(!w3slot.blocked, '被拦截时段不占预算，后续预算充足的时段仍标记可启动（贪婪核算）');

  console.log('# 9. 调整排期后重新核算，缺口消除');
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    // W1 缩短到 60 分钟 × 180 = 10800 <= 13600
    { cid: 'w1f', hall: '二号厅', start: '2026-10-01T10:00', end: '2026-10-01T11:00', lux: 180, artworkIds: [1] },
    // W2 降到 50 lux × 60 = 3000 <= 8000，同时联展 W3
    { cid: 'w2f', hall: '二号厅', start: '2026-10-02T10:00', end: '2026-10-02T11:00', lux: 50, artworkIds: [2, 3] },
    { cid: 'w3f', hall: '三号厅', start: '2026-10-03T09:30', end: '2026-10-03T11:00', lux: 220, artworkIds: [3] },
  ]});
  ok(r.status === 200 && r.json.slots.filter((s) => s.status === 'scheduled').every((s) => !s.blocked),
     '调整后重新核算：所有时段均可启动');
  st = r.json;
  const w1Final = st.slots.find((s) => s.plannedStart.startsWith('2026-10-01'));
  r = await call('POST', `/api/slots/${w1Final.id}/start`);
  ok(r.status === 200, '调整后时段可以启动');

  console.log('# 10. 作品校验：既有>上限拒绝；重复名拒绝；被引用时删除拒绝');
  st = await getState(); // #9 的启动操作又递增过版本，重新取最新版本
  r = await call('POST', '/api/artworks', { version: st.version, name: '测试品', limit: 100, existing: 200 });
  ok(r.status === 422, '既有累计超过上限拒绝');
  r = await call('POST', '/api/artworks', { version: st.version, name: '《山水轴》纸本水墨', limit: 100, existing: 0 });
  ok(r.status === 422, '作品名重复拒绝');
  r = await call('DELETE', '/api/artworks/1', { version: st.version });
  ok(r.status === 409 && r.json.error?.code === 'IN_USE', '被时段引用的作品不可删除');

  console.log('# 11. 合法作品增删改');
  r = await call('POST', '/api/artworks', { version: st.version, name: '新增测试品', limit: 5000, existing: 100, note: 'hi' });
  ok(r.status === 200, '新作品录入成功');
  const newId = r.json.artworks.at(-1).id;
  r = await call('PUT', `/api/artworks/${newId}`, { version: r.json.version, name: '新增测试品改', limit: 6000, existing: 200, note: 'x' });
  ok(r.status === 200 && r.json.artworks.at(-1).limit === 6000, '作品更新成功');
  r = await call('DELETE', `/api/artworks/${newId}`, { version: r.json.version });
  ok(r.status === 200 && !r.json.artworks.some((a) => a.id === newId), '未被引用的作品可删除');

  console.log('# 12. 多段照度结算：分段完整性校验（衔接/覆盖/非负）');
  st = await getState();
  // 独立演示作品，避免与前面步骤的数据耦合
  r = await call('POST', '/api/artworks', { version: st.version, name: '分段测试品', limit: 200000, existing: 0 });
  ok(r.status === 200, '分段测试作品已创建');
  const segArtId = r.json.artworks.at(-1).id;
  let v = r.json.version;
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'seg-a', hall: '四号厅', start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 100, artworkIds: [segArtId] },
    { cid: 'seg-b', hall: '四号厅', start: '2026-11-10T14:00', end: '2026-11-10T16:00', lux: 100, artworkIds: [segArtId] },
  ]});
  ok(r.status === 200, '两个测试时段已排期');
  v = r.json.version;
  const segA = r.json.slots.find((s) => s.plannedStart.startsWith('2026-11-10T09'));
  const segB = r.json.slots.find((s) => s.plannedStart.startsWith('2026-11-10T14'));
  r = await call('POST', `/api/slots/${segA.id}/start`);
  ok(r.status === 200, '测试时段 A 已启动');
  v = r.json.version;

  const settlePath = `/api/slots/${segA.id}/settle`;
  // 缺口：两段之间空 10 分钟
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 100 },
    { start: '2026-11-10T10:10', end: '2026-11-10T11:00', lux: 200 },
  ]});
  ok(r.status === 422 && r.json.error.code === 'SEGMENTS_INVALID' && r.json.segmentErrors.length >= 1,
     '分段有缺口被整批拒绝');
  // 重叠
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:30', lux: 100 },
    { start: '2026-11-10T10:00', end: '2026-11-10T11:00', lux: 200 },
  ]});
  ok(r.status === 422 && r.json.segmentErrors.some((m) => m.includes('衔接')), '分段重叠被拒绝');
  // 未覆盖到区间末尾
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:30', lux: 100 },
  ]});
  ok(r.status === 422 && r.json.segmentErrors.some((m) => m.includes('完整覆盖')), '分段未完整覆盖实际区间被拒绝');
  // 负照度
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: -1 },
  ]});
  ok(r.status === 422, '分段负照度被拒绝');
  // 空数组
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [] });
  ok(r.status === 422, '空分段被拒绝');
  // 零长度中间段（末段恰好等于区间结束，也不能漏网）
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 100 },
    { start: '2026-11-10T10:00', end: '2026-11-10T10:00', lux: 100 },
    { start: '2026-11-10T10:00', end: '2026-11-10T11:00', lux: 100 },
  ]});
  ok(r.status === 422 && r.json.segmentErrors.some((m) => m.includes('结束必须晚于开始')), '零长度中间段被拒绝');
  // 末段被包含在前段内（前段已到区间结束）→ 重叠
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 100 },
    { start: '2026-11-10T10:00', end: '2026-11-10T11:00', lux: 200 },
  ]});
  ok(r.status === 422 && r.json.segmentErrors.some((m) => m.includes('重叠')), '末段与前段重叠（区间被超过）被拒绝');
  // 乱序提交（第 2 段在第 1 段之前）→ 缺口
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T10:00', end: '2026-11-10T11:00', lux: 200 },
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 100 },
  ]});
  ok(r.status === 422 && r.json.segmentErrors.some((m) => m.includes('缺口') || m.includes('覆盖')), '分段未按时间顺序提交被拒绝');
  st = await getState();
  ok(st.version === v, '分段拒绝不改变结算与版本');

  // 过期版本 → 409 + 最新预算
  r = await call('POST', settlePath, { version: 1, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 100 },
  ]});
  ok(r.status === 409 && r.json.error.code === 'VERSION_STALE' && r.json.state.version === v,
     '多段结算过期版本返回 409 与最新预算');

  console.log('# 13. 多段结算成功：Σ(分钟×照度)，返回分段与总量');
  // 60*120 + 30*200 + 30*0 = 7200 + 6000 + 0 = 13200
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 120 },
    { start: '2026-11-10T10:00', end: '2026-11-10T10:30', lux: 200 },
    { start: '2026-11-10T10:30', end: '2026-11-10T11:00', lux: 0 },
  ]});
  ok(r.status === 200 && r.json.justFinishedExposure === 13200 && r.json.justFinishedMinutes === 120
     && r.json.justFinishedSegments.length === 3,
     `多段结算总量 ${r.json.justFinishedExposure}（应 13200）、时长 ${r.json.justFinishedMinutes} 分、3 段`);
  v = r.json.version;
  const settledA = r.json.slots.find((s) => s.id === segA.id);
  ok(settledA.status === 'finished' && settledA.actualLux === null && settledA.segmentCount === 3
     && settledA.actualSegments[2].exposure === 0,
     '多段结算后状态 finished、无单一照度、含 0 照度段');
  const segArt = r.json.artworks.find((a) => a.id === segArtId);
  ok(segArt.used === 13200, `作品已用 = 分段曝光之和 ${segArt.used}`);
  // 已结束时段不能再 settle
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 100 },
  ]});
  ok(r.status === 422 && r.json.error.code === 'NOT_RUNNING', '已结束时段不能再次结算');

  console.log('# 14. 已结束时段分段更正：理由/覆盖校验/替换语义/记录');
  const correctPath = `/api/slots/${segA.id}/correct`;
  // 缺理由
  r = await call('POST', correctPath, { version: v, segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 110 },
  ]});
  ok(r.status === 422 && r.json.error.code === 'VALIDATION', '无理由更正被拒绝');
  // 分段不覆盖原实际区间
  r = await call('POST', correctPath, { version: v, reason: 'x', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 110 },
  ]});
  ok(r.status === 422 && r.json.error.code === 'SEGMENTS_INVALID', '更正分段未覆盖原区间被拒绝');
  // 过期版本
  r = await call('POST', correctPath, { version: 1, reason: 'x', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 110 },
  ]});
  ok(r.status === 409 && r.json.state.version === v, '更正过期版本返回 409 与最新预算');
  st = await getState();
  ok(st.version === v && st.slots.find((s) => s.id === segA.id).actualExposure === 13200, '更正失败不改结算与版本');

  // 合法更正：改为两段 60*110 + 60*130 = 6600 + 7800 = 14400（替换 13200，不累加）
  r = await call('POST', correctPath, { version: v, reason: '照度计复核：开场调暗、随后恢复', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 110 },
    { start: '2026-11-10T10:00', end: '2026-11-10T11:00', lux: 130 },
  ]});
  ok(r.status === 200 && r.json.correction.seqNo === 1
     && r.json.correction.before.exposure === 13200 && r.json.correction.after.exposure === 14400
     && r.json.correction.before.segments.length === 3 && r.json.correction.after.segments.length === 2,
     '更正记录含更正前后曝光(13200→14400)、时间与分段数');
  v = r.json.version;
  const afterArt = r.json.artworks.find((a) => a.id === segArtId);
  ok(afterArt.used === 14400, `新总量替换旧总量、不重复累计：已用 ${afterArt.used}（应 14400）`);
  const afterSlot = r.json.slots.find((s) => s.id === segA.id);
  ok(afterSlot.actualExposure === 14400 && afterSlot.corrections.length === 1
     && afterSlot.corrections[0].reason.includes('照度计复核')
     && afterSlot.corrections[0].before.minutes === 120 && afterSlot.corrections[0].after.minutes === 120,
     '时段 DTO 携带更正记录（理由与前后时间）');

  console.log('# 15. 更正影响后续时段不可启动状态与缺口，再更正恢复');
  // segB（14:00–16:00，120 分钟）先启动前应可启动；当前已用 14400，上限 200000 充足 → 启动它
  r = await call('POST', `/api/slots/${segB.id}/start`);
  ok(r.status === 200, '测试时段 B 可启动');
  v = r.json.version;
  // 把 segA 更正为 199000：120 分钟单一照度，超出后 B 已在进行中（不标 blocked），
  // 这里改为验证未开始时段：再排一个 segC
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'seg-c', hall: '五号厅', start: '2026-11-11T09:00', end: '2026-11-11T10:00', lux: 100, artworkIds: [segArtId] },
  ]});
  ok(r.status === 200, '测试时段 C 已排期（60*100=6000）');
  v = r.json.version;
  const segC = r.json.slots.find((s) => s.plannedStart.startsWith('2026-11-11'));
  // 已用 14400（A）+ B 进行中预占 12000 = 26400；C 需 6000 → 当前可启动
  ok(!segC.blocked, '更正前 C 可启动');

  // 更正 A：120 分钟 * 1900 = 228000？上限 200000，会导致 B+C 全部超量；
  // 但 B 进行中预占固定 12000。C 判定时基线 = 1900*120 + 12000 = 240000 > 200000 → 缺口
  r = await call('POST', correctPath, { version: v, reason: '发现长期超照度，补登实测', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 1900 },
  ]});
  ok(r.status === 200 && r.json.correction.seqNo === 2, '第二次更正成功（seqNo=2）');
  v = r.json.version;
  const blockedC = r.json.blockedAfterFinish.find((s) => s.id === segC.id);
  ok(!!blockedC && blockedC.blockedReason.gaps[0].artworkId === segArtId,
     `更正后后续未开始时段被标不可启动，缺口 ${blockedC?.blockedReason.gaps[0].gap}`);
  const artOver = r.json.artworks.find((a) => a.id === segArtId);
  ok(artOver.used === 228000 && artOver.over === true, '更正后作品已用量同步重算为 228000');
  // 启动被拦截
  r = await call('POST', `/api/slots/${segC.id}/start`);
  ok(r.status === 422 && r.json.error.code === 'BLOCKED', '更正致缺口后 C 禁止启动');

  // 再更正回低照度：缺口消除
  r = await call('POST', correctPath, { version: v, reason: '复核为照度记录仪故障，恢复实测值', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 110 },
    { start: '2026-11-10T10:00', end: '2026-11-10T11:00', lux: 130 },
  ]});
  ok(r.status === 200 && r.json.correction.seqNo === 3
     && r.json.correction.before.exposure === 228000 && r.json.correction.after.exposure === 14400
     && r.json.blockedAfterFinish.length === 0,
     '第三次更正 228000→14400，缺口消除、后续时段恢复可启动');
  st = await getState();
  const restoredC = st.slots.find((s) => s.id === segC.id);
  ok(!restoredC.blocked && st.artworks.find((a) => a.id === segArtId).used === 14400,
     '恢复更正后 C 可启动、作品已用量回到 14400、更正记录共 3 条');
  ok(st.slots.find((s) => s.id === segA.id).corrections.length === 3, '更正历史累计 3 条且只增不改');

  console.log('# 16. 演示数据自带分段与更正记录');
  st = await getState();
  ok(st.slots.find((s) => s.id === 1).segmentCount === 2
     && st.slots.find((s) => s.id === 1).actualLux === null
     && st.slots.find((s) => s.id === 1).corrections.length >= 1
     && st.slots.find((s) => s.id === 1).actualExposure === 22400,
     '初始已结束时段为多段结算（2 段、合计 22400）并带更正记录');

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

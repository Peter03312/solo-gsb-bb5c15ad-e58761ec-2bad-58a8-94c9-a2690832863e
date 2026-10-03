'use strict';

/**
 * 进路定义批量变更集 HTTP 集成测试：
 *   临时库启动真实服务 → 鉴权（仅管理员）→ 请求体校验 → 预览返回修订标识/
 *   逐条结果/受影响等待/阻断原因 → 成功混合批落地（仅列改进路、不动占用）→
 *   等待申请随修改/删除失效 → 非法批整批不落地、等待保持原状 → 修订标识过期
 *   （定义/引用资源/等待变化；扳道岔不使其过期）→ 开放进路阻断 →
 *   删除进路清理已解除历史实例 → 现有单条编辑与排路接口继续可用 →
 *   暂停副本可预览不可发布、恢复后发布且按站场隔离 → 重启后修订标识稳定。
 *
 * 运行：node test/route-changeset-http.cjs
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3931;
const DB_PATH = process.env.SMOKE_DB_CS || path.join(__dirname, '..', 'data', 'route-changeset-test.db');
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
function ok(name, cond, extra) {
  if (!cond) throw new Error(name + (extra ? `（${JSON.stringify(extra)}）` : ''));
  console.log('  ✓', name);
  passed++;
}
function eq(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log('  ✓', name);
  passed++;
}

let server = null;
function startServer(keepDb = false) {
  return new Promise((resolve, reject) => {
    if (!keepDb) {
      for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
      }
      fs.rmSync(path.join(path.dirname(DB_PATH),
        path.basename(DB_PATH, path.extname(DB_PATH)) + '.yards'),
        { recursive: true, force: true });
    }
    server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DB_PATH, SEED_DEMO: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('服务启动超时: ' + out)), 10000);
    server.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('已启动')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', (d) => { out += d.toString(); });
    server.on('exit', (code) => { if (code !== 0) reject(new Error('服务异常退出: ' + out)); });
  });
}
function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.on('exit', () => { server = null; resolve(); });
    server.kill('SIGTERM');
    setTimeout(() => { try { server.kill('SIGKILL'); } catch (_) {} }, 3000);
  });
}

async function api(pathName, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const resp = await fetch(BASE + pathName, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await resp.json(); } catch (_) {}
  return { status: resp.status, data };
}

async function login(role, nameOrPwd) {
  const body = role === 'admin' ? { password: nameOrPwd || 'admin123' } : { name: nameOrPwd };
  const { status, data } = await api(`/api/auth/login/${role}`, { method: 'POST', body });
  if (status !== 200) throw new Error('登录失败: ' + data.error);
  return data.token;
}

/** 按进路走完整条（占/清交错），推进到末段清空自动解除 */
async function walkThrough(token, instanceId, sections) {
  let seq = 1;
  for (let i = 0; i < sections.length; i++) {
    await api(`/api/instances/${instanceId}/events`, {
      token, method: 'POST', body: { seq: seq++, sectionId: sections[i], action: 'occupy' }
    });
    if (i >= 1) {
      await api(`/api/instances/${instanceId}/events`, {
        token, method: 'POST', body: { seq: seq++, sectionId: sections[i - 1], action: 'clear' }
      });
    }
  }
  await api(`/api/instances/${instanceId}/events`, {
    token, method: 'POST', body: { seq: seq++, sectionId: sections[sections.length - 1], action: 'clear' }
  });
}

async function getState(token) {
  const r = await api('/api/state', { token });
  return r.data.state;
}

const preview = (token, changes) =>
  api('/api/admin/routes/changeset/preview', { token, method: 'POST', body: { changes } });
const publish = (token, changes, revision) =>
  api('/api/admin/routes/changeset/publish', {
    token, method: 'POST', body: { changes, revision }
  });

async function main() {
  await startServer();
  const admin = await login('admin');
  const jia = await login('dispatcher', '值班员甲');

  console.log('\n[1] 鉴权：仅管理员可预览/发布');
  let r = await api('/api/admin/routes/changeset/preview', { method: 'POST', body: { changes: [] } });
  eq('未登录预览 401', r.status, 401);
  r = await preview(jia, []);
  eq('值班员预览 403', r.status, 403);
  r = await api('/api/admin/routes/changeset/publish', {
    token: jia, method: 'POST', body: { changes: [], revision: 'x' }
  });
  eq('值班员发布 403', r.status, 403);

  console.log('\n[2] 请求体校验');
  r = await api('/api/admin/routes/changeset/preview', { token: admin, method: 'POST', body: {} });
  eq('缺 changes 400', r.status, 400);
  eq('缺 changes 错误码', r.data.code, 'CHANGESET_CHANGES_REQUIRED');
  r = await preview(admin, []);
  eq('空批 400', r.status, 400);
  eq('空批错误码', r.data.code, 'CHANGESET_EMPTY');
  r = await preview(admin, [{ op: 'frobnicate', routeId: 'R1' }]);
  eq('非法 op 预览 200（错误落在条目上）', r.status, 200);
  eq('非法 op 条目不合法', r.data.items[0].valid, false);
  ok('非法 op 错误说明', /create、update 或 delete/.test(r.data.items[0].errors[0]));
  eq('非法 op 时整批不可发布', r.data.publishable, false);

  // 干净初始盘面（区段空闲、道岔 N，保留示例进路 R1/R2/R3）
  await api('/api/admin/reset/training', { token: admin, method: 'POST' });

  console.log('\n[3] 修订标识：形状与只读预览');
  r = await preview(admin, [{ op: 'create', routeId: 'R9', route: {
    label: '示例', origin: 'X1', destination: 'X2', entrySignalId: 'S2',
    steps: ['1', '2'], switchReqs: [{ switchId: 'SW7', position: 'R' }] } }]);
  eq('预览 200', r.status, 200);
  ok('修订标识 rc1 三段', /^rc1\.[0-9a-f]{16}\.[0-9a-f]{16}\.[0-9a-f]{16}$/.test(r.data.revision), r.data.revision);
  eq('预览后 R9 仍不存在（只读）', (await getState(jia)).routes.some((x) => x.id === 'R9'), false);

  console.log('\n[4] 发布缺标识 / 乱标识');
  r = await api('/api/admin/routes/changeset/publish', {
    token: admin, method: 'POST', body: { changes: [{ op: 'create', routeId: 'R9' }] }
  });
  eq('无修订标识 409', r.status, 409);
  eq('无修订标识错误码', r.data.code, 'CHANGESET_REVISION_REQUIRED');
  r = await api('/api/admin/routes/changeset/publish', {
    token: admin, method: 'POST',
    body: { changes: [{ op: 'create', routeId: 'R9' }], revision: 'not-a-real-revision' }
  });
  eq('乱修订标识 409', r.status, 409);
  eq('乱修订标识错误码', r.data.code, 'CHANGESET_REVISION_STALE');
  ok('乱标识列出三类变化',
    JSON.stringify(r.data.changedCategories.sort()) === JSON.stringify(['definitions', 'resources', 'waiting']),
    r.data.changedCategories);
  // 被拒后仍不存在
  eq('拒绝发布后 R9 不存在', (await getState(jia)).routes.some((x) => x.id === 'R9'), false);

  console.log('\n[5] 成功混合批：创建 R9 + 修改 R2（改显示名）');
  const batchA = [
    { op: 'create', routeId: 'R9', route: {
      label: '新增侧线 R9', origin: 'X1', destination: 'X2', entrySignalId: 'S2',
      steps: ['1', '2'], switchReqs: [{ switchId: 'SW7', position: 'R' }] } },
    { op: 'update', routeId: 'R2', route: {
      label: '改名-R2', origin: 'X1', destination: 'X4', entrySignalId: 'S2',
      steps: ['1', '3', '4', '2'], switchReqs: [
        { switchId: 'SW7', position: 'R' }, { switchId: 'SW8', position: 'R' }] } }
  ];
  r = await preview(admin, batchA);
  eq('混合批预览合法', r.data.valid, true);
  eq('混合批可发布', r.data.publishable, true);
  eq('计数 create=1', r.data.counts.create, 1);
  eq('计数 update=1', r.data.counts.update, 1);
  const revA = r.data.revision;
  r = await publish(admin, batchA, revA);
  eq('混合批发布 200', r.status, 200);
  eq('发布回显 published', r.data.published, true);
  let st = await getState(jia);
  const r9 = st.routes.find((x) => x.id === 'R9');
  ok('R9 已创建（区段顺序）', r9 && JSON.stringify(r9.steps.map((s) => s.section_id)) === JSON.stringify(['1', '2']), r9);
  ok('R9 入口信号 S2', r9 && r9.entry_signal_id === 'S2');
  eq('R2 已改名', st.routes.find((x) => x.id === 'R2').label, '改名-R2');
  ok('R1 未被改动', st.routes.find((x) => x.id === 'R1').label !== '改名-R2');
  ok('R3 未被改动', !!st.routes.find((x) => x.id === 'R3'));
  ok('发布后修订标识变化', r.data.revision !== revA);
  // 旧修订标识立即失效（定义已变）
  r = await publish(admin, batchA, revA);
  eq('重复用旧标识发布被拒', r.status, 409);
  eq('旧标识错误码 definitions', r.data.code, 'CHANGESET_REVISION_STALE');

  console.log('\n[6] 修改/删除使相关等待申请失效；不改变区段占用');
  // 造阻断：占用区段 3 → R1 等待不兑现；R2 要求 SW7/SW8=R，实际 N → 不兑现
  await api('/api/sections/3/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  let w = await api('/api/routes/R1/waiting', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
  eq('R1 等待已提交', w.status, 201);
  const wR1 = w.data.waiting.id;
  eq('R1 等待中', w.data.waiting.status, 'waiting');
  w = await api('/api/routes/R2/waiting', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'R', SW8: 'R' } } });
  const wR2 = w.data.waiting.id;
  eq('R2 等待中', w.data.waiting.status, 'waiting');

  const batchB = [
    { op: 'update', routeId: 'R1', route: {
      label: 'R1 定义调整', origin: 'X1', destination: 'X3', entrySignalId: 'S1',
      steps: ['1', '3', '5'], switchReqs: [
        { switchId: 'SW7', position: 'N' }, { switchId: 'SW8', position: 'N' }] } },
    { op: 'delete', routeId: 'R2' }
  ];
  r = await preview(admin, batchB);
  eq('批B 预览合法', r.data.valid, true);
  const affectedIds = r.data.affectedWaiting.map((x) => x.id).sort();
  ok('预览列出两条受影响等待',
    JSON.stringify(affectedIds) === JSON.stringify([wR1, wR2].sort()), affectedIds);
  eq('受影响计数=2', r.data.affectedCounts.waitingToInvalidate, 2);
  // 预览不改动等待
  st = await getState(jia);
  eq('预览后 R1 等待仍 waiting',
    st.waitingApplications.find((x) => x.id === wR1).status, 'waiting');
  r = await publish(admin, batchB, r.data.revision);
  eq('批B 发布 200', r.status, 200);
  ok('发布返回失效等待编号',
    JSON.stringify(r.data.invalidatedWaiting.sort()) === JSON.stringify([wR1, wR2].sort()),
    r.data.invalidatedWaiting);
  st = await getState(jia);
  eq('R1 等待已失效', st.waitingApplications.find((x) => x.id === wR1).status, 'invalid');
  eq('R2 等待已失效', st.waitingApplications.find((x) => x.id === wR2).status, 'invalid');
  ok('失效原因含说明',
    /批量变更集/.test(st.waitingApplications.find((x) => x.id === wR1).endReason || ''),
    st.waitingApplications.find((x) => x.id === wR1).endReason);
  eq('R2 定义已删除', st.routes.some((x) => x.id === 'R2'), false);
  eq('区段 3 仍为占用（变更集不改占用）',
    st.sections.find((x) => x.id === '3').occ_state, 'occupied');
  eq('道岔 SW7 仍为 N（变更集不扳道岔）',
    st.switches.find((x) => x.id === 'SW7').position, 'N');
  // 恢复区段 3
  await api('/api/sections/3/state', { token: jia, method: 'POST', body: { action: 'clear' } });

  console.log('\n[7] 非法批：逐条错误齐全，整批不落地，等待保持原状');
  const badBatch = [
    { op: 'delete', routeId: 'R3' },                                   // 本身合法
    { op: 'create', routeId: 'R1' },                                   // 创建重名
    { op: 'update', routeId: 'NOPE' },                                 // 修改不存在
    { op: 'delete', routeId: 'GONE' },                                 // 删除不存在
    { op: 'create', routeId: 'RDUP', route: {                          // 区段重复
      origin: 'a', destination: 'b', steps: ['1', '1'] } },
    { op: 'create', routeId: 'RMISS', route: {                         // 三类缺失引用
      origin: 'a', destination: 'b', steps: ['1', '999'],
      switchReqs: [{ switchId: 'NOPE', position: 'N' }], entrySignalId: 'SX' } },
    { op: 'create', routeId: 'RD2', route: { origin: 'a', destination: 'b', steps: ['1'] } },
    { op: 'create', routeId: 'RD2', route: { origin: 'a', destination: 'b', steps: ['2'] } },
    { op: 'update', routeId: 'R9' }                                    // update 缺 route 体
  ];
  r = await preview(admin, badBatch);
  eq('非法批预览 200', r.status, 200);
  eq('非法批 valid=false', r.data.valid, false);
  eq('非法批不可发布', r.data.publishable, false);
  eq('非法条目数=8（仅 delete R3 合法）', r.data.counts.invalid, 8);
  const byId = Object.fromEntries(r.data.items.map((i) => [i.index, i]));
  ok('创建重名提示', byId[1].errors.some((m) => /已存在/.test(m)), byId[1].errors);
  ok('修改不存在提示', byId[2].errors.some((m) => /不存在/.test(m)), byId[2].errors);
  ok('删除不存在提示', byId[3].errors.some((m) => /不存在/.test(m)), byId[3].errors);
  ok('区段重复提示', byId[4].errors.some((m) => /区段顺序不得重复/.test(m)), byId[4].errors);
  ok('缺区段提示', byId[5].errors.some((m) => /区段 999/.test(m)), byId[5].errors);
  ok('缺道岔提示', byId[5].errors.some((m) => /道岔 NOPE/.test(m)), byId[5].errors);
  ok('缺信号机提示', byId[5].errors.some((m) => /信号机 SX/.test(m)), byId[5].errors);
  ok('批内编号重复提示（两条都标）',
    byId[6].errors.some((m) => /批内进路编号重复/.test(m)) &&
    byId[7].errors.some((m) => /批内进路编号重复/.test(m)));
  ok('update 缺 route 体报起点终点/区段错误', byId[8].errors.length >= 2, byId[8].errors);
  // 强行发布 → 409 CHANGESET_INVALID，整批不落地
  r = await publish(admin, badBatch, r.data.revision);
  eq('非法批发布 409', r.status, 409);
  eq('非法批错误码', r.data.code, 'CHANGESET_INVALID');
  st = await getState(jia);
  ok('R3 仍存在（整批回滚）', !!st.routes.find((x) => x.id === 'R3'));
  ok('R1 仍存在', !!st.routes.find((x) => x.id === 'R1'));
  ok('RDUP/RMISS/RD2 均未创建',
    !st.routes.some((x) => ['RDUP', 'RMISS', 'RD2'].includes(x.id)));
  // 既有失效/等待状态保持原状（没有新的失效发生）
  eq('R1 失效等待状态未变',
    st.waitingApplications.find((x) => x.id === wR1).status, 'invalid');

  console.log('\n[8] 预览后修订标识过期：定义/引用资源/等待变化分别拒绝');
  // 8a 定义变化（单条编辑）
  let p = await preview(admin, [{ op: 'create', routeId: 'RST', route: {
    origin: 'a', destination: 'b', steps: ['1'] } }]);
  r = await api('/api/admin/routes/R3', {
    token: admin, method: 'PUT', body: {
      id: 'R3', label: '单条改名 R3', origin: 'X2', destination: 'X3',
      steps: ['2', '4', '3', '5'],
      switchReqs: [{ switchId: 'SW7', position: 'R' }, { switchId: 'SW8', position: 'R' }] }
  });
  eq('现有单条修改接口仍 200', r.status, 200);
  r = await publish(admin, [{ op: 'create', routeId: 'RST', route: {
    origin: 'a', destination: 'b', steps: ['1'] } }], p.data.revision);
  eq('定义变化后发布 409', r.status, 409);
  ok('变化类别含 definitions', r.data.changedCategories.includes('definitions'), r.data.changedCategories);
  eq('RST 未创建', (await getState(jia)).routes.some((x) => x.id === 'RST'), false);

  // 8b 引用资源变化（新增区段）
  p = await preview(admin, [{ op: 'create', routeId: 'RST2', route: {
    origin: 'a', destination: 'b', steps: ['1'] } }]);
  r = await api('/api/admin/sections', {
    token: admin, method: 'POST',
    body: { id: 'X9', label: '新区段', x1: 0, y1: 0, x2: 10, y2: 10 }
  });
  eq('新增区段 200', r.status, 200);
  r = await publish(admin, [{ op: 'create', routeId: 'RST2', route: {
    origin: 'a', destination: 'b', steps: ['1'] } }], p.data.revision);
  eq('资源变化后发布 409', r.status, 409);
  ok('变化类别含 resources', r.data.changedCategories.includes('resources'), r.data.changedCategories);

  // 8c 等待申请变化（提交后撤销）
  p = await preview(admin, [{ op: 'create', routeId: 'RST3', route: {
    origin: 'a', destination: 'b', steps: ['1'] } }]);
  await api('/api/sections/1/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  w = await api('/api/routes/R1/waiting', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
  const wTmp = w.data.waiting.id;
  await api(`/api/waiting/${wTmp}/cancel`, { token: jia, method: 'POST' });
  await api('/api/sections/1/state', { token: jia, method: 'POST', body: { action: 'clear' } });
  r = await publish(admin, [{ op: 'create', routeId: 'RST3', route: {
    origin: 'a', destination: 'b', steps: ['1'] } }], p.data.revision);
  eq('等待变化后发布 409', r.status, 409);
  ok('变化类别含 waiting', r.data.changedCategories.includes('waiting'), r.data.changedCategories);

  // 8d 扳动道岔（实际位置不进修订标识）不使预览过期
  p = await preview(admin, [{ op: 'create', routeId: 'RST4', route: {
    origin: 'a', destination: 'b', steps: ['1'],
    switchReqs: [{ switchId: 'SW7', position: 'R' }] } }]);
  await api('/api/switches/SW7/move', { token: jia, method: 'POST', body: { position: 'R' } });
  r = await publish(admin, [{ op: 'create', routeId: 'RST4', route: {
    origin: 'a', destination: 'b', steps: ['1'],
    switchReqs: [{ switchId: 'SW7', position: 'R' }] } }], p.data.revision);
  eq('扳道岔后仍可发布（位置不进修订标识）', r.status, 200);
  await api('/api/switches/SW7/move', { token: jia, method: 'POST', body: { position: 'N' } });

  console.log('\n[9] 有开放进路：预览列阻断原因，发布 409');
  let op = await api('/api/routes/R1/open', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
  eq('R1 开放（排路接口仍可用）', op.status, 200);
  const instId = op.data.instance.id;
  r = await preview(admin, [{ op: 'create', routeId: 'ROPEN', route: {
    origin: 'a', destination: 'b', steps: ['1'] } }]);
  eq('有开放进路时预览仍 200（只读）', r.status, 200);
  eq('阻断原因含开放进路',
    r.data.blockReasons.some((b) => b.code === 'OPEN_INSTANCES_EXIST'), true);
  eq('有开放进路不可发布', r.data.publishable, false);
  const blockedRev = r.data.revision;
  r = await publish(admin, [{ op: 'create', routeId: 'ROPEN', route: {
    origin: 'a', destination: 'b', steps: ['1'] } }], blockedRev);
  eq('有开放进路发布 409', r.status, 409);
  eq('开放进路错误码', r.data.code, 'OPEN_INSTANCES_EXIST');
  // 走完解除后用同标识发布成功（解除后等待/定义未变；走行不进修订标识）
  await walkThrough(jia, instId, ['1', '3', '5']);
  r = await publish(admin, [{ op: 'create', routeId: 'ROPEN', route: {
    origin: 'a', destination: 'b', steps: ['1'] } }], blockedRev);
  eq('进路解除后发布成功', r.status, 200);

  console.log('\n[10] 删除进路：清理已解除历史实例（沿用单条删除规则）');
  await api('/api/switches/SW7/move', { token: jia, method: 'POST', body: { position: 'R' } });
  await api('/api/switches/SW8/move', { token: jia, method: 'POST', body: { position: 'R' } });
  op = await api('/api/routes/R3/open', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'R', SW8: 'R' } } });
  eq('R3 开放', op.status, 200);
  const instR3 = op.data.instance.id;
  await walkThrough(jia, instR3, ['2', '4', '3', '5']);
  st = await getState(jia);
  ok('删除前 recentReleased 含 R3 实例',
    st.recentReleased.some((x) => x.id === instR3 && x.routeId === 'R3'));
  r = await preview(admin, [{ op: 'delete', routeId: 'R3' }]);
  eq('删除批预览合法', r.data.valid, true);
  r = await publish(admin, [{ op: 'delete', routeId: 'R3' }], r.data.revision);
  eq('删除 R3 发布 200', r.status, 200);
  st = await getState(jia);
  eq('R3 定义已删除', st.routes.some((x) => x.id === 'R3'), false);
  ok('R3 历史实例已清理', !st.recentReleased.some((x) => x.id === instR3));
  await api('/api/switches/SW7/move', { token: jia, method: 'POST', body: { position: 'N' } });
  await api('/api/switches/SW8/move', { token: jia, method: 'POST', body: { position: 'N' } });

  console.log('\n[11] 暂停副本：可预览、发布被拒；恢复后发布且与原站场隔离');
  r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '变更集暂停副本' } });
  eq('创建副本 201', r.status, 201);
  const copyId = r.data.yard.id;
  await api('/api/auth/yard', { token: admin, method: 'PUT', body: { yardId: copyId } });
  await api('/api/admin/yards/current/pause', { token: admin, method: 'POST' });
  const copyBatch = [{ op: 'create', routeId: 'RCOPY', route: {
    origin: 'a', destination: 'b', steps: ['1'] } }];
  r = await preview(admin, copyBatch);
  eq('暂停副本预览 200', r.status, 200);
  ok('暂停预览阻断原因含 YARD_PAUSED',
    r.data.blockReasons.some((b) => b.code === 'YARD_PAUSED'), r.data.blockReasons);
  eq('暂停副本不可发布', r.data.publishable, false);
  r = await publish(admin, copyBatch, r.data.revision);
  eq('暂停副本发布 409 YARD_PAUSED', r.status, 409);
  eq('暂停错误码', r.data.code, 'YARD_PAUSED');
  // 恢复后用同一修订标识发布（暂停/恢复不改变业务修订标识）
  const pausedRev = (await preview(admin, copyBatch)).data.revision;
  await api('/api/admin/yards/current/resume', { token: admin, method: 'POST' });
  r = await publish(admin, copyBatch, pausedRev);
  eq('恢复后发布 200', r.status, 200);
  // 切回原站场：副本新增的 RCOPY 不可见
  await api('/api/auth/yard', { token: admin, method: 'PUT', body: { yardId: 1 } });
  st = await getState(jia);
  eq('原站场看不到副本进路 RCOPY', st.routes.some((x) => x.id === 'RCOPY'), false);

  console.log('\n[12] 服务重启：修订标识稳定，旧预览仍可发布');
  const finalBatch = [{ op: 'create', routeId: 'RRESTART', route: {
    origin: 'a', destination: 'b', steps: ['1', '3'] } }];
  r = await preview(admin, finalBatch);
  eq('重启前预览合法', r.data.valid, true);
  const revBefore = r.data.revision;
  await stopServer();
  await startServer(true);
  const admin2 = await login('admin');
  const jia2 = await login('dispatcher', '值班员甲');
  r = await preview(admin2, finalBatch);
  eq('重启后修订标识一致', r.data.revision, revBefore);
  r = await publish(admin2, finalBatch, revBefore);
  eq('用重启前标识发布成功', r.status, 200);
  st = await getState(jia2);
  ok('RRESTART 已落地', !!st.routes.find((x) => x.id === 'RRESTART'));

  await stopServer();
  console.log(`\n进路批量变更集全部 ${passed} 项断言通过 ✅`);
}

main().catch((e) => {
  console.error('\n❌ 测试失败:', e);
  try { if (server) server.kill('SIGKILL'); } catch (_) {}
  process.exit(1);
});

'use strict';

/**
 * 进路定义批量变更集（管理员一次提交创建/修改/删除多条进路）。
 *
 * 两阶段：
 *  1) previewChangeset：只读预演整批，返回当前站场修订标识（revision）、
 *     逐条结果、每条受影响的等待申请（修改/删除会使相关等待申请失效），
 *     以及发布阻断原因（当前有开放进路、副本已暂停）。预览不写库。
 *  2) publishChangeset：须携带预览得到的 revision；在【同一事务内】
 *     重验整批并重算修订标识——批内编号重复、创建重名、修改/删除指向
 *     不存在的进路、区段顺序重复、引用的区段/道岔/信号机不存在，任一
 *     不合法整批回滚（等待申请保持原状）；预览后定义/引用资源/等待申请
 *     发生变化（修订标识不符）、有开放进路、副本暂停，同样拒绝发布。
 *
 * 成功时仅变更所列进路，沿用现有单条编辑的规则：相关等待申请失效、
 * 删除进路时清理其已解除历史实例（开放实例不可能存在，发布前已拒绝）；
 * 不改变区段占用、锁闭及其他站场。事务提交后按现有规则触发等待兑现重试。
 *
 * 修订标识 = 三段 SHA-256 摘要（definitions / resources / waiting），
 * 发布时据此指出预览后变化的类别：站场定义、引用资源、等待申请。
 */

const crypto = require('crypto');
const { getDb, currentYardId } = require('./db');
const { InterlockError } = require('./interlocking');
const waiting = require('./waiting');
const pause = require('./pause');

const ID_RE = /^[A-Za-z0-9_一-龥-]{1,20}$/;
const MAX_CHANGES = 200;

function hash16(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function canonical(value) {
  // 参与摘要的数据全部由本模块按确定顺序/显式字段构造，
  // JSON.stringify 对数组/按插入顺序构造的对象是确定的。
  return JSON.stringify(value);
}

/* ------------------------------ 修订标识 ------------------------------ */

function definitionsDigest(db) {
  const routes = db.prepare(`SELECT id,label,origin,destination,entry_signal_id
                             FROM routes ORDER BY id`).all().map((r) => [
    r.id, r.label, r.origin, r.destination, r.entry_signal_id || null,
    db.prepare(`SELECT section_id FROM route_steps WHERE route_id=? ORDER BY step_order`)
      .all(r.id).map((s) => s.section_id),
    db.prepare(`SELECT switch_id,req_position FROM route_switch_reqs
                 WHERE route_id=? ORDER BY switch_id`)
      .all(r.id).map((q) => [q.switch_id, q.req_position])
  ]);
  return hash16(canonical(routes));
}

function resourcesDigest(db) {
  // 仅纳入引用有效性相关的结构字段：区段占用状态与道岔实际位置不参与
  // （它们不影响变更集合法性，不应使预览失效）。
  const sections = db.prepare(
    `SELECT id,label,x1,y1,x2,y2 FROM sections ORDER BY id`
  ).all().map((s) => [s.id, s.label, s.x1, s.y1, s.x2, s.y2]);
  const switches = db.prepare(
    `SELECT id,label,x,y,nx1,ny1,nx2,ny2,rx1,ry1,rx2,ry2 FROM switches ORDER BY id`
  ).all().map((s) => [s.id, s.label, s.x, s.y, s.nx1, s.ny1, s.nx2, s.ny2,
    s.rx1, s.ry1, s.rx2, s.ry2]);
  const signals = db.prepare(
    `SELECT id,label,x,y,direction FROM signals ORDER BY id`
  ).all().map((s) => [s.id, s.label, s.x, s.y, s.direction]);
  return hash16(canonical({ sections, switches, signals }));
}

function waitingDigest(db) {
  // 等待申请快照（含阻断原因等全部状态）：等待申请的任何变化都拒绝基于旧预览发布。
  const rows = db.prepare(
    `SELECT id,route_id,applicant,switch_positions,status,instance_id,
            block_reasons,blocked_by,end_reason,created_at,ended_at
       FROM waiting_applications ORDER BY id`
  ).all().map((r) => [r.id, r.route_id, r.applicant, r.switch_positions, r.status,
    r.instance_id, r.block_reasons, r.blocked_by, r.end_reason, r.created_at, r.ended_at]);
  return hash16(canonical(rows));
}

/** 当前站场修订标识（三段：定义/引用资源/等待申请） */
function computeRevision(db = getDb()) {
  const d = definitionsDigest(db);
  const r = resourcesDigest(db);
  const w = waitingDigest(db);
  return { revision: `rc1.${d}.${r}.${w}`, segments: { definitions: d, resources: r, waiting: w } };
}

function parseRevision(token) {
  if (typeof token !== 'string') return null;
  const m = /^rc1\.([0-9a-f]{16})\.([0-9a-f]{16})\.([0-9a-f]{16})$/.exec(token.trim());
  if (!m) return null;
  return { definitions: m[1], resources: m[2], waiting: m[3] };
}

/* ------------------------------ 变更解析与校验 ------------------------------ */

function waitingAppsForRoute(db, routeId, op) {
  const actionText = op === 'delete' ? '删除' : '批量变更集修改';
  return db.prepare(
    `SELECT id,route_id,applicant,status,block_reasons FROM waiting_applications
      WHERE route_id=? AND status='waiting' ORDER BY id`
  ).all(routeId).map((r) => ({
    id: r.id, routeId: r.route_id, applicant: r.applicant, status: r.status,
    effect: 'invalidate',
    reason: `进路 ${routeId} 定义将被${actionText}，相关等待申请将失效`
  }));
}

/**
 * 校验并"应用"一批变更到内存中的虚拟站场状态（不写库）。
 * @returns {{items:Array, values:Map, valid:boolean, affectedWaiting:Array}}
 *   items 为逐条结果（含 errors/affectedWaiting），values 为有效 create/update
 *   的规范化定义值（按条目下标），affectedWaiting 为修改/删除条目受影响等待的并集。
 */
function evaluateChanges(db, changes) {
  const existing = new Map(db.prepare(`SELECT id FROM routes`).all().map((r) => [r.id, true]));
  const knownSections = new Set(db.prepare(`SELECT id FROM sections`).all().map((s) => s.id));
  const knownSwitches = new Set(db.prepare(`SELECT id FROM switches`).all().map((s) => s.id));
  const knownSignals = new Set(db.prepare(`SELECT id FROM signals`).all().map((s) => s.id));

  // 批内每个进路编号的全部出现位置（批内编号不得重复）
  const occurrences = new Map();
  (changes || []).forEach((c, index) => {
    const id = c && (c.routeId != null ? c.routeId : c.id);
    if (id != null && String(id).trim()) {
      const key = String(id).trim();
      if (!occurrences.has(key)) occurrences.set(key, []);
      occurrences.get(key).push(index);
    }
  });

  const items = [];
  const validItems = [];

  changes.forEach((change, index) => {
    const op = change && typeof change === 'object' ? change.op || change.operation : null;
    const rawId = change && (change.routeId != null ? change.routeId : change.id);
    const id = rawId != null ? String(rawId).trim() : '';
    const item = {
      index,
      op: ['create', 'update', 'delete'].includes(op) ? op : (op || null),
      routeId: id || null,
      valid: true,
      errors: [],
      affectedWaiting: []
    };
    const fail = (message) => { item.valid = false; item.errors.push(message); };

    if (!['create', 'update', 'delete'].includes(op)) {
      fail(`操作类型 op 必须是 create、update 或 delete（收到 ${JSON.stringify(op)}）`);
      items.push(item);
      return;
    }
    if (!id) {
      fail(`${op === 'create' ? '创建' : op === 'update' ? '修改' : '删除'}进路缺少进路编号 routeId`);
      items.push(item);
      return;
    }
    if (!ID_RE.test(id)) fail('进路编号需为 1~20 位字母数字/下划线/中文');

    // 批内编号不得重复
    if ((occurrences.get(id) || []).length > 1) {
      fail(`批内进路编号重复：编号 ${id} 在变更集中出现 ${occurrences.get(id).length} 次` +
        `（位置 ${occurrences.get(id).join('、')}），每批同一进路至多一条变更`);
    }

    // 现状（批内前序有效操作执行后的状态由 existing 集合即时维护）
    const existsNow = existing.has(id);

    if (op === 'create' && existsNow) fail(`进路 ${id} 已存在，创建不能重名（如需变更请使用 update）`);
    if (op === 'update' && !existsNow) fail(`进路 ${id} 不存在，修改必须指向现有进路`);
    if (op === 'delete' && !existsNow) fail(`进路 ${id} 不存在，删除必须指向现有进路`);

    if (op === 'delete') {
      items.push(item);
      if (item.valid) validItems.push({ item, id, op });
      return;
    }

    // create / update：解析进路定义（字段规则与单条编辑一致）
    const route = change.route && typeof change.route === 'object' ? change.route : change;
    const label = String(route.label != null && route.label !== '' ? route.label : id).trim();
    const origin = String(route.origin || '').trim();
    const destination = String(route.destination || '').trim();
    if (!origin || !destination) fail('进路必须填写起点 origin 和终点 destination');

    const steps = Array.isArray(route.steps) ? route.steps.map((s) => String(s)) : [];
    if (steps.length === 0) {
      fail('进路至少包含一个区段 steps');
    } else if (new Set(steps).size !== steps.length) {
      const dup = [...new Set(steps.filter((s, i) => steps.indexOf(s) !== i))];
      fail(`进路区段顺序不得重复（重复区段：${dup.join('、')}）`);
    }

    const switchReqs = [];
    if (route.switchReqs != null && !Array.isArray(route.switchReqs)) {
      fail('道岔位置要求 switchReqs 必须是数组，格式为 [{switchId, position: N|R}]');
    } else {
      const seen = new Set();
      for (const r of (route.switchReqs || [])) {
        if (!r || !r.switchId || !['N', 'R'].includes(r.position)) {
          fail('道岔位置要求格式为 {switchId, position: N|R}，位置只能是 N 或 R');
          continue;
        }
        const sid = String(r.switchId);
        if (seen.has(sid)) {
          fail(`道岔位置要求中道岔 ${sid} 重复出现`);
          continue;
        }
        seen.add(sid);
        switchReqs.push({ switchId: sid, position: r.position });
      }
    }

    const entrySignalId = route.entrySignalId ? String(route.entrySignalId).trim() : null;

    // 引用资源必须存在（引用的是站场现有资源；本批只改进路定义，不增删资源）
    for (const sid of new Set(steps)) {
      if (!knownSections.has(sid)) fail(`进路引用了不存在的区段 ${sid}`);
    }
    for (const r of switchReqs) {
      if (!knownSwitches.has(r.switchId)) fail(`进路引用了不存在的道岔 ${r.switchId}`);
    }
    if (entrySignalId && !knownSignals.has(entrySignalId)) {
      fail(`进路入口信号机 ${entrySignalId} 不存在`);
    }

    items.push(item);
    if (item.valid) {
      validItems.push({
        item, id, op,
        value: { id, label, origin, destination, entrySignalId, steps, switchReqs }
      });
    }
  });

  // 逐条按批内顺序应用：维护现有进路集合，计算每条受影响的等待申请
  // （预览展示的是"当前库 + 本批变更"下的结果）。
  const affectedByRoute = new Map();
  for (const v of validItems) {
    if (v.op === 'create') {
      existing.set(v.id, true);
      v.item.affectedWaiting = [];
    } else {
      const apps = waitingAppsForRoute(db, v.id, v.op);
      v.item.affectedWaiting = apps;
      affectedByRoute.set(v.id, apps);
      if (v.op === 'delete') existing.delete(v.id);
    }
  }

  return {
    items,
    values: new Map(validItems.map((v) => [v.item.index, v.value || null])),
    valid: items.every((i) => i.valid),
    affectedWaiting: [...affectedByRoute.values()].flat()
  };
}

/* ------------------------------ 预览（只读） ------------------------------ */

/**
 * 预览一批进路变更：不写库。返回修订标识、逐条结果、受影响等待申请汇总
 * 与发布阻断原因（开放进路 / 暂停副本）。
 */
function previewChangeset(rawBody) {
  const db = getDb();
  const changes = normalizeChanges(rawBody);

  const { items, valid, affectedWaiting } = evaluateChanges(db, changes);

  const blockReasons = [];
  const openCount = db.prepare(`SELECT COUNT(*) AS n FROM route_instances WHERE status='open'`).get().n;
  if (openCount > 0) {
    blockReasons.push({
      code: 'OPEN_INSTANCES_EXIST',
      message: `当前站场存在 ${openCount} 条已开放进路，锁闭期间不能修改进路定义，请待全部进路解除后再发布`
    });
  }
  if (pause.isPaused(currentYardId())) {
    blockReasons.push({
      code: 'YARD_PAUSED',
      message: '当前命名演练副本已暂停，暂停期间不能发布站场编辑；请由管理员恢复后再发布'
    });
  }

  const rev = computeRevision(db);
  return {
    revision: rev.revision,
    valid,
    items,
    affectedWaiting,
    affectedCounts: {
      waitingToInvalidate: affectedWaiting.length,
      byRoute: countByRoute(affectedWaiting)
    },
    blockReasons,
    publishable: valid && blockReasons.length === 0,
    counts: summarizeItems(items)
  };
}

function countByRoute(apps) {
  const m = new Map();
  for (const a of apps) m.set(a.routeId, (m.get(a.routeId) || 0) + 1);
  return Object.fromEntries([...m.entries()].map(([k, v]) => [k, v]));
}

function summarizeItems(items) {
  const counts = { create: 0, update: 0, delete: 0, invalid: 0 };
  for (const i of items) {
    if (i.op && counts[i.op] != null) counts[i.op]++;
    if (!i.valid) counts.invalid++;
  }
  return counts;
}

function normalizeChanges(rawBody) {
  const changes = rawBody && rawBody.changes;
  if (!Array.isArray(changes)) {
    throw new InterlockError(400, 'CHANGESET_CHANGES_REQUIRED',
      '请求体必须包含 changes 数组，每项形如 {op:"create|update|delete", routeId:"R1", route:{...}}');
  }
  if (changes.length === 0) {
    throw new InterlockError(400, 'CHANGESET_EMPTY', '变更集为空：至少提交一条创建/修改/删除变更');
  }
  if (changes.length > MAX_CHANGES) {
    throw new InterlockError(400, 'CHANGESET_TOO_LARGE',
      `变更集一次最多 ${MAX_CHANGES} 条变更，本次 ${changes.length} 条`);
  }
  return changes;
}

/* ------------------------------ 发布（单事务重验） ------------------------------ */

/**
 * 携带预览修订标识发布变更集。整个重验与落地在单个 SQLite 事务内：
 * 任一条不合法或修订标识变化/有开放进路即整体回滚，等待申请保持原状。
 * @returns {Object} 发布结果（修订标识、逐条结果、失效等待与兑现结果）
 */
function publishChangeset(rawBody, operator) {
  const db = getDb();
  const changes = normalizeChanges(rawBody);

  let result;
  const txn = db.transaction(() => {
    // 1) 修订标识：预览后定义/引用资源/等待申请是否变化
    const current = computeRevision(db);
    const provided = rawBody && rawBody.revision;
    if (provided == null || String(provided).trim() === '') {
      throw new InterlockError(409, 'CHANGESET_REVISION_REQUIRED',
        '发布必须携带预览返回的当前站场修订标识 revision，请先调用预览接口');
    }
    const expected = parseRevision(provided);
    if (!expected) {
      throw new InterlockError(409, 'CHANGESET_REVISION_STALE',
        '携带的修订标识无法识别，请重新调用预览接口获取当前站场修订标识后再发布',
        { changedCategories: ['definitions', 'resources', 'waiting'] });
    }
    const changedCategories = [];
    if (current.segments.definitions !== expected.definitions) changedCategories.push('definitions');
    if (current.segments.resources !== expected.resources) changedCategories.push('resources');
    if (current.segments.waiting !== expected.waiting) changedCategories.push('waiting');
    if (changedCategories.length) {
      throw new InterlockError(409, 'CHANGESET_REVISION_STALE',
        '预览结果已过期：预览后站场' + categoryText(changedCategories) +
        '发生了变化，请重新预览后再发布（本次未写入任何变更）',
        { changedCategories });
    }

    // 2) 有开放进路一律拒绝（与单条编辑同一把锁）
    const openCount = db.prepare(`SELECT COUNT(*) AS n FROM route_instances WHERE status='open'`).get().n;
    if (openCount > 0) {
      throw new InterlockError(409, 'OPEN_INSTANCES_EXIST',
        `存在 ${openCount} 条已开放进路，锁闭期间不能修改进路定义，请待进路解除后再操作`);
    }

    // 3) 同事务内重验整批
    const evaluation = evaluateChanges(db, changes);
    if (!evaluation.valid) {
      throw new InterlockError(409, 'CHANGESET_INVALID',
        '变更集存在不合法条目，整批未落地：\n' +
        evaluation.items.filter((i) => !i.valid)
          .map((i) => `  · [#${i.index} ${i.op || '?'} ${i.routeId || '?'}] ${i.errors.join('；')}`)
          .join('\n'),
        { items: evaluation.items });
    }

    // 4) 全部合法：按提交顺序落地，仅变更所列进路
    const invalidatedIds = [];
    changes.forEach((change, index) => {
      const item = evaluation.items[index];
      const id = item.routeId;
      if (item.op === 'create' || item.op === 'update') {
        const value = evaluation.values.get(index);
        if (item.op === 'create') {
          db.prepare(`INSERT INTO routes(id,label,origin,destination,entry_signal_id)
                      VALUES(@id,@label,@origin,@destination,@entrySignalId)`).run(value);
        } else {
          db.prepare(`UPDATE routes SET label=@label,origin=@origin,destination=@destination,
                      entry_signal_id=@entrySignalId WHERE id=@id`).run(value);
          db.prepare(`DELETE FROM route_steps WHERE route_id=?`).run(id);
          db.prepare(`DELETE FROM route_switch_reqs WHERE route_id=?`).run(id);
        }
        value.steps.forEach((sid, i) =>
          db.prepare(`INSERT INTO route_steps(route_id,step_order,section_id) VALUES(?,?,?)`)
            .run(id, i + 1, sid));
        value.switchReqs.forEach((r) =>
          db.prepare(`INSERT INTO route_switch_reqs(route_id,switch_id,req_position) VALUES(?,?,?)`)
            .run(id, r.switchId, r.position));
        if (item.op === 'update') {
          // 定义变更：该进路既有等待申请全部失效（沿用单条编辑规则，同一事务）
          const before = waitingAppsForRoute(db, id, 'update');
          waiting.invalidateByRouteChange(id,
            `管理员通过批量变更集修改了进路 ${id} 的定义，原等待申请失效`);
          before.forEach((a) => invalidatedIds.push(a.id));
        }
      } else {
        // delete：清理已解除历史实例后删除定义，相关等待申请同事务失效
        const before = waitingAppsForRoute(db, id, 'delete');
        db.prepare(`DELETE FROM route_instances WHERE route_id=? AND status='released'`).run(id);
        const info = db.prepare(`DELETE FROM routes WHERE id=?`).run(id);
        if (info.changes === 0) {
          throw new InterlockError(404, 'ROUTE_NOT_FOUND', `进路 ${id} 不存在`);
        }
        waiting.invalidateByRouteDelete(id);
        before.forEach((a) => invalidatedIds.push(a.id));
      }
    });

    result = {
      published: true,
      operator: operator || null,
      revision: computeRevision(db).revision,
      items: evaluation.items,
      counts: summarizeItems(evaluation.items),
      invalidatedWaiting: invalidatedIds,
      affectedWaiting: evaluation.affectedWaiting.map((a) => ({ ...a, status: 'invalid' }))
    };
  });

  txn();

  // 失效的是前项时后项可能因此可以兑现（事务外按现有规则重试）
  let fulfilled = [];
  try {
    const sweep = waiting.sweepFulfillments('route_changeset_published');
    fulfilled = sweep.fulfilled;
  } catch (e) {
    console.error('[route-changeset] 发布后等待兑现扫描失败:', e);
  }
  result.fulfilledWaiting = fulfilled;
  result.revision = computeRevision().revision;
  return result;
}

function categoryText(categories) {
  const map = { definitions: '进路定义', resources: '引用的区段/道岔/信号机', waiting: '等待申请' };
  const texts = categories.map((c) => map[c]);
  return texts.length === 1
    ? texts[0]
    : texts.slice(0, -1).join('、') + '或' + texts[texts.length - 1];
}

module.exports = {
  computeRevision,
  parseRevision,
  previewChangeset,
  publishChangeset
};

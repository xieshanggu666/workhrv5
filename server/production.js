import { db } from './db.js'

// 取杂交作物的母本原生作物 id；原生作物返回自身（与 server/breeding.js 同逻辑，
// 此处不互相 import 以避免育种模块未来依赖加工模块时形成循环）
function baseIdOf(cropId) {
  return db.prepare('SELECT base_id FROM varieties WHERE crop_id=?').get(cropId)?.base_id || Number(cropId)
}

// 配方需要的原料可能是「某原生作物的任意品种」：fromBase 指定母本原生作物 id，
// 杂交培育出的新品种只要母本匹配即可加工，贯通育种 → 加工链路
function recipeAccepts(recipe, itemId) {
  if (itemId === recipe.from) return true
  if (recipe.fromBase != null) {
    const m = /^crop-(\d+)$/.exec(itemId)
    if (m && baseIdOf(Number(m[1])) === recipe.fromBase) return true
  }
  return false
}

// ===== 配方表（以服务端为准，前端仅做展示）=====
// days：每批耗时（游戏天）；needLv：加工坊等级要求
export const RECIPES = [
  {
    id: 'flour', name: '面粉', icon: '🍞',
    from: 'crop-5', fromBase: 5, fromName: '小麦', fromIcon: '🌾', fromCat: 'crop',
    consume: 2, result: 'flour', resultName: '面粉', resultCat: 'material',
    gain: 1, days: 1, needLv: 1
  },
  {
    id: 'juice', name: '番茄汁', icon: '🧃',
    from: 'crop-2', fromBase: 2, fromName: '番茄', fromIcon: '🍅', fromCat: 'crop',
    consume: 2, result: 'juice', resultName: '番茄汁', resultCat: 'product',
    gain: 1, days: 1, needLv: 1
  },
  {
    id: 'cheese', name: '奶酪', icon: '🧀',
    from: 'p-cow', fromName: '牛奶', fromIcon: '🥛', fromCat: 'product',
    consume: 2, result: 'cheese', resultName: '奶酪', resultCat: 'product',
    gain: 1, days: 2, needLv: 1
  },
  {
    id: 'bread', name: '面包', icon: '🥖',
    from: 'flour', fromName: '面粉', fromIcon: '🍞', fromCat: 'material',
    consume: 2, result: 'bread', resultName: '面包', resultCat: 'product',
    gain: 1, days: 2, needLv: 2
  },
  {
    id: 'wool', name: '毛线', icon: '🧵',
    from: 'p-sheep', fromName: '羊毛', fromIcon: '🧶', fromCat: 'product',
    consume: 1, result: 'wool', resultName: '毛线', resultCat: 'product',
    gain: 1, days: 1, needLv: 3
  },
  {
    id: 'popcorn', name: '烤玉米', icon: '🍿',
    from: 'crop-3', fromBase: 3, fromName: '玉米', fromIcon: '🌽', fromCat: 'crop',
    consume: 2, result: 'popcorn', resultName: '烤玉米', resultCat: 'product',
    gain: 1, days: 1, needLv: 4
  },
  {
    id: 'pickle', name: '泡菜', icon: '🥬',
    from: 'crop-6', fromBase: 6, fromName: '白菜', fromIcon: '🥬', fromCat: 'crop',
    consume: 3, result: 'pickle', resultName: '泡菜', resultCat: 'product',
    gain: 2, days: 2, needLv: 5
  }
]

export function getRecipe(id) {
  return RECIPES.find((r) => r.id === id) || null
}

// 队列容量：加工坊等级越高，同时排队的批次越多
export function capacity(millLevel = 1) {
  return 2 + millLevel * 2
}

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// 配方可用库存：同一母本的所有品种作物合计（如各品种小麦都能磨面粉）
function stockOfRecipe(r) {
  return q('SELECT item_id,qty FROM inventory').reduce(
    (s, it) => s + (recipeAccepts(r, it.item_id) ? it.qty : 0), 0
  )
}
// 按 FIFO 从匹配配方的库存堆中扣料（杂交品种先熟先扣）
function consumeForRecipe(r, need) {
  const stacks = q('SELECT id,item_id,qty FROM inventory ORDER BY id')
    .filter((it) => recipeAccepts(r, it.item_id))
  let remain = need
  for (const s of stacks) {
    const take = Math.min(remain, s.qty)
    if (take > 0) {
      run('UPDATE inventory SET qty=qty-? WHERE id=?', take, s.id)
      remain -= take
    }
    if (remain <= 0) break
  }
  cleanEmpty()
  return remain === 0
}
function addInv(itemId, name, cat, n) {
  const row = q1('SELECT qty FROM inventory WHERE item_id=?', itemId)
  if (row) run('UPDATE inventory SET qty=qty+? WHERE item_id=?', n, itemId)
  else run('INSERT INTO inventory (item_id,name,cat,qty) VALUES (?,?,?,?)', itemId, name, cat, n)
}
function cleanEmpty() {
  db.exec('DELETE FROM inventory WHERE qty<=0')
}

// 截至 absAbs 时，某工单已完工的批次数（取消后不再增加）
function finishedBatchesAt(j, atAbs) {
  const stop = j.cancel_abs == null ? Infinity : j.cancel_abs
  const eff = Math.min(atAbs, stop)
  return Math.min(j.qty, Math.max(0, Math.floor((eff - j.start) / j.days)))
}

// 截至 absAbs 时，某工单已开工的批次数（正在加工中的批次也算开工，原料不可退）
function startedBatchesAt(j, atAbs) {
  const stop = j.cancel_abs == null ? Infinity : j.cancel_abs
  const eff = Math.min(atAbs, stop)
  return Math.min(j.qty, Math.max(0, Math.floor((eff - j.start) / j.days) + 1))
}

// 队列重放：加工坊只有一台机器，按工单创建顺序串行加工，算出每个工单
//   start  —— 首批开工绝对日（当天 00:00 即可开工）
//   finish —— 全部批次完工的绝对日（用于预估还剩几天）
// 取消的工单在 cancel_abs 立刻让出机器，后续工单自动提前；
// 尚未开工就被取消的工单从未占用机器，游标不得回退（否则后续工单会排到过去、提前产出）。
function replay(jobs) {
  let cursor = 0
  for (const j of jobs) {
    const start = Math.max(cursor, j.enqueue_abs)
    j.start = start
    const stop = j.cancel_abs == null ? Infinity : j.cancel_abs
    let finish = start
    for (let b = 0; b < j.qty; b++) {
      const bEnd = start + (b + 1) * j.days
      if (bEnd > stop) break
      finish = bEnd
    }
    if (j.cancel_abs == null) {
      j.finish = finish
      cursor = finish
    } else if (start < stop) {
      // 取消时已有批次开工（可能正加工到一半）：机器一直占用到取消时刻才让出
      j.finish = stop
      cursor = stop
    } else {
      // 取消时还没轮到开工：这张工单没碰过机器，游标保持不动
      j.finish = start
    }
  }
  return jobs
}

// 全部工单重放（含已取消/已入库——它们历史上占用过机器时间，影响后续工单排期）
function allJobs() {
  return replay(q('SELECT * FROM production_jobs ORDER BY id'))
}

// 当前在队（未领走）的工单 + 动态状态
export function listJobs(currentAbs) {
  const jobs = []
  for (const j of allJobs()) {
    if (j.status === 'collected') continue
    j.doneBatches = finishedBatchesAt(j, currentAbs)
    // 已全部退料的取消工单没有可领成品，直接出队
    if (j.status === 'canceled' && j.doneBatches === 0) continue
    j.startedBatches = j.status === 'canceled'
      ? startedBatchesAt(j, j.cancel_abs)
      : startedBatchesAt(j, currentAbs)
    // 取消时实际退料的批次数 = 取消时点尚未开工的批次
    j.refundedBatches = j.status === 'canceled' ? Math.max(0, j.qty - j.startedBatches) : 0
    j.waitingBatches = j.status === 'running' ? j.qty - j.doneBatches : 0
    j.computedStatus = j.status === 'running'
      ? (j.doneBatches >= j.qty ? 'done' : 'running')
      : j.status
    j.remainDays = j.computedStatus === 'running'
      ? Math.max(0, j.finish - currentAbs)
      : 0
    jobs.push(j)
  }
  return jobs
}

// 在队批次占用（用于容量限制，已取消/已全部完工的工单不再占坑）
export function queuedBatches(currentAbs) {
  return listJobs(currentAbs)
    .filter((j) => j.computedStatus === 'running')
    .reduce((s, j) => s + j.waitingBatches, 0)
}

// 推进游戏天时结算：把跨天完工的批次落库（幂等：finished 只增不减），
// 返回完工日志。toAbs 为结算后的绝对日。
// 注意：本函数在 advanceDay 的事务内调用，不再另开事务。
export function settleProduction(toAbs) {
  const logs = []
  for (const j of allJobs()) {
    if (j.status !== 'running') continue
    const done = finishedBatchesAt(j, toAbs)
    if (done > j.finished) {
      const add = done - j.finished
      const status = done >= j.qty ? 'done' : 'running'
      run('UPDATE production_jobs SET finished=?, status=? WHERE id=?', done, status, j.id)
      logs.push(`✅ ${j.recipe_name} 新完工 ${add} 批（共 ${done}/${j.qty}），可去加工坊入库`)
    }
  }
  return logs
}

// 批量排产：一个配方一次下 n 批；原料当场全部扣走
export function enqueueJob({ recipeId, qty, millLevel, currentAbs }) {
  const r = getRecipe(recipeId)
  if (!r) throw Object.assign(new Error('配方不存在'), { status: 404 })
  const n = Math.max(1, Math.min(Math.floor(Number(qty) || 1), 99))
  if (millLevel < r.needLv) throw Object.assign(new Error('加工坊等级不足'), { status: 400 })
  const used = queuedBatches(currentAbs)
  if (used + n > capacity(millLevel)) {
    throw Object.assign(new Error(`队列已满（${used}/${capacity(millLevel)} 批），等工单完工或取消一些再排产`), { status: 400 })
  }
  const need = r.consume * n
  if (stockOfRecipe(r) < need) throw Object.assign(new Error(`原料不足：需要 ${r.fromName} ×${need}`), { status: 400 })
  db.exec('BEGIN IMMEDIATE')
  try {
    if (!consumeForRecipe(r, need)) throw Object.assign(new Error(`原料不足：需要 ${r.fromName} ×${need}`), { status: 400 })
    const res = run(
      `INSERT INTO production_jobs
       (recipe_id,recipe_name,result_id,result_name,result_cat,from_id,from_name,from_cat,
        consume,gain,days,qty,finished,enqueue_abs,status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,'running')`,
      r.id, r.name, r.result, r.resultName, r.resultCat,
      r.from, r.fromName, r.fromCat, r.consume, r.gain, r.days, n, currentAbs
    )
    db.exec('COMMIT')
    return { ok: true, id: res.lastInsertRowid }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}

// 取消工单：退还尚未开工批次的原料；已开工（含加工中）批次不退料，
// 已完工批次保留成品待入库，加工中批次随取消作废。
export function cancelJob({ id, currentAbs }) {
  const j = q1('SELECT * FROM production_jobs WHERE id=?', id)
  if (!j) throw Object.assign(new Error('工单不存在'), { status: 404 })
  if (j.status !== 'running') throw Object.assign(new Error('该工单已结束，无法取消'), { status: 400 })

  const cur = allJobs().find((x) => x.id === id)
  const finishedBatches = finishedBatchesAt(cur, currentAbs)
  // 正在加工的批次已投入原料、尚未产出，取消即作废；只退还没开工的批次
  const startedBatches = startedBatchesAt(cur, currentAbs)
  const refundBatches = Math.max(0, j.qty - startedBatches)

  db.exec('BEGIN IMMEDIATE')
  try {
    run('UPDATE production_jobs SET status=\'canceled\', cancel_abs=?, finished=? WHERE id=?',
      currentAbs, finishedBatches, id)
    if (refundBatches > 0) addInv(j.from_id, j.from_name, j.from_cat, j.consume * refundBatches)
    db.exec('COMMIT')
    return { ok: true, refundBatches, finishedBatches }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}

// 完工入库：领取指定工单成品；不传 id 则一键领取全部待入库工单
export function collectJobs(currentAbs, id = null) {
  const rows = id
    ? q("SELECT * FROM production_jobs WHERE id=? AND status!='collected'", id)
    : q("SELECT * FROM production_jobs WHERE status!='collected' ORDER BY id")
  if (!rows.length) throw Object.assign(new Error('没有可入库的工单'), { status: 400 })

  const byId = new Map(allJobs().map((j) => [j.id, j]))

  const picked = []
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const j of rows) {
      const batches = finishedBatchesAt(byId.get(j.id), currentAbs)
      // 只有全部完工或已取消的工单才能入库（在制工单按整单领取，避免丢批次）
      const settled = j.status === 'canceled' || batches >= j.qty
      if (!settled || batches <= 0) {
        if (id) {
          throw Object.assign(
            new Error(batches <= 0 ? '该工单尚无完工批次' : '工单尚未全部完工，完工后才能入库'),
            { status: 400 }
          )
        }
        continue
      }
      addInv(j.result_id, j.result_name, j.result_cat, j.gain * batches)
      run("UPDATE production_jobs SET status='collected' WHERE id=?", j.id)
      picked.push({ name: j.result_name, qty: j.gain * batches })
    }
    if (!picked.length) throw Object.assign(new Error('没有可入库的成品'), { status: 400 })
    db.exec('COMMIT')
    return { ok: true, picked }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}

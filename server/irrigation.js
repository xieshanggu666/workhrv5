import { db } from './db.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 灌溉参数 =====
export const COSTS = { reservoir: 60, canal: 8 }   // 建造花费（金币）
export const RESERVOIR_CAP = 150                   // 蓄水池容量
export const RESERVOIR_INIT = 50                   // 建成时自带水量
export const DEMOLISH_REFUND = 0.5                 // 拆除返还比例
export const MAP_W = 15                            // 地图格数（900/60）
export const MAP_H = 10                            // 地图格数（620/60 取整）

// 天气对蓄水池的每日影响：正=降雨补水，负=蒸发耗水（负值乘灾害等级）
const WEATHER_WATER = { rain: 35, storm: 50, drought: -15, heatwave: -8 }

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]

// 建筑占地（2x2）不可建灌溉设施
function blockedCells() {
  const blocked = new Set()
  for (const b of q('SELECT x,y FROM buildings')) {
    for (let dx = 0; dx < 2; dx++) {
      for (let dy = 0; dy < 2; dy++) blocked.add(`${b.x + dx},${b.y + dy}`)
    }
  }
  return blocked
}

// 从蓄水池出发沿水渠（4连通）BFS：返回连通的地块 id 与途经的水渠 id
function reachable(res, canals, plots) {
  const canalAt = new Map(canals.map((c) => [`${c.x},${c.y}`, c]))
  const plotAt = new Map(plots.map((p) => [`${p.x},${p.y}`, p]))
  const seen = new Set([`${res.x},${res.y}`])
  const stack = [[res.x, res.y]]
  const plotIds = new Set()
  const canalIds = new Set()
  while (stack.length) {
    const [cx, cy] = stack.pop()
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx
      const ny = cy + dy
      const key = `${nx},${ny}`
      if (seen.has(key)) continue
      const canal = canalAt.get(key)
      if (canal) {
        seen.add(key)
        canalIds.add(canal.id)
        stack.push([nx, ny])
        continue
      }
      const plot = plotAt.get(key)
      if (plot) plotIds.add(plot.id) // 地块与水渠/蓄水池相邻即接通，不再向外延伸
    }
  }
  return { plotIds, canalIds }
}

// 当前供水网络：启用中的蓄水池沿启用中的水渠能到达的 { plotIds, canalIds }
// 停用/拆除的设施不参与，因此断流与恢复都由每日实时重算自然生效
export function networkInfo() {
  const reservoirs = q("SELECT * FROM irrigation WHERE kind='reservoir' AND active=1")
  const canals = q("SELECT * FROM irrigation WHERE kind='canal' AND active=1")
  const plots = q('SELECT id,x,y FROM plots')
  const plotIds = new Set()
  const canalIds = new Set()
  for (const r of reservoirs) {
    const { plotIds: ps, canalIds: cs } = reachable(r, canals, plots)
    ps.forEach((id) => plotIds.add(id))
    cs.forEach((id) => canalIds.add(id))
  }
  return { plotIds, canalIds }
}

// 建造蓄水池/水渠：校验地块、占用与金币，事务落库
export function buildFacility(kind, x, y) {
  if (!COSTS[kind]) throw Object.assign(new Error('未知的设施类型'), { status: 400 })
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) {
    throw Object.assign(new Error('超出可建造范围'), { status: 400 })
  }
  if (q1('SELECT id FROM plots WHERE x=? AND y=?', x, y)) {
    throw Object.assign(new Error('不能建在耕地上，请铺到耕地旁'), { status: 400 })
  }
  if (blockedCells().has(`${x},${y}`)) {
    throw Object.assign(new Error('此处已被建筑占用'), { status: 400 })
  }
  if (q1('SELECT id FROM irrigation WHERE x=? AND y=?', x, y)) {
    throw Object.assign(new Error('此处已有灌溉设施'), { status: 400 })
  }
  const cost = COSTS[kind]
  const p = q1('SELECT gold FROM player WHERE id=1')
  if (p.gold < cost) throw Object.assign(new Error('金币不足'), { status: 400 })
  db.exec('BEGIN IMMEDIATE')
  try {
    run('UPDATE player SET gold=gold-? WHERE id=1', cost)
    const r = run(
      'INSERT INTO irrigation (kind,x,y,active,water) VALUES (?,?,?,1,?)',
      kind, x, y, kind === 'reservoir' ? RESERVOIR_INIT : 0
    )
    db.exec('COMMIT')
    return { ok: true, id: r.lastInsertRowid, cost }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}

// 停用/启用：停用即断流（不再参与供水网络），启用后次日结算自动恢复
export function toggleFacility(id) {
  const f = q1('SELECT * FROM irrigation WHERE id=?', id)
  if (!f) throw Object.assign(new Error('设施不存在'), { status: 404 })
  const active = f.active ? 0 : 1
  run('UPDATE irrigation SET active=? WHERE id=?', active, id)
  return { ok: true, active }
}

// 拆除：返还部分造价，蓄水池余水作废；断流的地块由网络重算自动体现
export function demolishFacility(id) {
  const f = q1('SELECT * FROM irrigation WHERE id=?', id)
  if (!f) throw Object.assign(new Error('设施不存在'), { status: 404 })
  const refund = Math.floor(COSTS[f.kind] * DEMOLISH_REFUND)
  db.exec('BEGIN IMMEDIATE')
  try {
    run('DELETE FROM irrigation WHERE id=?', id)
    if (refund > 0) run('UPDATE player SET gold=gold+? WHERE id=1', refund)
    db.exec('COMMIT')
    return { ok: true, refund }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}

// 逐日结算（在 advanceDay 事务内调用，不另开事务）：
// 1) 天气影响：降雨/暴雨为蓄水池补水，干旱/酷暑加速蒸发
// 2) 供水分配：每个启用蓄水池沿启用水渠找连通地块，
//    按 优先级高→低、同级水分低者优先 的顺序把有限水量分配到地块，耗尽即止
// 3) 干涸断流预警
export function settleIrrigation(weatherType, severity = 0) {
  const logs = []
  const reservoirs = q("SELECT * FROM irrigation WHERE kind='reservoir'")
  if (!reservoirs.length) return logs

  // —— 天气补水/耗水 ——
  const delta = WEATHER_WATER[weatherType] || 0
  if (delta !== 0) {
    const d = delta < 0 ? delta * Math.max(1, severity) : delta
    for (const r of reservoirs) {
      const w = Math.max(0, Math.min(RESERVOIR_CAP, r.water + d))
      if (w !== r.water) run('UPDATE irrigation SET water=? WHERE id=?', w, r.id)
    }
    logs.push(delta > 0
      ? `🌧️ 降水为所有蓄水池补水 +${d}`
      : `🏜️ 干热蒸发，所有蓄水池水量 ${d}`)
  }

  // —— 按连通关系与优先级分配有限水量 ——
  const canals = q("SELECT * FROM irrigation WHERE kind='canal' AND active=1")
  let totalFed = 0
  let totalUsed = 0
  let totalShort = 0
  const activeRes = q("SELECT * FROM irrigation WHERE kind='reservoir' AND active=1 AND water>0")
  for (const r of activeRes) {
    // 每个蓄水池分配前重读地块水分，避免多池连通同一地块时按旧值重复供水
    const plots = q('SELECT * FROM plots')
    const { plotIds } = reachable(r, canals, plots)
    if (!plotIds.size) continue
    // 只浇有作物且缺水的地块；优先级高→低，同级水分低者优先
    const targets = plots
      .filter((p) => plotIds.has(p.id) && p.crop_id && p.water < 100)
      .sort((a, b) => b.irr_priority - a.irr_priority || a.water - b.water)
    let remain = r.water
    for (const p of targets) {
      if (remain <= 0) { totalShort++; continue }
      const give = Math.min(100 - p.water, remain)
      run('UPDATE plots SET water=MIN(100, water+?) WHERE id=?', give, p.id)
      remain -= give
      totalUsed += give
      totalFed++
      if (give < 100 - p.water) totalShort++ // 最后一块只浇到一部分
    }
    if (remain !== r.water) run('UPDATE irrigation SET water=? WHERE id=?', remain, r.id)
  }
  if (totalFed) {
    logs.push(`💧 灌溉完成：${totalFed} 块地共供水 ${totalUsed}${totalShort ? `；水量不足，${totalShort} 块地未浇足` : ''}`)
  }

  // —— 干涸断流预警：启用中但无水，且连通地块仍有作物缺水 ——
  const plots = q('SELECT * FROM plots')
  const dryRes = q("SELECT * FROM irrigation WHERE kind='reservoir' AND active=1 AND water<=0")
  for (const r of dryRes) {
    const { plotIds } = reachable(r, canals, plots)
    const needy = plots.filter((p) => plotIds.has(p.id) && p.crop_id && p.water < 60).length
    if (needy) logs.push(`⚠️ 蓄水池(${r.x},${r.y}) 干涸断流，${needy} 块地缺水，等待降雨补水`)
  }
  return logs
}

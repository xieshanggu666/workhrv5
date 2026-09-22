import express from 'express'
import { db } from './db.js'
import { TYPES, ensureWeather, settleWeather, currentWeather } from './weather.js'
import {
  RECIPES, capacity, listJobs, queuedBatches,
  settleProduction, enqueueJob, cancelJob, collectJobs
} from './production.js'
import {
  COSTS as IRR_COSTS, RESERVOIR_CAP, networkInfo,
  settleIrrigation, buildFacility, toggleFacility, demolishFacility
} from './irrigation.js'

const app = express()
app.use(express.json())

// ===== 初始化种子数据（仅首次） =====
function seed() {
  const hasPlayer = db.prepare('SELECT COUNT(*) c FROM player').get().c
  if (hasPlayer > 0) return

  db.prepare('INSERT INTO player (id,name) VALUES (1,?)').run('小农夫')

  const crops = [
    ['萝卜', 3, 0, 8, 2, '🥕'],
    ['番茄', 5, 0, 15, 4, '🍅'],
    ['玉米', 6, 1, 20, 5, '🌽'],
    ['南瓜', 7, 2, 30, 8, '🎃'],
    ['小麦', 5, 0, 12, 3, '🌾'],
    ['白菜', 4, 2, 10, 3, '🥬']
  ]
  const cropIns = db.prepare('INSERT INTO crops VALUES (?,?,?,?,?,?,?)')
  crops.forEach((c, i) => cropIns.run(i + 1, ...c))

  // 初始 6x6 农田 + 出售地基信息见前端
  const plotIns = db.prepare('INSERT INTO plots (x,y) VALUES (?,?)')
  for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) plotIns.run(x, y)

  db.prepare('INSERT INTO inventory (item_id,name,cat,qty) VALUES (?,?,?,?)')
    .run('seed-1', '萝卜种子', 'seed', 10)
  db.prepare('INSERT INTO inventory (item_id,name,cat,qty) VALUES (?,?,?,?)')
    .run('gold_seed_5', '小麦种子', 'seed', 5)
  db.prepare('INSERT INTO inventory (item_id,name,cat,qty) VALUES (?,?,?,?)')
    .run('disaster-kit', '防灾物资', 'material', 3)

  const buildings = [
    ['农舍', 1, 0, 7, '你的家，升级可解锁新功能'],
    ['加工坊', 1, 7, 0, '将作物加工为制品出售'],
    ['畜棚', 1, 8, 7, '养殖动物，产出蛋奶毛'],
    ['市场', 1, 7, 6, '出售作物与制品']
  ]
  const bIns = db.prepare('INSERT INTO buildings VALUES (?,?,?,?,?,?)')
  buildings.forEach((b, i) => bIns.run(i + 1, ...b))
}
seed()

// ===== 通用查询辅助 =====
const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// 启动时确保当天天气已生成（兼容旧存档）
const p0 = q1('SELECT * FROM player WHERE id=1')
ensureWeather(p0.season, p0.day, p0.abs_day)

// ===== API =====
app.get('/api/state', (req, res) => {
  const p = q1('SELECT * FROM player WHERE id=1')
  const mill = q1('SELECT * FROM buildings WHERE id=2')
  // 供水网络：连通且启用中的地块/水渠（前端绘制供水状态用）
  const net = networkInfo()
  res.json({
    player: p,
    crops: q('SELECT * FROM crops'),
    inventory: q('SELECT * FROM inventory'),
    buildings: q('SELECT * FROM buildings'),
    animals: q('SELECT * FROM animals'),
    plots: q('SELECT * FROM plots').map((pl) => ({ ...pl, irrigated: net.plotIds.has(pl.id) })),
    weather: currentWeather(),
    weatherLog: q('SELECT * FROM weather_log ORDER BY id DESC LIMIT 8'),
    recipes: RECIPES,
    queueCapacity: capacity(mill?.level || 1),
    queuedBatches: queuedBatches(p.abs_day),
    productionJobs: listJobs(p.abs_day),
    irrigation: q('SELECT * FROM irrigation').map((f) => ({
      ...f,
      cap: f.kind === 'reservoir' ? RESERVOIR_CAP : null,
      linked: f.kind === 'canal' ? net.canalIds.has(f.id) : !!f.active
    })),
    irrigationCosts: IRR_COSTS
  })
})

// 播种：plotId + cropId
app.post('/api/plant', (req, res) => {
  const { plotId, cropId } = req.body
  const plot = q1('SELECT * FROM plots WHERE id=?', plotId)
  const crop = q1('SELECT * FROM crops WHERE id=?', cropId)
  if (!plot || !crop) return res.status(404).json({ error: 'not found' })
  if (plot.crop_id) return res.status(400).json({ error: 'already planted' })
  const inv = q1("SELECT * FROM inventory WHERE item_id=? AND cat='seed'", 'seed-' + crop.id)
  const invById = q1("SELECT qty FROM inventory WHERE item_id=?", 'seed-' + crop.id)
  const stock = invById?.qty || 0
  if (stock <= 0) return res.status(400).json({ error: 'no seed' })
  run(`UPDATE plots SET crop_id=?, stage=0, water=100, fert=100, light=100, pest=0,
       planted_day=(SELECT day FROM player WHERE id=1), planted_season=(SELECT season FROM player WHERE id=1)
       WHERE id=?`, cropId, plotId)
  run(`UPDATE inventory SET qty=qty-1 WHERE item_id=?`, 'seed-' + crop.id)
  res.json({ ok: true })
})

// 浇水
app.post('/api/water', (req, res) => {
  const { plotId } = req.body
  run('UPDATE plots SET water=100 WHERE id=?', plotId)
  res.json({ ok: true })
})

// 施肥
app.post('/api/fertilize', (req, res) => {
  const { plotId } = req.body
  run('UPDATE plots SET fert=100 WHERE id=?', plotId)
  res.json({ ok: true })
})

// 除草/除虫
app.post('/api/clean', (req, res) => {
  const { plotId } = req.body
  run('UPDATE plots SET pest=0 WHERE id=?', plotId)
  res.json({ ok: true })
})

// 收获：返回作物，给钱（若成熟）
app.post('/api/harvest', (req, res) => {
  const { plotId } = req.body
  const plot = q1('SELECT * FROM plots WHERE id=?', plotId)
  if (!plot || !plot.crop_id) return res.status(404).json({ error: 'empty' })
  const crop = q1('SELECT * FROM crops WHERE id=?', plot.crop_id)
  const isFullGrown = isCropGrown(plot, crop)
  if (isFullGrown) {
    run('UPDATE player SET gold=gold+?, exp=exp+? WHERE id=1', crop.price, 3)
    // 得到作物 + 概率得种子
    addInv('crop-' + crop.id, crop.name, 'crop', 1)
    if (Math.random() < 0.25) addInv('seed-' + crop.id, crop.name + '种子', 'seed', 1)
    run('UPDATE plots SET crop_id=NULL, stage=-1, water=100, fert=100, light=100, pest=0, planted_day=NULL, planted_season=NULL WHERE id=?', plotId)
    return res.json({ ok: true, yield: crop.name, gold: crop.price })
  }
  return res.json({ ok: false, reason: 'not grown' })
})

// 时间推进 1 天
app.post('/api/nextday', (req, res) => {
  const logs = advanceDay()
  res.json({ ok: true, logs })
})

// 时间推进为主（快速）：连续跳日逐天结算天气防护消耗、损失与恢复
app.post('/api/skip', (req, res) => {
  const n = Math.min(Number(req.body?.n) || 1, 14)
  const logs = []
  for (let i = 0; i < n; i++) logs.push(...advanceDay())
  res.json({ ok: true, logs })
})

// 投入金币/物资防灾（作用于当前未结束的天气事件）
app.post('/api/weather/protect', (req, res) => {
  const gold = Math.max(0, Math.min(Math.floor(Number(req.body?.gold) || 0), 500))
  const matQty = Math.max(0, Math.min(Math.floor(Number(req.body?.matQty) || 0), 99))
  if (!gold && !matQty) return res.status(400).json({ error: '未投入任何资源' })
  const ev = q1('SELECT * FROM weather_events WHERE done=0 ORDER BY abs_day LIMIT 1')
  if (!ev || !TYPES[ev.type]?.bad) return res.status(400).json({ error: '当前天气无需防护' })
  db.exec('BEGIN IMMEDIATE')
  try {
    const p = q1('SELECT gold FROM player WHERE id=1')
    if (p.gold < gold) throw Object.assign(new Error('金币不足'), { status: 400 })
    if (matQty > 0) {
      const stacks = q("SELECT * FROM inventory WHERE cat='material' AND qty>0 ORDER BY qty DESC")
      const total = stacks.reduce((s, r) => s + r.qty, 0)
      if (total < matQty) throw Object.assign(new Error('物资不足'), { status: 400 })
      let need = matQty
      for (const s of stacks) {
        const take = Math.min(need, s.qty)
        run('UPDATE inventory SET qty=qty-? WHERE id=?', take, s.id)
        need -= take
        if (!need) break
      }
    }
    run('UPDATE player SET gold=gold-? WHERE id=1', gold)
    run('UPDATE weather_events SET protect_gold=protect_gold+?, protect_mat=protect_mat+? WHERE id=?', gold, matQty, ev.id)
    cleanEmpty()
    db.exec('COMMIT')
    res.json({ ok: true, protect_gold: ev.protect_gold + gold, protect_mat: ev.protect_mat + matQty })
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 购买防灾物资
app.post('/api/buymat', (req, res) => {
  const n = Math.max(1, Math.min(Number(req.body?.qty) || 1, 99))
  const cost = 12 * n
  const p = q1('SELECT gold FROM player WHERE id=1')
  if (p.gold < cost) return res.status(400).json({ error: 'no gold' })
  run('UPDATE player SET gold=gold-? WHERE id=1', cost)
  addInv('disaster-kit', '防灾物资', 'material', n)
  res.json({ ok: true })
})

// 买种子
app.post('/api/buyseed', (req, res) => {
  const { cropId, qty } = req.body
  const n = Math.max(1, Math.min(Number(qty) || 1, 99))
  const crop = q1('SELECT * FROM crops WHERE id=?', cropId)
  if (!crop) return res.status(404).json({ error: 'crop' })
  const cost = crop.seedPrice * n
  const p = q1('SELECT gold FROM player WHERE id=1')
  if (p.gold < cost) return res.status(400).json({ error: 'no gold' })
  run('UPDATE player SET gold=gold-? WHERE id=1', cost)
  addInv('seed-' + crop.id, crop.name + '种子', 'seed', n)
  res.json({ ok: true })
})

// 卖作物
app.post('/api/sellcrop', (req, res) => {
  const { cropId, qty } = req.body
  const n = Math.max(1, Math.min(Number(qty) || 1, 999))
  const crop = q1('SELECT * FROM crops WHERE id=?', cropId)
  const hold = q1("SELECT qty FROM inventory WHERE item_id=?", 'crop-' + crop.id)
  const stock = hold?.qty || 0
  const s = Math.min(n, stock)
  if (s <= 0) return res.status(400).json({ error: 'none' })
  const gain = crop.price * s
  run(`UPDATE inventory SET qty=qty-? WHERE item_id=?`, s, 'crop-' + crop.id)
  run('UPDATE player SET gold=gold+? WHERE id=1', gain)
  cleanEmpty()
  res.json({ ok: true, gain, sold: s })
})

// 领养动物
app.post('/api/animal', (req, res) => {
  const { species } = req.body
  const cfg = { chicken: { name: '母鸡', cost: 30 }, cow: { name: '奶牛', cost: 80 }, sheep: { name: '绵羊', cost: 60 } }
  const c = cfg[species]
  if (!c) return res.status(400).json({ error: 'species' })
  const p = q1('SELECT gold FROM player WHERE id=1')
  if (p.gold < c.cost) return res.status(400).json({ error: 'no gold' })
  run('UPDATE player SET gold=gold-? WHERE id=1', c.cost)
  const x = 8 + (q('SELECT COUNT(*) c FROM animals').length) % 3
  const r = run('INSERT INTO animals (name,species,x,y) VALUES (?,?,?,?)', c.name + '#' + (Date.now() % 1000), species, x, 8)
  res.json({ ok: true, id: r.lastInsertRowid })
})

// 喂食
app.post('/api/feed', (req, res) => {
  const { id } = req.body
  run('UPDATE animals SET feed=100 WHERE id=?', id)
  res.json({ ok: true })
})

// 收集动物产物
app.post('/api/collect', (req, res) => {
  const { id } = req.body
  const a = q1('SELECT * FROM animals WHERE id=?', id)
  if (!a || !a.ready) return res.status(400).json({ error: 'not ready' })
  const prod = { chicken: ['鸡蛋', 6], cow: ['牛奶', 12], sheep: ['羊毛', 10] }[a.species]
  addInv('p-' + a.species, prod[0], 'product', 1)
  const gain = Math.round(prod[1] / 2)
  run('UPDATE player SET gold=gold+? WHERE id=1', gain)
  run('UPDATE animals SET ready=0 WHERE id=?', id)
  res.json({ ok: true, item: prod[0], gold: gain })
})

// ===== 加工生产队列 =====
// 批量排产：recipeId + qty（批次数）
app.post('/api/production/enqueue', (req, res) => {
  try {
    const { recipeId, qty } = req.body
    const p = q1('SELECT * FROM player WHERE id=1')
    const mill = q1('SELECT level FROM buildings WHERE id=2')
    const r = enqueueJob({
      recipeId,
      qty: Number(qty) || 1,
      millLevel: mill?.level || 1,
      currentAbs: p.abs_day
    })
    res.json(r)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 取消工单：退未开工批次的原料
app.post('/api/production/cancel', (req, res) => {
  try {
    const p = q1('SELECT abs_day FROM player WHERE id=1')
    const r = cancelJob({ id: Number(req.body?.id), currentAbs: p.abs_day })
    res.json(r)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 完工入库：传 id 领单个，不传则一键全领
app.post('/api/production/collect', (req, res) => {
  try {
    const p = q1('SELECT abs_day FROM player WHERE id=1')
    const r = collectJobs(p.abs_day, req.body?.id != null ? Number(req.body.id) : null)
    res.json(r)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// ===== 灌溉系统 =====
// 建造蓄水池/水渠：kind + 坐标，扣金币
app.post('/api/irrigation/build', (req, res) => {
  try {
    const { kind, x, y } = req.body || {}
    res.json(buildFacility(kind, Number(x), Number(y)))
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 停用/启用：停用即断流，启用后恢复供水
app.post('/api/irrigation/toggle', (req, res) => {
  try {
    res.json(toggleFacility(Number(req.body?.id)))
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 拆除：返还部分造价，蓄水池余水作废
app.post('/api/irrigation/demolish', (req, res) => {
  try {
    res.json(demolishFacility(Number(req.body?.id)))
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 设置地块灌溉优先级（0低 1中 2高）
app.post('/api/irrigation/priority', (req, res) => {
  const plotId = Number(req.body?.plotId)
  const priority = Math.max(0, Math.min(2, Math.floor(Number(req.body?.priority) || 0)))
  if (!q1('SELECT id FROM plots WHERE id=?', plotId)) return res.status(404).json({ error: 'not found' })
  run('UPDATE plots SET irr_priority=? WHERE id=?', priority, plotId)
  res.json({ ok: true, priority })
})

// 升级建筑
app.post('/api/upgrade', (req, res) => {
  const { id } = req.body
  const b = q1('SELECT * FROM buildings WHERE id=?', id)
  if (!b || b.level >= 5) return res.status(400).json({ error: 'max' })
  const cost = 40 * b.level
  if (q1('SELECT gold FROM player WHERE id=1').gold < cost) return res.status(400).json({ error: 'no gold' })
  run('UPDATE player SET gold=gold-? WHERE id=1', cost)
  run('UPDATE buildings SET level=level+1 WHERE id=?', id)
  res.json({ ok: true, level: b.level + 1 })
})

// ===== 工具函数 =====
function addInv(itemId, name, cat, n) {
  const row = q1('SELECT qty FROM inventory WHERE item_id=?', itemId)
  if (row) run('UPDATE inventory SET qty=qty+? WHERE item_id=?', n, itemId)
  else run('INSERT INTO inventory (item_id,name,cat,qty) VALUES (?,?,?,?)', itemId, name, cat, n)
}
function cleanEmpty() {
  db.exec('DELETE FROM inventory WHERE qty<=0')
}
function isCropGrown(plot, crop) {
  return plot.stage >= (crop.days - 1)
}
function clamp100(v) { return Math.max(0, Math.min(100, v)) }
// 推进 1 天：事务内完成「天气结算 → 地块/动物逐日更新 → 日期推进 → 生成次日天气」，
// 任一步失败整体回滚，读档或重试不会重复扣损。返回当日天气结算日志。
function advanceDay() {
  const logs = []
  db.exec('BEGIN IMMEDIATE')
  try {
    const p = q1('SELECT * FROM player WHERE id=1')
    let { day, season } = p
    // —— 天气：结算当日事件（防护消耗/损失/恢复按天结算，幂等）——
    const { mods, logs: wlogs, type: wType, severity: wSev } = settleWeather(p.abs_day)
    logs.push(...wlogs)
    day += 1
    // 更新所有地块：生长 + 四维变化 + 虫害 + 天气修正
    const plots = q('SELECT * FROM plots')
    for (const pl of plots) {
      if (!pl.crop_id) continue
      // 四维消耗 + 天气修正
      let water = pl.water - (12 + Math.round(Math.random() * 12)) + mods.waterAdd
      let fert = pl.fert - (8 + Math.round(Math.random() * 8)) + mods.fertAdd
      let light = pl.light - (6 + Math.round(Math.random() * 8)) + mods.lightAdd + mods.lightRecover
      // 季节光照影响
      if (season === 3) light -= 10
      // 降雨/暴雨直接灌满
      if (mods.setWater != null) water = mods.setWater
      water = clamp100(water); fert = clamp100(fert); light = clamp100(light)
      let pest = Math.max(0, pl.pest + (Math.random() < 0.25 ? 1 : 0) + mods.pestAdd)
      // 虫害过高会降低属性；恶劣天气可能阻止生长
      const flux = water >= 30 && fert >= 30 && light >= 30 && pest <= 0.6 && !mods.growthBlock
      const crop = q1('SELECT days FROM crops WHERE id=?', pl.crop_id)
      const full = pl.stage >= (crop.days - 1)
      let stage = pl.stage
      if (!full && flux) stage += 1
      else if (!full && !flux && pl.stage === 0) {
        // 条件不良不生长（重长）
      }
      // 恶劣天气可能打坏作物（倒退一阶段）
      if (stage > 0 && mods.stageRegressChance > 0 && Math.random() < mods.stageRegressChance) stage -= 1
      run(`UPDATE plots SET water=?,fert=?,light=?,pest=?,stage=? WHERE id=?`, water, fert, light, pest, stage, pl.id)
    }
    // 动物喂食衰减 + 天气伤害/恢复 + 产物就绪
    const animals = q('SELECT * FROM animals')
    for (const a of animals) {
      const feed = Math.max(0, a.feed - 25)
      let health = a.health - (feed === 0 ? 20 : 6) + mods.animalHpAdd
      if (feed > 0) health += mods.animalRecover
      health = Math.max(0, Math.min(100, health))
      run(`UPDATE animals SET feed=?,health=?,ready=1 WHERE id=?`, feed, health, a.id)
    }
    // —— 灌溉：降雨补水/干旱耗水，蓄水池按连通关系与优先级分配有限水量 ——
    logs.push(...settleIrrigation(wType, wSev))
    // 天数推进与季节轮转
    if (day > 28) {
      day = 1
      season = (season + 1) % 4
    }
    run('UPDATE player SET day=?, season=?, abs_day=abs_day+1 WHERE id=1', day, season)
    // —— 加工队列：按游戏天推进，完工批次落库（与天气/作物同一事务，失败整体回滚）——
    const plogs = settleProduction(p.abs_day + 1)
    logs.push(...plogs)
    // 生成次日天气（持续中的事件会自然延续）
    ensureWeather(season, day, p.abs_day + 1)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
  return logs
}

const PORT = 4110
app.listen(PORT, () => console.log(`[FARM] API running at http://localhost:${PORT}`))
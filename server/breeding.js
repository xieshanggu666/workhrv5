import { db } from './db.js'

// ===== 性状图鉴（服务端为准，前端仅展示）=====
// 效果说明：
//  fast    早熟：生长天数 -1
//  hardy   抗虫：虫害概率减半
//  dry     耐旱：每日水分消耗减半
//  frost   抗寒：光照天气减益减半，冬季光照不再额外下降
//  vigor   强韧：生长条件阈值放宽，恶劣天气阻止生长时仍可生长
//  bumper  丰产：收获多 1 个作物，且种子掉落概率提高
//  quality 优品：售价 +35%
export const TRAITS = {
  fast:    { name: '早熟', icon: '⏱️', desc: '成熟所需天数 -1' },
  hardy:   { name: '抗虫', icon: '🛡️', desc: '虫害发生概率减半' },
  dry:     { name: '耐旱', icon: '🏜️', desc: '每日水分消耗减半' },
  frost:   { name: '抗寒', icon: '❄️', desc: '光照天气减益减半，冬季不受光照惩罚' },
  vigor:   { name: '强韧', icon: '💪', desc: '生长条件放宽，天气阻止生长时仍能生长' },
  bumper:  { name: '丰产', icon: '🌾', desc: '收获 +1 个作物，种子掉落概率 +15%' },
  quality: { name: '优品', icon: '✨', desc: '售价 +35%' }
}
export const TRAIT_IDS = Object.keys(TRAITS)
export const MAX_TRAITS = 3

// 试验初始状态与消耗
export const TRIAL_COST = 15            // 每次试验金币投入
export const TRIAL_INPUT = 2            // 每个亲本消耗作物数
export const TRIAL_START_WATER = 80
export const TRIAL_START_FERT = 80

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

function addInv(itemId, name, cat, n) {
  const row = q1('SELECT qty FROM inventory WHERE item_id=?', itemId)
  if (row) run('UPDATE inventory SET qty=qty+? WHERE item_id=?', n, itemId)
  else run('INSERT INTO inventory (item_id,name,cat,qty) VALUES (?,?,?,?)', itemId, name, cat, n)
}
function cleanEmpty() {
  db.exec('DELETE FROM inventory WHERE qty<=0')
}

export function breedingLab() {
  return q1('SELECT * FROM buildings WHERE id=5') || { id: 5, name: '育种坊', level: 1 }
}
// 可同时进行的试验数：Lv.1 两个槽位，每升一级 +1
export function trialSlots(level = breedingLab().level) {
  return 1 + level
}
export function growingTrials() {
  return q("SELECT * FROM breeding_trials WHERE status='growing'")
}

// 作物的性状 id 数组（原生作物为空数组）
const traitCache = new Map()
export function traitsOf(cropId) {
  const key = cropId == null ? '' : String(cropId)
  if (!traitCache.has(key)) {
    const v = q1('SELECT traits FROM varieties WHERE crop_id=?', cropId)
    let arr = []
    if (v) { try { arr = JSON.parse(v.traits) || [] } catch { arr = [] } }
    traitCache.set(key, arr)
  }
  return traitCache.get(key)
}
export function hasTrait(cropId, id) {
  return traitsOf(cropId).includes(id)
}
// 某品种（含原生）的母本原生作物 id；杂交品种取 varieties.base_id，原生即自身
export function baseIdOf(cropId) {
  return q1('SELECT base_id FROM varieties WHERE crop_id=?', cropId)?.base_id || Number(cropId)
}

// ===== 开始试验：投入两批不同作物 + 金币，立即扣料 =====
export function startTrial({ cropAId, cropBId, currentAbs }) {
  const a = q1('SELECT * FROM crops WHERE id=?', Number(cropAId))
  const b = q1('SELECT * FROM crops WHERE id=?', Number(cropBId))
  if (!a || !b) throw Object.assign(new Error('亲本作物不存在'), { status: 404 })
  if (a.id === b.id) throw Object.assign(new Error('需要选择两批不同的作物进行杂交'), { status: 400 })
  const lab = breedingLab()
  const used = growingTrials().length
  if (used >= trialSlots(lab.level)) {
    throw Object.assign(new Error(`育种坊试验位已满（${used}/${trialSlots(lab.level)}），等试验完成或取消一些`), { status: 400 })
  }
  const p = q1('SELECT gold FROM player WHERE id=1')
  if (p.gold < TRIAL_COST) throw Object.assign(new Error('金币不足'), { status: 400 })
  const needA = q1('SELECT qty FROM inventory WHERE item_id=?', 'crop-' + a.id)?.qty || 0
  const needB = q1('SELECT qty FROM inventory WHERE item_id=?', 'crop-' + b.id)?.qty || 0
  if (needA < TRIAL_INPUT) throw Object.assign(new Error(`${a.name}不足：需要 ×${TRIAL_INPUT}`), { status: 400 })
  if (needB < TRIAL_INPUT) throw Object.assign(new Error(`${b.name}不足：需要 ×${TRIAL_INPUT}`), { status: 400 })

  // 试验时长取双亲成熟期均值 +1（早熟性状已烘焙进 days），至少 3 天
  const daysTotal = Math.max(3, Math.round((a.days + b.days) / 2) + 1)

  db.exec('BEGIN IMMEDIATE')
  try {
    run('UPDATE player SET gold=gold-? WHERE id=1', TRIAL_COST)
    run('UPDATE inventory SET qty=qty-? WHERE item_id=?', TRIAL_INPUT, 'crop-' + a.id)
    run('UPDATE inventory SET qty=qty-? WHERE item_id=?', TRIAL_INPUT, 'crop-' + b.id)
    cleanEmpty()
    const r = run(
      `INSERT INTO breeding_trials
       (parent_a_crop,parent_b_crop,days_total,elapsed,water,fert,health,start_abs,status)
       VALUES (?,?,?,0,?,?,?,?,'growing')`,
      a.id, b.id, daysTotal, TRIAL_START_WATER, TRIAL_START_FERT, 100, currentAbs
    )
    db.exec('COMMIT')
    return { ok: true, id: r.lastInsertRowid, daysTotal }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}

// 养护：浇水 / 施肥（免费，鼓励日常照料）
export function careTrial({ id, kind }) {
  const t = q1("SELECT * FROM breeding_trials WHERE status='growing' AND id=?", Number(id))
  if (!t) throw Object.assign(new Error('试验不存在或已结束'), { status: 404 })
  if (kind === 'water') run('UPDATE breeding_trials SET water=100 WHERE id=?', t.id)
  else if (kind === 'fert') run('UPDATE breeding_trials SET fert=100 WHERE id=?', t.id)
  else throw Object.assign(new Error('未知的养护操作'), { status: 400 })
  return { ok: true }
}

// 取消进行中的试验：返还一半投入金币，已投入作物不还
export function cancelTrial(id) {
  const t = q1("SELECT * FROM breeding_trials WHERE status='growing' AND id=?", Number(id))
  if (!t) throw Object.assign(new Error('试验不存在或已结束'), { status: 404 })
  const refund = Math.floor(TRIAL_COST / 2)
  run("UPDATE breeding_trials SET status='fail', finish_abs=start_abs+elapsed WHERE id=?", t.id)
  if (refund > 0) run('UPDATE player SET gold=gold+? WHERE id=1', refund)
  return { ok: true, refund }
}

// 清除已结束（成功/失败）的试验记录；成功记录清除前种子早已入库
export function clearTrial(id) {
  const t = q1("SELECT * FROM breeding_trials WHERE status!='growing' AND id=?", Number(id))
  if (!t) throw Object.assign(new Error('试验不存在或仍在进行'), { status: 404 })
  run('DELETE FROM breeding_trials WHERE id=?', t.id)
  return { ok: true }
}

// ===== 新品种诞生：性状遗传 + 变异，注册 crops/varieties，产出种子 =====
function inheritTraits(aId, bId, labLevel) {
  const ta = traitsOf(aId)
  const tb = traitsOf(bId)
  const traits = new Set()
  // 每个亲本的每个性状独立判定遗传（65% 概率）
  for (const t of ta) if (TRAIT_IDS.includes(t) && Math.random() < 0.65) traits.add(t)
  for (const t of tb) if (TRAIT_IDS.includes(t) && Math.random() < 0.65) traits.add(t)
  // 变异：育种坊等级越高越容易产生新性状
  const mutation = 0.08 + labLevel * 0.03
  const pool = TRAIT_IDS.filter((t) => !traits.has(t))
  for (const t of pool) {
    if (Math.random() < mutation) { traits.add(t); break }
  }
  // 保底：杂交后代至少携带 1 个性状
  if (traits.size === 0) traits.add(TRAIT_IDS[Math.floor(Math.random() * TRAIT_IDS.length)])
  // 上限裁剪：按 TRAIT_IDS 固定顺序保留，结果可预期
  return TRAIT_IDS.filter((t) => traits.has(t)).slice(0, MAX_TRAITS)
}

// 试验成功时注册新品种并返回 { crop, traits, seeds }
function registerVariety(trial, labLevel, currentAbs) {
  const a = q1('SELECT * FROM crops WHERE id=?', trial.parent_a_crop)
  const b = q1('SELECT * FROM crops WHERE id=?', trial.parent_b_crop)
  const va = q1('SELECT * FROM varieties WHERE crop_id=?', a.id)
  const vb = q1('SELECT * FROM varieties WHERE crop_id=?', b.id)

  const traits = inheritTraits(a.id, b.id, labLevel)
  // 母本随机选取（50/50），主体数值与图标来自母本
  const basePick = Math.random() < 0.5 ? a : b
  const baseParent = basePick.id === a.id ? va : vb
  const otherParent = basePick.id === a.id ? b : a
  const baseId = baseParent ? baseParent.base_id : basePick.id

  // 世代 = 双亲最大世代 + 1（原生作物视为 0）
  const gen = Math.max(va?.gen || 0, vb?.gen || 0) + 1
  // 数值：母本数值为主，向另一亲本靠拢一点
  const lerp = (x, y) => Math.round(x + (y - x) * 0.25)
  let days = lerp(basePick.days, otherParent.days)
  if (traits.includes('fast')) days -= 1
  days = Math.max(2, days)
  let price = Math.round(basePick.price * (traits.includes('quality') ? 1.35 : 1))
  let seedPrice = Math.round(basePick.seedPrice * 1.5)

  // 名称：性状前缀 + 母本名 + F{世代}
  const prefix = traits.map((t) => TRAITS[t].icon).join('')
  const name = `${prefix}${basePick.name}F${gen}`

  const res = run(
    "INSERT INTO crops (name,days,season,price,seedPrice,sprite,kind) VALUES (?,?,?,?,?,?, 'hybrid')",
    name, days, basePick.season, price, seedPrice, basePick.sprite
  )
  const cropId = Number(res.lastInsertRowid)
  run(
    `INSERT INTO varieties (crop_id,base_id,parent_a_crop,parent_b_crop,parent_a_trial,parent_b_trial,gen,traits,born_abs)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    cropId, baseId, a.id, b.id, va ? trial.id : null, vb ? trial.id : null,
    gen, JSON.stringify(traits), currentAbs
  )
  traitCache.clear() // 性状缓存失效

  // 种子产量：2~4 颗，按试验结束健康度取整（健康≥80 有机会拿满）
  const seeds = Math.max(2, Math.min(4, Math.round(2 + (trial.health / 100) * 2)))
  addInv('seed-' + cropId, name + '种子', 'seed', seeds)
  const crop = q1('SELECT * FROM crops WHERE id=?', cropId)
  return { crop, traits, seeds }
}

// ===== 逐日结算（在 advanceDay 事务内调用，不另开事务）=====
// mods 来自天气结算：与地块共享同一套天气修正。返回日志数组。
export function settleBreeding(mods, currentAbs) {
  const logs = []
  const lab = breedingLab()
  for (const t of q("SELECT * FROM breeding_trials WHERE status='growing'")) {
    const a = q1('SELECT * FROM crops WHERE id=?', t.parent_a_crop)
    const b = q1('SELECT * FROM crops WHERE id=?', t.parent_b_crop)
    // 亲本抗性惠及试验
    const parentTraits = new Set([...traitsOf(a.id), ...traitsOf(b.id)])
    const dryResist = parentTraits.has('dry')
    const frostResist = parentTraits.has('frost')
    const vigor = parentTraits.has('vigor')

    // 每日消耗：墒情与养分（耐旱亲本减半）
    const waterUse = (12 + Math.round(Math.random() * 10)) * (dryResist ? 0.5 : 1)
    const fertUse = 8 + Math.round(Math.random() * 8)
    let water = Math.max(0, Math.min(100, t.water - waterUse + (mods.waterAdd || 0)))
    let fert = Math.max(0, Math.min(100, t.fert - fertUse + (mods.fertAdd || 0)))
    // 每日光照：晴好日基线 90；天气光照减益对带抗寒亲本的试验减半
    let lightDelta = (mods.lightAdd || 0)
    if (frostResist && lightDelta < 0) lightDelta *= 0.5
    let light = Math.max(0, Math.min(100, 90 + lightDelta + (mods.lightRecover || 0)))
    if (mods.setWater != null) water = mods.setWater

    // 生长判定：强韧亲本放宽阈值且可抵抗天气阻断
    const minV = vigor ? 20 : 30
    const blocked = mods.growthBlock && !vigor
    const good = water >= minV && fert >= minV && light >= minV && !blocked
    const elapsed = t.elapsed + (good ? 1 : 0)

    // 健康度：条件不足或恶劣天气逐日受损；强韧亲本减半伤害；养护到位可缓慢恢复
    let health = t.health
    if (water < minV || fert < minV || light < minV) health -= 12
    if (mods.growthBlock && !vigor) health -= 10
    if (good) health += 2
    health = Math.max(0, Math.min(100, Math.round(health)))

    run('UPDATE breeding_trials SET water=?,fert=?,health=?,elapsed=? WHERE id=?',
      Math.round(water), Math.round(fert), health, elapsed, t.id)

    // 试验到期：健康度过低则失败
    if (elapsed >= t.days_total) {
      if (health <= 25) {
        run("UPDATE breeding_trials SET status='fail',finish_abs=? WHERE id=?", currentAbs, t.id)
        logs.push(`🧬 杂交试验#${t.id} 失败：${a.name}×${b.name} 秧苗健康度仅 ${health}，没能结出种子`)
      } else {
        const { crop, traits, seeds } = registerVariety(
          q1('SELECT * FROM breeding_trials WHERE id=?', t.id), lab.level, currentAbs
        )
        run("UPDATE breeding_trials SET status='success',finish_abs=?,result_crop=?,seeds=? WHERE id=?",
          currentAbs, crop.id, seeds, t.id)
        const traitTxt = traits.map((x) => `${TRAITS[x].icon}${TRAITS[x].name}`).join('·') || '普通'
        logs.push(`✅ 杂交试验#${t.id} 成功：${a.name}×${b.name} 培育出新品种「${crop.name}」（${traitTxt}），种子 ×${seeds} 已入库`)
      }
    }
  }
  return logs
}

// 组装试验的展示信息（亲本名称/图标、剩余天数、状态）
function decorate(t) {
  const a = q1('SELECT * FROM crops WHERE id=?', t.parent_a_crop)
  const b = q1('SELECT * FROM crops WHERE id=?', t.parent_b_crop)
  const remain = Math.max(0, t.days_total - t.elapsed)
  const result = t.result_crop ? q1('SELECT * FROM crops WHERE id=?', t.result_crop) : null
  const resultTraits = t.result_crop ? traitsOf(t.result_crop) : []
  return {
    ...t,
    parentA: a ? { id: a.id, name: a.name, sprite: a.sprite } : null,
    parentB: b ? { id: b.id, name: b.name, sprite: b.sprite } : null,
    remainDays: remain,
    result: result ? { ...result, traits: resultTraits } : null
  }
}

export function listTrials() {
  return q('SELECT * FROM breeding_trials ORDER BY id DESC').map(decorate)
}

// 品种图鉴（含性状与谱系），按诞生顺序
export function listVarieties() {
  return q(`SELECT v.*, c.name,c.days,c.season,c.price,c.seedPrice,c.sprite
           FROM varieties v JOIN crops c ON c.id=v.crop_id
           ORDER BY v.crop_id`).map((v) => {
    let traits = []
    try { traits = JSON.parse(v.traits) || [] } catch { traits = [] }
    const pa = q1('SELECT id,name,sprite FROM crops WHERE id=?', v.parent_a_crop)
    const pb = q1('SELECT id,name,sprite FROM crops WHERE id=?', v.parent_b_crop)
    return { ...v, traits, parentA: pa, parentB: pb }
  })
}

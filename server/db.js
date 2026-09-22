import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const db = new DatabaseSync(path.join(__dirname, 'farm.db'))

// 启用基本约束
db.exec('PRAGMA foreign_keys = ON;')

// 建表
db.exec(`
CREATE TABLE IF NOT EXISTS player (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  gold INTEGER NOT NULL DEFAULT 100,
  level INTEGER NOT NULL DEFAULT 1,
  exp INTEGER NOT NULL DEFAULT 0,
  season INTEGER NOT NULL DEFAULT 0,      -- 0春 1夏 2秋 3冬
  day INTEGER NOT NULL DEFAULT 1,
  hour INTEGER NOT NULL DEFAULT 8
);

CREATE TABLE IF NOT EXISTS plots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  crop_id INTEGER DEFAULT NULL,           -- 关联 crops.id
  stage INTEGER NOT NULL DEFAULT -1,      -- -1 空地 0播种 1..n-1生长 n成熟
  water INTEGER NOT NULL DEFAULT 100,
  fert INTEGER NOT NULL DEFAULT 100,
  light INTEGER NOT NULL DEFAULT 100,
  pest INTEGER NOT NULL DEFAULT 0,        -- 0无 越高越差
  planted_day INTEGER,
  planted_season INTEGER
);

CREATE TABLE IF NOT EXISTS crops (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  days INTEGER NOT NULL,
  season INTEGER NOT NULL,               -- 适宜季节
  price INTEGER NOT NULL,
  seedPrice INTEGER NOT NULL,
  sprite TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cat TEXT NOT NULL,                     -- seed/crop/product/material/animal/other
  qty INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS buildings (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  desc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS animals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  species TEXT NOT NULL,                 -- chicken/cow/sheep
  feed INTEGER NOT NULL DEFAULT 100,
  health INTEGER NOT NULL DEFAULT 100,
  ready INTEGER NOT NULL DEFAULT 0,      -- 可收集产物 0/1
  x INTEGER NOT NULL,
  y INTEGER NOT NULL
);

-- 天气事件：按季节生成并持久化；防护投入与结算进度都落库
CREATE TABLE IF NOT EXISTS weather_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season INTEGER NOT NULL,
  day INTEGER NOT NULL,                  -- 季节内第几天（事件开始日）
  abs_day INTEGER NOT NULL,              -- 绝对天数（全局递增，结算对齐用）
  type TEXT NOT NULL,                    -- sunny/rain/drought/storm/frost/heatwave/blizzard/freeze/wind
  name TEXT NOT NULL,
  icon TEXT NOT NULL,
  duration INTEGER NOT NULL DEFAULT 1,   -- 持续天数
  severity INTEGER NOT NULL DEFAULT 0,   -- 0 无害 / 1~3 灾害等级
  protect_gold INTEGER NOT NULL DEFAULT 0,  -- 已投入防护金币储备
  protect_mat INTEGER NOT NULL DEFAULT 0,   -- 已投入防护物资储备
  settled_days INTEGER NOT NULL DEFAULT 0,  -- 已结算天数（防重复扣损）
  done INTEGER NOT NULL DEFAULT 0
);

-- 天气逐日结算日志：UNIQUE(event_id, abs_day) 保证同一天只结算一次
CREATE TABLE IF NOT EXISTS weather_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  abs_day INTEGER NOT NULL,
  msg TEXT NOT NULL,
  UNIQUE(event_id, abs_day)
);

-- 灌溉设施：蓄水池(reservoir)储水，水渠(canal)连接蓄水池与地块；
-- 停用(active=0)即断流，重新启用自动恢复供水；拆除直接删行
CREATE TABLE IF NOT EXISTS irrigation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                 -- reservoir/canal
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  water INTEGER NOT NULL DEFAULT 0,   -- 蓄水池当前水量（水渠恒为 0）
  UNIQUE(x, y)
);

-- 加工生产工单：批量排产，按游戏天串行推进；取消时记录取消绝对日用于退料与队列重排
CREATE TABLE IF NOT EXISTS production_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id TEXT NOT NULL,              -- 配方 id（见 server/production.js RECIPES）
  recipe_name TEXT NOT NULL,
  result_id TEXT NOT NULL,
  result_name TEXT NOT NULL,
  result_cat TEXT NOT NULL,
  from_id TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_cat TEXT NOT NULL,
  consume INTEGER NOT NULL,             -- 每批消耗原料数
  gain INTEGER NOT NULL,                -- 每批产出成品数
  days INTEGER NOT NULL,                -- 每批耗时（游戏天）
  qty INTEGER NOT NULL,                 -- 批次数
  finished INTEGER NOT NULL DEFAULT 0,  -- 已完工批次数（跨天结算时落库）
  enqueue_abs INTEGER NOT NULL,         -- 排产时的绝对天
  cancel_abs INTEGER DEFAULT NULL,      -- 取消时的绝对天（NULL 未取消）
  status TEXT NOT NULL DEFAULT 'running' -- running/done/canceled/collected
);

-- ===== 杂交育种 =====
-- 品种登记：原生作物不在此表；杂交成功即向 crops 插入一行并在此记录性状与谱系。
-- 收获/播种/出售/加工只认 crops.id，本专表提供性状（影响生长结算）与谱系展示。
CREATE TABLE IF NOT EXISTS varieties (
  crop_id INTEGER PRIMARY KEY,          -- 与 crops.id 一致
  base_id INTEGER NOT NULL,             -- 母本品种（继承主体性状的原生作物 id；加工按此匹配）
  parent_a_crop INTEGER NOT NULL,       -- 父本 A 的 crops.id
  parent_b_crop INTEGER NOT NULL,       -- 父本 B 的 crops.id
  parent_a_trial INTEGER,               -- 由哪个试验诞生（原生作物父本为 NULL）
  parent_b_trial INTEGER,
  gen INTEGER NOT NULL DEFAULT 1,       -- 谱系深度（世代，原生作物视为 0）
  traits TEXT NOT NULL DEFAULT '[]',    -- 性状 id 数组 JSON（见 server/breeding.js TRAITS）
  born_abs INTEGER NOT NULL             -- 培育成功的绝对天
);

-- 育种试验：投入两批作物，随游戏天推进，受养护（浇水/施肥）与天气影响
CREATE TABLE IF NOT EXISTS breeding_trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_a_crop INTEGER NOT NULL,       -- 父本 A crops.id
  parent_b_crop INTEGER NOT NULL,       -- 父本 B crops.id
  days_total INTEGER NOT NULL,          -- 预计试验天数
  elapsed INTEGER NOT NULL DEFAULT 0,   -- 已推进天数（仅生长条件满足时增长）
  water INTEGER NOT NULL DEFAULT 80,    -- 试验墒情（养护浇水可补满）
  fert INTEGER NOT NULL DEFAULT 80,     -- 试验养分（养护施肥可补满）
  health INTEGER NOT NULL DEFAULT 100,  -- 健康度：条件恶劣逐日下降，决定成败与种子产量
  start_abs INTEGER NOT NULL,           -- 开始绝对天
  finish_abs INTEGER,                   -- 结束绝对天（NULL 进行中）
  result_crop INTEGER,                  -- 成功时诞生的新品种 crops.id
  seeds INTEGER NOT NULL DEFAULT 0,     -- 产出种子数（成功后自动入库）
  status TEXT NOT NULL DEFAULT 'growing' -- growing/success/fail
);
`)

// 兼容旧存档：player 增加绝对天数（天气结算对齐用）
const playerCols = db.prepare('PRAGMA table_info(player)').all().map((c) => c.name)
if (!playerCols.includes('abs_day')) {
  db.exec('ALTER TABLE player ADD COLUMN abs_day INTEGER NOT NULL DEFAULT 1')
}

// 兼容旧存档：plots 增加灌溉优先级（0低 1中 2高，水量不足时高优先级先供水）
const plotCols = db.prepare('PRAGMA table_info(plots)').all().map((c) => c.name)
if (!plotCols.includes('irr_priority')) {
  db.exec('ALTER TABLE plots ADD COLUMN irr_priority INTEGER NOT NULL DEFAULT 1')
}

// 兼容旧存档：crops 增加 kind（base 原生 / hybrid 杂交培育）；旧作物行全部默认原生
const cropCols = db.prepare('PRAGMA table_info(crops)').all().map((c) => c.name)
if (!cropCols.includes('kind')) {
  db.exec("ALTER TABLE crops ADD COLUMN kind TEXT NOT NULL DEFAULT 'base'")
}

// 兼容旧存档：补建育种坊（新存档在 seed() 中一并插入）
db.exec(`INSERT INTO buildings (id,name,level,x,y,desc)
         SELECT 5,'育种坊',1,9,0,'杂交两批作物，培育带遗传性状的新品种'
         WHERE NOT EXISTS (SELECT 1 FROM buildings WHERE id=5)`)
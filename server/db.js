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
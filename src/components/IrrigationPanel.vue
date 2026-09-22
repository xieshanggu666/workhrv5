<template>
  <div class="panel irr-panel">
    <h3>💧 灌溉系统</h3>

    <!-- 建造 -->
    <div class="build-row">
      <button class="build-btn" :class="{on: store.irrBuildMode==='reservoir'}" @click="store.setIrrBuildMode('reservoir')">
        🛢️ 蓄水池 <span class="cost">🪙{{ store.irrigationCosts.reservoir }}</span>
      </button>
      <button class="build-btn" :class="{on: store.irrBuildMode==='canal'}" @click="store.setIrrBuildMode('canal')">
        ➖ 水渠 <span class="cost">🪙{{ store.irrigationCosts.canal }}/段</span>
      </button>
    </div>
    <p class="hint" v-if="store.irrBuildMode">
      点击地图空地放置{{ store.irrBuildMode === 'reservoir' ? '蓄水池' : '水渠（可连续铺设）' }}，再次点击按钮取消
    </p>
    <p class="hint" v-else>蓄水池储水，水渠连接蓄水池与耕地；每日结算时自动为连通地块浇水</p>

    <div class="divider"></div>

    <!-- 供水概览 -->
    <div class="net-row">
      <span>🛢️ 总储量 <b>{{ totalWater }}/{{ totalCap }}</b></span>
      <span>🌾 供水地块 <b :class="{warn: irrigatedCount < plantedCount}">{{ irrigatedCount }}/{{ plantedCount }}</b></span>
    </div>
    <div class="bar total"><i :style="{width: totalCap ? (totalWater/totalCap*100)+'%' : '0%'}"></i></div>

    <!-- 设施列表 -->
    <div class="fac-list" v-if="store.irrigation.length">
      <div class="fac" v-for="f in sortedFacilities" :key="f.id" :class="{off: !f.active}">
        <span class="f-icon">{{ f.kind === 'reservoir' ? '🛢️' : '➖' }}</span>
        <div class="f-info">
          <b>{{ f.kind === 'reservoir' ? '蓄水池' : '水渠' }} ({{ f.x }},{{ f.y }})</b>
          <div class="bar" v-if="f.kind === 'reservoir'">
            <i :style="{width: (f.water / f.cap * 100) + '%'}"></i>
          </div>
          <span class="f-state" :class="stateClass(f)">{{ stateText(f) }}</span>
        </div>
        <button class="mini" @click="store.toggleIrrigation(f.id)">{{ f.active ? '停用' : '启用' }}</button>
        <button class="mini red" @click="demolish(f)">拆除</button>
      </div>
    </div>
    <div class="none" v-else>还没有灌溉设施，先建一座蓄水池吧</div>

    <p class="hint rules">
      规则：每日结算时，蓄水池沿水渠为相邻耕地供水，优先级 高→低（同级水分低者优先），水量耗尽即止；
      降雨为蓄水池补水，干旱加速蒸发；停用/拆除即断流，重新启用或重建后自动恢复。
    </p>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useGameStore } from '@/store/game'
const store = useGameStore()

const sortedFacilities = computed(() =>
  [...store.irrigation].sort((a, b) => (a.kind === b.kind ? a.id - b.id : a.kind === 'reservoir' ? -1 : 1))
)
const reservoirs = computed(() => store.irrigation.filter((f) => f.kind === 'reservoir'))
const totalWater = computed(() => reservoirs.value.reduce((s, f) => s + f.water, 0))
const totalCap = computed(() => reservoirs.value.reduce((s, f) => s + (f.cap || 0), 0))
const irrigatedCount = computed(() => store.plots.filter((p) => p.crop_id && p.irrigated).length)
const plantedCount = computed(() => store.plots.filter((p) => p.crop_id).length)

function stateText(f) {
  if (!f.active) return '已停用 · 断流'
  if (f.kind === 'reservoir') return f.water > 0 ? `💧 ${Math.round(f.water)}/${f.cap}` : '干涸 · 等待降雨'
  return f.linked ? '通水中' : '未连通蓄水池'
}
function stateClass(f) {
  if (!f.active) return 'off'
  if (f.kind === 'reservoir') return f.water > 0 ? 'ok' : 'warn'
  return f.linked ? 'ok' : 'warn'
}
function demolish(f) {
  const tip = f.kind === 'reservoir' && f.water > 0 ? `，池内 ${Math.round(f.water)} 水量将作废` : ''
  if (confirm(`确定拆除${f.kind === 'reservoir' ? '蓄水池' : '水渠'} (${f.x},${f.y}) 吗${tip}？`)) {
    store.demolishIrrigation(f.id)
  }
}
</script>

<style scoped>
.panel { background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px; }
h3 { margin:0 0 10px;color:#fff;font-size:15px; }
.build-row { display:flex;gap:8px; }
.build-btn {
  flex:1;background:#16263f;border:1px solid rgba(120,160,220,0.25);border-radius:9px;
  padding:10px;color:#dbe4f3;cursor:pointer;font-size:12px;display:flex;flex-direction:column;gap:4px;align-items:center;
}
.build-btn.on { border-color:#29b6f6;box-shadow:0 0 0 1px #29b6f6;background:#12314f; }
.cost { color:#ffc107;font-size:11px; }
.hint { color:#8ba2c8;font-size:11px;margin:8px 0 0;line-height:1.5; }
.hint.rules { color:#5b6f94;border-top:1px dashed rgba(120,160,220,0.15);padding-top:8px; }
.divider { height:1px;background:rgba(120,160,220,0.15);margin:10px 0; }
.net-row { display:flex;justify-content:space-between;font-size:12px;color:#c6d2e6;margin-bottom:5px; }
.net-row b { color:#4fc3f7; }
.net-row b.warn { color:#ef9a9a; }
.bar { height:8px;background:#0c1730;border-radius:4px;overflow:hidden; }
.bar i { display:block;height:100%;background:linear-gradient(90deg,#0288d1,#4fc3f7);border-radius:4px; }
.bar.total { margin-bottom:10px; }
.fac-list { max-height:220px;overflow-y:auto; }
.fac { display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px dashed rgba(120,160,220,0.1); }
.fac:last-child { border-bottom:none; }
.fac.off { opacity:.6; }
.f-icon { font-size:18px;width:26px;text-align:center; }
.f-info { flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:4px;align-items:center; }
.f-info b { color:#e8eefb;font-size:12px;width:100%; }
.f-info .bar { flex:1;min-width:60px; }
.f-state { font-size:10px;padding:2px 6px;border-radius:4px;background:#16263f;color:#8ba2c8;white-space:nowrap; }
.f-state.ok { color:#a5d6a7;background:#1b3a21; }
.f-state.warn { color:#ffb74d;background:#3a2a12; }
.f-state.off { color:#8ba2c8;background:#23304a; }
.mini { background:#2962ff;border:none;color:#fff;border-radius:7px;padding:5px 9px;font-size:11px;cursor:pointer;white-space:nowrap; }
.mini.red { background:#c62828; }
.mini:hover { filter:brightness(1.15); }
.none { color:#5b6f94;text-align:center;padding:14px;font-size:12px; }
</style>

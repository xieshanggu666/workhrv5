<template>
  <div class="panel">
    <h3>🧑‍🌾 地块操作</h3>
    <div v-if="!store.selectedPlot" class="empty">点击上方网格中的耕地选择地块</div>
    <template v-else>
      <p class="info">地块 ({{ p.x }},{{ p.y }})</p>

      <!-- 状态条 -->
      <div class="stat">
        <span>💧 水分</span><div class="bar"><i :style="{width:p.water+'%',background: barColor(p.water)}"></i></div><b>{{ Math.round(p.water) }}</b>
      </div>
      <div class="stat">
        <span>🟫 肥力</span><div class="bar"><i :style="{width:p.fert+'%',background: barColor(p.fert)}"></i></div><b>{{ Math.round(p.fert) }}</b>
      </div>
      <div class="stat">
        <span>☀️ 光照</span><div class="bar"><i :style="{width:p.light+'%',background: barColor(p.light)}"></i></div><b>{{ Math.round(p.light) }}</b>
      </div>
      <div class="stat pest">
        <span>🐛 虫害</span><div class="bar"><i :style="{width: Math.min(100,p.pest*40)+'%',background:'#ef5350'}"></i></div><b>{{ p.pest>0?p.pest:'' }}</b>
      </div>

      <!-- 灌溉：接通状态 + 供水优先级 -->
      <div class="irr-row">
        <span class="irr-state" :class="{on: p.irrigated}">{{ p.irrigated ? '💧 灌溉已接通' : '🚱 未接通水渠' }}</span>
        <span class="irr-prio">
          优先级
          <button v-for="(l, i) in ['低','中','高']" :key="i"
                  :class="{sel: (p.irr_priority ?? 1) === i}"
                  @click="store.setIrrPriority(p.id, i)">{{ l }}</button>
        </span>
      </div>

      <div class="divider"></div>

      <!-- 空地：播种 -->
      <template v-if="!p.crop_id">
        <div class="seed-crops">
          <button v-for="c in store.crops" :key="c.id"
                  class="seed-opt"
                  :class="{sel: store.selectedCropId===c.id}"
                  @click="store.selectedCropId = c.id">
            <span class="sc-icon">{{ c.sprite }}</span>
            <span class="sc-name">{{ c.name }}</span>
            <span class="sc-days">{{ c.days }}天</span>
            <span class="sc-seed">种{{ c.seedPrice }}</span>
          </button>
        </div>
        <button class="action primary" @click="store.plant()" :disabled="!store.selectedCropId">🌱 播种</button>
      </template>

      <!-- 已种：养护操作 -->
      <template v-else>
        <div class="crop-line">
          <span class="crop-sprite">{{ crop?.sprite }}</span>
          <span>{{ crop?.name }}</span>
          <span class="stage" :class="{full:isGrown}">{{ isGrown ? '已成熟' : '生长 ' + p.stage + '/' + (crop?.days-1 || 0) }}</span>
        </div>
        <div class="actions-grid">
          <button class="action" @click="store.water()">💧 浇水</button>
          <button class="action" @click="store.fertilize()">🟫 施肥</button>
          <button class="action" @click="store.clean()">🧹 除虫</button>
          <button class="action harvest" @click="store.harvest()">🧺 收获</button>
        </div>
      </template>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useGameStore } from '@/store/game'
const store = useGameStore()
const p = computed(() => store.selectedPlot || {})
const crop = computed(() => store.crops.find((c) => c.id === p.value.crop_id))
const isGrown = computed(() => crop.value && p.value.stage >= (crop.value.days - 1))
function barColor(v) { return v < 30 ? '#ef5350' : v < 60 ? '#ffb300' : '#4caf50' }
</script>

<style scoped>
.panel { background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px; }
h3 { margin:0 0 10px;color:#fff;font-size:15px; }
.empty { color:#5b6f94;font-size:12px;padding:10px 0;text-align:center; }
.info { color:#8ba2c8;font-size:12px;margin:0 0 8px; }
.stat { display:flex;align-items:center;gap:6px;margin-bottom:5px;font-size:12px;color:#c6d2e6; }
.stat > span { width:58px; }
.stat b { min-width:24px;text-align:right;color:#ffd54f; }
.bar { flex:1;height:8px;background:#0c1730;border-radius:4px;overflow:hidden; }
.bar i { display:block;height:100%;border-radius:4px; }
.divider { height:1px;background:rgba(120,160,220,0.15);margin:10px 0; }
.irr-row { display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:8px;font-size:11px; }
.irr-state { color:#8ba2c8; }
.irr-state.on { color:#4fc3f7; }
.irr-prio { display:flex;align-items:center;gap:3px;color:#6f84ab; }
.irr-prio button {
  background:#16263f;border:1px solid rgba(120,160,220,0.2);color:#8ba2c8;border-radius:5px;
  padding:2px 7px;font-size:10px;cursor:pointer;
}
.irr-prio button.sel { background:#0277bd;color:#fff;border-color:#29b6f6; }

.seed-crops { display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;max-height:180px;overflow-y:auto; }
.seed-opt {
  display:flex;flex-direction:column;align-items:center;gap:2px;min-width:64px;
  background:#16263f;border:1px solid rgba(120,160,220,0.2);border-radius:8px;padding:6px 4px;
  cursor:pointer;color:#dbe4f3;font-size:11px;
}
.seed-opt.sel { border-color:#ffd54f;box-shadow:0 0 0 1px #ffd54f; }
.sc-icon { font-size:20px; }
.sc-days { color:#8ba2c8; }
.sc-seed { color:#ffc107; }

.action {
  width:100%;margin-top:6px;background:#4381ff;border:none;border-radius:9px;
  color:#fff;padding:10px;font-size:13px;cursor:pointer;font-weight:600;
}
.action.primary { background:linear-gradient(135deg,#43a047,#2e7d32); }
.action.harvest { background:linear-gradient(135deg,#ffb300,#f57c00); }
.action:hover { filter:brightness(1.1); }
.action:disabled { background:#2a3a5e;color:#6f84ab;cursor:not-allowed; }
.actions-grid { display:grid;grid-template-columns:1fr 1fr;gap:6px; }
.actions-grid .action { width:auto;margin-top:2px; }
.crop-line { display:flex;align-items:center;gap:8px;color:#dbe4f3;font-size:13px;margin-bottom:6px; }
.crop-sprite { font-size:22px; }
.stage { margin-left:auto;color:#8ba2c8;font-size:11px; }
.stage.full { color:#ffd54f;font-weight:700; }
</style>
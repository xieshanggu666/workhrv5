<template>
  <div class="breed-page">
    <!-- 左列：开展试验 -->
    <div class="pcol card">
      <h4>🧬 育种坊 <span class="lvl">Lv.{{ lab.level }}</span></h4>
      <div class="queue-stat">
        试验位 <b :class="{full: store.breedingUsed >= store.breedingSlots}">{{ store.breedingUsed }}/{{ store.breedingSlots }}</b>
        <span class="tag">每批投入两亲本各 ×2 + 🪙{{ startCost }}</span>
      </div>

      <div v-if="!cropOptions.length" class="none">背包里还没有作物，先去收获两批不同的作物吧</div>
      <template v-else>
        <div class="parent-pick">
          <span class="pp-label">亲本 A</span>
          <select v-model.number="parentA">
            <option :value="null" disabled>选择作物批次</option>
            <option v-for="o in cropOptions" :key="o.cropId" :value="o.cropId">
              {{ o.icon }} {{ o.name }} ×{{ o.qty }}{{ o.variety ? '（杂交）' : '' }}
            </option>
          </select>
        </div>
        <div class="parent-pick">
          <span class="pp-label">亲本 B</span>
          <select v-model.number="parentB">
            <option :value="null" disabled>选择作物批次</option>
            <option v-for="o in cropOptions" :key="o.cropId" :value="o.cropId">
              {{ o.icon }} {{ o.name }} ×{{ o.qty }}{{ o.variety ? '（杂交）' : '' }}
            </option>
          </select>
        </div>
        <button class="wide start" :disabled="!canStart" @click="doStart">
          🧪 开始杂交（两亲本需为不同作物）
        </button>
        <p class="hint">
          性状在亲本间遗传并有概率变异，育种坊等级越高变异率越高。试验期间每日消耗墒情与养分，
          记得回来浇水/施肥；恶劣天气会损伤秧苗，健康度过低会失败。亲本带耐旱/抗寒/强韧性状可保护试验。
        </p>
      </template>

      <button class="wide" @click="store.upgradeBuilding(lab.id)">
        🔧 升级育种坊（🪙{{ lab.level * 40 }}）→ +1 试验位、提高变异率
      </button>
    </div>

    <!-- 右列：试验列表 -->
    <div class="pcol card">
      <h4>🌡️ 试验进度</h4>
      <div v-if="!store.breedingTrials.length" class="none">尚无试验，去左侧投入两批作物开始培育吧</div>
      <div v-for="t in store.breedingTrials" :key="t.id" class="trial" :class="t.status">
        <div class="t-head">
          <span class="t-cross">
            #{{ t.id }} {{ t.parentA?.sprite }} {{ t.parentA?.name }}
            <i>×</i>
            {{ t.parentB?.sprite }} {{ t.parentB?.name }}
          </span>
          <span class="t-state" :class="t.status">{{ stateText(t) }}</span>
        </div>

        <template v-if="t.status === 'growing'">
          <div class="t-bar"><i :style="{ width: progress(t) + '%' }"></i></div>
          <div class="t-stats">
            <span>💧{{ t.water }}</span><span>🟫{{ t.fert }}</span>
            <span :class="{ low: t.health <= 25 }">❤️{{ t.health }}</span>
            <span>⏳ 剩 {{ t.remainDays }} 天</span>
          </div>
          <div class="t-btns">
            <button class="mini" @click="store.careBreeding(t.id, 'water')">💧 浇水</button>
            <button class="mini" @click="store.careBreeding(t.id, 'fert')">🟫 施肥</button>
            <button class="mini warn" @click="store.cancelBreeding(t.id)">放弃（退半费）</button>
          </div>
        </template>

        <template v-else>
          <div v-if="t.status === 'success' && t.result" class="t-result">
            <b>{{ t.result.sprite }} {{ t.result.name }}</b>
            <span class="traits">
              <i v-for="tr in t.result.traits" :key="tr" class="trait">{{ traitIcon(tr) }}{{ traitName(tr) }}</i>
            </span>
            <span class="tag">种子 ×{{ t.seeds }} 已自动入库，可直接播种</span>
          </div>
          <div v-else class="t-result fail">秧苗未能成活，没有收获种子</div>
          <button class="mini" @click="store.clearBreeding(t.id)">清除记录</button>
        </template>
      </div>
    </div>

    <!-- 品种图鉴 + 谱系 -->
    <div class="pcol card span2">
      <h4>📖 品种图鉴与谱系（{{ store.varieties.length }}）</h4>
      <div v-if="!store.varieties.length" class="none">还没有培育出新品种。杂交成功的新品种会在此登记，并保留完整谱系。</div>
      <div class="codex">
        <div v-for="v in store.varieties" :key="v.crop_id" class="variety">
          <div class="v-main">
            <span class="v-icon">{{ v.sprite }}</span>
            <div class="v-info">
              <b>{{ v.name }}</b>
              <span class="traits">
                <i v-for="tr in v.traits" :key="tr" class="trait">{{ traitIcon(tr) }}{{ traitName(tr) }}</i>
              </span>
              <span class="tag">{{ v.days }}天成熟</span>
              <span class="tag">宜{{ ['春', '夏', '秋', '冬'][v.season] }}</span>
              <span class="tag">售价 🪙{{ v.price }}</span>
              <span class="tag">F{{ v.gen }}</span>
            </div>
          </div>
          <div class="pedigree">
            <PedigreeNode :crop-id="v.crop_id" :depth="0" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, h } from 'vue'
import { useGameStore } from '@/store/game'

const store = useGameStore()
const parentA = ref(null)
const parentB = ref(null)
const startCost = 15

const lab = computed(() => store.buildings.find((b) => b.id === 5) || { id: 5, level: 1 })

// 背包中可作为亲本的作物批次（cat=crop），聚合同名品种信息
const cropOptions = computed(() =>
  store.inventory
    .filter((it) => it.cat === 'crop')
    .map((it) => {
      const cropId = Number(it.item_id.split('-')[1])
      const crop = store.crops.find((c) => c.id === cropId)
      const variety = store.varietyMap.get(cropId)
      return {
        cropId,
        qty: it.qty,
        name: crop?.name || it.name,
        icon: crop?.sprite || '🧺',
        variety
      }
    })
    .filter((o) => o.qty >= 2)
)
const canStart = computed(() =>
  parentA.value != null && parentB.value != null &&
  parentA.value !== parentB.value &&
  store.breedingUsed < store.breedingSlots &&
  (store.player?.gold ?? 0) >= startCost
)
async function doStart() {
  try {
    await store.startBreeding(parentA.value, parentB.value)
    parentA.value = null
    parentB.value = null
  } catch { /* toast 已提示 */ }
}

function progress(t) {
  return Math.min(100, Math.round((t.elapsed / t.days_total) * 100))
}
function stateText(t) {
  if (t.status === 'growing') return `培育中 ${t.elapsed}/${t.days_total}`
  return t.status === 'success' ? '✓ 培育成功' : '✕ 失败'
}
function traitName(id) { return store.traitBook[id]?.name || id }
function traitIcon(id) { return store.traitBook[id]?.icon || '•' }

// 谱系节点：递归渲染亲本树（原生作物为叶子），深度过深时折叠
const cropById = (id) => store.crops.find((c) => c.id === id)
const varietyById = (id) => store.varietyMap.get(id)
const PedigreeNode = {
  name: 'PedigreeNode',
  props: { cropId: Number, depth: Number },
  setup(props) {
    return () => {
      const crop = cropById(props.cropId)
      const v = varietyById(props.cropId)
      if (!crop) return h('span', { class: 'pg-missing' }, '未知亲本')
      const badge = h('span', { class: ['pg-node', v ? 'hybrid' : 'base'] }, [
        h('span', { class: 'pg-icon' }, crop.sprite),
        crop.name,
        v && props.depth < 4
          ? h('i', { class: 'pg-gen' }, `F${v.gen}`)
          : h('i', { class: 'pg-gen base' }, '原生')
      ])
      if (!v || props.depth >= 4) return badge
      return h('div', { class: 'pg-branch' }, [
        badge,
        h('div', { class: 'pg-parents' }, [
          h(PedigreeNode, { cropId: v.parent_a_crop, depth: props.depth + 1 }),
          h(PedigreeNode, { cropId: v.parent_b_crop, depth: props.depth + 1 })
        ])
      ])
    }
  }
}
</script>

<style scoped>
.breed-page { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.span2 { grid-column: 1 / -1; }
.pcol { display: flex; flex-direction: column; gap: 2px; }
.card { background: #0f1b38; border: 1px solid rgba(120, 160, 220, 0.16); border-radius: 12px; padding: 16px; }
h4 { margin: 0 0 8px; color: #fff; display: flex; gap: 8px; align-items: center; }
.lvl { font-size: 11px; color: #ffd54f; }
.queue-stat { font-size: 12px; color: #aebadd; margin-bottom: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.queue-stat b { color: #a5d6a7; font-size: 14px; }
.queue-stat b.full { color: #ef9a9a; }
.tag { font-size: 10px; color: #6f84ab; background: #16263f; padding: 2px 6px; border-radius: 4px; }
.none { color: #5b6f94; text-align: center; padding: 20px; font-size: 12px; }
.hint { font-size: 11px; color: #8ba2c8; line-height: 1.6; margin: 8px 0 4px; }
.wide { width: 100%; margin-top: 12px; background: #16263f; border: 1px solid rgba(255, 213, 79, 0.3); color: #ffd54f; border-radius: 9px; padding: 10px; font-size: 13px; cursor: pointer; }
.wide.start { background: linear-gradient(135deg, #6a1b9a, #8e24aa); border-color: transparent; color: #fff; font-weight: 600; }
.wide:disabled { background: #2a3a5e; color: #6f84ab; border-color: transparent; cursor: not-allowed; }
.parent-pick { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.pp-label { font-size: 12px; color: #8ba2c8; width: 44px; }
.parent-pick select { flex: 1; background: #16263f; color: #dbe4f3; border: 1px solid rgba(120, 160, 220, 0.25); border-radius: 7px; padding: 8px; font-size: 12px; }

.trial { border: 1px solid rgba(120, 160, 220, 0.14); border-radius: 9px; padding: 10px; margin-bottom: 8px; background: #122038; }
.trial.success { border-color: rgba(76, 175, 80, 0.45); background: rgba(67, 160, 71, 0.07); }
.trial.fail { border-color: rgba(239, 83, 80, 0.35); opacity: 0.85; }
.t-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 6px; }
.t-cross { font-size: 12px; color: #dbe4f3; }
.t-cross i { color: #6f84ab; font-style: normal; margin: 0 3px; }
.t-state { font-size: 10px; padding: 2px 7px; border-radius: 5px; white-space: nowrap; }
.t-state.growing { color: #90caf9; background: #122a47; }
.t-state.success { color: #a5d6a7; background: #1b3a21; }
.t-state.fail { color: #ef9a9a; background: #3a1f1f; }
.t-bar { height: 6px; background: #0c1730; border-radius: 4px; overflow: hidden; }
.t-bar i { display: block; height: 100%; background: linear-gradient(90deg, #ab47bc, #7e57c2); }
.t-stats { display: flex; gap: 10px; font-size: 11px; color: #aebadd; margin: 6px 0; }
.t-stats .low { color: #ef5350; font-weight: 700; }
.t-btns { display: flex; gap: 6px; }
.mini { background: #2962ff; border: none; color: #fff; border-radius: 7px; padding: 6px 10px; font-size: 12px; cursor: pointer; }
.mini.warn { background: #6d4c41; }
.t-result { font-size: 12px; color: #dbe4f3; display: flex; flex-direction: column; gap: 4px; margin: 4px 0 8px; }
.t-result.fail { color: #ef9a9a; }

.traits { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.trait { font-style: normal; font-size: 10px; color: #ce93d8; background: #2a1b3d; border: 1px solid rgba(206, 147, 216, 0.3); padding: 1px 6px; border-radius: 5px; }

.codex { display: flex; flex-direction: column; gap: 10px; }
.variety { background: #122038; border: 1px solid rgba(120, 160, 220, 0.12); border-radius: 10px; padding: 10px 12px; }
.v-main { display: flex; gap: 10px; align-items: flex-start; }
.v-icon { font-size: 26px; }
.v-info { flex: 1; display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.v-info b { font-size: 13px; color: #e8eefb; width: 100%; }
.pedigree { margin-top: 8px; padding-top: 8px; border-top: 1px dashed rgba(120, 160, 220, 0.14); font-size: 11px; }

/* 谱系树 */
.pg-branch { display: flex; flex-direction: column; gap: 3px; }
.pg-parents { display: flex; gap: 14px; margin-left: 14px; padding-left: 10px; border-left: 1px dashed rgba(120, 160, 220, 0.3); }
.pg-node { display: inline-flex; align-items: center; gap: 3px; padding: 1px 7px; border-radius: 6px; white-space: nowrap; }
.pg-node.hybrid { color: #ce93d8; background: #241a38; border: 1px solid rgba(206, 147, 216, 0.35); }
.pg-node.base { color: #a5d6a7; background: #16261f; border: 1px solid rgba(165, 214, 167, 0.25); }
.pg-gen { font-style: normal; font-size: 9px; color: #b39ddb; }
.pg-gen.base { color: #6f84ab; }
.pg-missing { color: #ef9a9a; font-size: 10px; }
</style>

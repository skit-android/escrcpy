<template>
  <div class="grid-view h-full flex flex-col overflow-hidden">
    <div v-if="devices.length" class="grid-toolbar flex-none flex items-center gap-3 px-2 py-1">
      <el-switch
        v-model="syncInput"
        inline-prompt
        :active-text="$t('grid.sync.on')"
        :inactive-text="$t('grid.sync.off')"
      />
      <span v-if="syncInput" class="text-xs text-warning">{{ $t('grid.sync.hint') }}</span>
      <div class="flex-1" />
      <el-button size="small" @click="wakeAll">
        {{ $t('grid.wakeAll') }}
      </el-button>
    </div>

    <div v-if="!devices.length" class="flex-1 flex items-center justify-center text-sm text-gray-400">
      {{ $t('grid.empty') }}
    </div>
    <div
      v-else
      class="grid-tiles flex-1 min-h-0 grid gap-2 p-1"
      :style="gridStyle"
    >
      <GridTile
        v-for="device in devices"
        :key="device.id"
        :ref="el => registerTile(device.id, el)"
        :device="device"
        :active="active"
        @gesture="onGesture"
      />
    </div>
  </div>
</template>

<script setup>
import GridTile from './components/grid-tile.vue'

const deviceStore = useDeviceStore()

const active = ref(false)
const devices = ref([])
const syncInput = ref(false)

// 타일 인스턴스 참조(브로드캐스트/깨우기용)
const tileRefs = new Map()
function registerTile(id, el) {
  if (el) tileRefs.set(id, el)
  else tileRefs.delete(id)
}

// 그룹 컨트롤: sync 켜지면 한 제스처를 전 기기에 분수좌표로 브로드캐스트
// (각 타일이 자기 해상도로 정규화 → 이기종 기기 동시 조작)
function onGesture(g) {
  if (syncInput.value) {
    for (const tile of tileRefs.values()) {
      tile.injectAt?.(g.fx, g.fy, g.action, g.pressure)
    }
  }
  else {
    tileRefs.get(g.deviceId)?.injectAt?.(g.fx, g.fy, g.action, g.pressure)
  }
}

function wakeAll() {
  for (const tile of tileRefs.values()) {
    tile.wake?.()
  }
}

function connectedOnly(list) {
  return list.filter(item => item.type === 'device')
}

async function refreshDevices() {
  const list = await deviceStore.getList()
  devices.value = connectedOnly(list)
}

function onAdbWatch(action) {
  if (['add', 'remove'].includes(action)) {
    refreshDevices()
  }
}

const gridStyle = computed(() => {
  const n = devices.value.length
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3
  return {
    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    gridAutoRows: '1fr',
  }
})

let unAdbWatch = null

onMounted(async () => {
  await refreshDevices()
  active.value = true
  unAdbWatch = await window.$preload.adb.watch(onAdbWatch)
})

onActivated(async () => {
  await refreshDevices()
  active.value = true
})

onDeactivated(() => {
  active.value = false
})

onBeforeUnmount(() => {
  active.value = false
  unAdbWatch?.()
})
</script>

<style lang="postcss" scoped>
.grid-toolbar {
  border-bottom: 1px solid var(--el-border-color-light);
}
.text-warning {
  color: var(--el-color-warning);
}
.grid-tiles {
  height: 100%;
}
</style>

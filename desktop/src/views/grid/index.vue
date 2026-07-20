<template>
  <div class="grid-view absolute inset-0 flex flex-col">
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
        :device="device"
        :active="active"
      />
    </div>
  </div>
</template>

<script setup>
import GridTile from './components/grid-tile.vue'

const deviceStore = useDeviceStore()

const active = ref(false)
const devices = ref([])

// 연결된(스트림 가능한) 기기만
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

// 열 수: 기기 수 기반(2대=2열, 3~4대=2열, 5+=3열)
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

// keep-alive 재진입: 스트림 재개 + 기기 목록 갱신
onActivated(async () => {
  await refreshDevices()
  active.value = true
})

// keep-alive 이탈: 스트림 정지(CPU/대역폭 절약)
onDeactivated(() => {
  active.value = false
})

onBeforeUnmount(() => {
  active.value = false
  unAdbWatch?.()
})
</script>

<style lang="postcss" scoped>
.grid-tiles {
  height: 100%;
}
</style>

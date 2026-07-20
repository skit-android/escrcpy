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
      <el-button-group>
        <el-button size="small" icon="Back" :title="$t('grid.nav.back')" @click="broadcastKey(KEY_BACK)" />
        <el-button size="small" icon="HomeFilled" :title="$t('grid.nav.home')" @click="broadcastKey(KEY_HOME)" />
        <el-button size="small" icon="Grid" :title="$t('grid.nav.recents')" @click="broadcastKey(KEY_APP_SWITCH)" />
      </el-button-group>
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
        @scroll="onScroll"
      />
    </div>
  </div>
</template>

<script setup>
import GridTile from './components/grid-tile.vue'

const deviceStore = useDeviceStore()

// android.view.KeyEvent codes for the toolbar navigation buttons.
const KEY_HOME = 3
const KEY_BACK = 4
const KEY_APP_SWITCH = 187

const active = ref(false)
const devices = ref([])
const syncInput = ref(false)

// Tile component instances, keyed by device id (for input broadcast / wake).
const tileRefs = new Map()
function registerTile(id, el) {
  if (el) {
    tileRefs.set(id, el)
  }
  else {
    tileRefs.delete(id)
  }
}

// Group control: with sync on, a gesture on one tile is broadcast to every
// device as a fraction; each tile maps it to its own resolution, so devices of
// different sizes stay in step. With sync off, only the touched device reacts.
function onGesture(gesture) {
  const targets = syncInput.value
    ? [...tileRefs.values()]
    : [tileRefs.get(gesture.deviceId)]
  for (const tile of targets) {
    tile?.injectAt?.(gesture.fx, gesture.fy, gesture.action, gesture.pressure)
  }
}

function onScroll(gesture) {
  const targets = syncInput.value
    ? [...tileRefs.values()]
    : [tileRefs.get(gesture.deviceId)]
  for (const tile of targets) {
    tile?.scrollAt?.(gesture.fx, gesture.fy, gesture.deltaY)
  }
}

// Toolbar navigation keys are grid-wide: send the key to every device at once,
// which is the correct way to drive Back/Home/Recents across devices whose
// navigation styles (gesture vs. buttons) put them in different places.
function broadcastKey(keyCode) {
  for (const tile of tileRefs.values()) {
    tile.pressKey?.(keyCode)
  }
}

function wakeAll() {
  for (const tile of tileRefs.values()) {
    tile.wake?.()
  }
}

// Only devices that are online and streamable (exclude offline/unauthorized).
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
  const count = devices.value.length
  const columns = count <= 1 ? 1 : count <= 4 ? 2 : 3
  return {
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    gridAutoRows: '1fr',
  }
})

let unAdbWatch = null

onMounted(async () => {
  await refreshDevices()
  active.value = true
  unAdbWatch = await window.$preload.adb.watch(onAdbWatch)
})

// The layout keeps this view alive across tab switches, so drive streaming from
// activation: resume on re-entry, stop when hidden to free CPU and bandwidth.
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

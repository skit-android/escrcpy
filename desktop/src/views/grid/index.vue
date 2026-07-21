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
      ref="containerRef"
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
        @keycode="onKeyCode"
        @text="onText"
        @reorder="onReorder"
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

// Keyboard input follows the same sync rule as touch: broadcast to every tile
// when group control is on, otherwise only the tile that has keyboard focus.
function onKeyCode(evt) {
  const targets = syncInput.value
    ? [...tileRefs.values()]
    : [tileRefs.get(evt.deviceId)]
  for (const tile of targets) {
    tile?.injectKeyCode?.(evt.action, evt.keyCode, evt.repeat, evt.metaState)
  }
}

function onText(evt) {
  const targets = syncInput.value
    ? [...tileRefs.values()]
    : [tileRefs.get(evt.deviceId)]
  for (const tile of targets) {
    tile?.injectText?.(evt.text)
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

// User-dragged tile order, persisted across restarts and applied on top of
// deviceStore's default (status-based) order. Devices not yet in the saved
// order - newly connected ones - keep their relative order and land at the end.
function getSavedOrder() {
  return window.$preload.store.get('grid')?.deviceOrder || []
}

function saveOrder(list) {
  window.$preload.store.set(['grid', 'deviceOrder'], list.map(device => device.id))
}

function applyOrder(list) {
  const order = getSavedOrder()
  if (!order.length)
    return list
  const rank = new Map(order.map((id, index) => [id, index]))
  const known = []
  const unknown = []
  for (const device of list)
    (rank.has(device.id) ? known : unknown).push(device)
  known.sort((a, b) => rank.get(a.id) - rank.get(b.id))
  return [...known, ...unknown]
}

async function refreshDevices() {
  const list = await deviceStore.getList()
  devices.value = applyOrder(connectedOnly(list))
}

function onReorder({ fromId, toId }) {
  const fromIndex = devices.value.findIndex(device => device.id === fromId)
  const toIndex = devices.value.findIndex(device => device.id === toId)
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex)
    return
  const next = [...devices.value]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  devices.value = next
  saveOrder(next)
}

function onAdbWatch(action) {
  if (['add', 'remove'].includes(action)) {
    refreshDevices()
  }
}

// Phone screens are portrait and much taller than wide, so a naive square-ish
// grid (e.g. 2x2 for 4 devices) leaves most of each cell empty on the sides.
// Pick the column count that maximizes total on-screen device area instead,
// which for a wide window naturally lands on a single, more "horizontal" row.
const DEVICE_ASPECT = 9 / 19.5 // typical portrait phone width/height
const GRID_GAP = 8 // px, must match the `gap-2` class on .grid-tiles

const containerRef = ref(null)
const containerSize = ref({ width: 0, height: 0 })
let resizeObserver = null

function bestColumns(count, containerWidth, containerHeight) {
  if (count <= 1)
    return 1
  if (!containerWidth || !containerHeight)
    return 0

  let bestCols = 1
  let bestArea = 0
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols)
    const cellWidth = (containerWidth - GRID_GAP * (cols - 1)) / cols
    const cellHeight = (containerHeight - GRID_GAP * (rows - 1)) / rows
    const tileWidth = Math.min(cellWidth, cellHeight * DEVICE_ASPECT)
    const area = tileWidth * (tileWidth / DEVICE_ASPECT)
    if (area > bestArea) {
      bestArea = area
      bestCols = cols
    }
  }
  return bestCols
}

const gridStyle = computed(() => {
  const count = devices.value.length
  const columns = bestColumns(count, containerSize.value.width, containerSize.value.height)
    || (count <= 4 ? 2 : 3)
  return {
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    gridAutoRows: '1fr',
  }
})

watch(containerRef, (el) => {
  if (el)
    resizeObserver?.observe(el)
})

let unAdbWatch = null

onMounted(async () => {
  resizeObserver = new ResizeObserver((entries) => {
    const { width, height } = entries[0].contentRect
    containerSize.value = { width, height }
  })
  if (containerRef.value)
    resizeObserver.observe(containerRef.value)

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
  resizeObserver?.disconnect()
  resizeObserver = null
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

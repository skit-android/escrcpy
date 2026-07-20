<template>
  <div class="grid-tile flex flex-col min-w-0 min-h-0">
    <div class="tile-title flex-none flex items-center justify-between px-2 py-1 text-xs">
      <span class="truncate">{{ label }}</span>
      <span class="tile-status" :class="statusClass">{{ statusText }}</span>
    </div>
    <div ref="stageRef" class="tile-stage flex-1 min-h-0 flex items-center justify-center">
      <canvas
        ref="canvasRef"
        class="tile-canvas"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      />
    </div>
  </div>
</template>

<script setup>
import {
  BitmapVideoFrameRenderer,
  WebCodecsVideoDecoder,
  WebGLVideoFrameRenderer,
} from '@yume-chan/scrcpy-decoder-webcodecs'

const props = defineProps({
  device: { type: Object, required: true },
  active: { type: Boolean, default: false },
})

const emit = defineEmits(['gesture'])

const AndroidMotionEventAction = { Down: 0, Up: 1, Move: 2 }

const canvasRef = ref(null)
const status = ref('idle') // idle | connecting | streaming | error
const videoSize = ref({ width: 0, height: 0 })

let decoder = null
let writer = null
let sessionId = null
let starting = false
let retryTimer = null

const label = computed(() => props.device.remark || props.device.name || props.device.id)
const statusText = computed(() => ({
  idle: '',
  connecting: '연결 중',
  streaming: '',
  error: '재연결',
}[status.value] || ''))
const statusClass = computed(() => `is-${status.value}`)

async function start() {
  if (starting || sessionId) return
  starting = true
  status.value = 'connecting'
  try {
    const renderer = WebGLVideoFrameRenderer.isSupported
      ? new WebGLVideoFrameRenderer(canvasRef.value)
      : new BitmapVideoFrameRenderer(canvasRef.value)

    const info = await window.$preload.grid.startSession(props.device.id, {
      onPacket: async (pkt) => {
        if (!writer) return
        await writer.write(pkt)
      },
      onExit: () => {
        handleDisconnect()
      },
    })

    sessionId = info.id
    videoSize.value = { width: info.width, height: info.height }

    decoder = new WebCodecsVideoDecoder({ codec: info.codec, renderer })
    writer = decoder.writable.getWriter()
    decoder.sizeChanged((size) => {
      videoSize.value = { width: size.width, height: size.height }
    })
    status.value = 'streaming'
  }
  catch (error) {
    console.warn('grid-tile.start.error', props.device.id, error?.message || error)
    handleDisconnect()
  }
  finally {
    starting = false
  }
}

async function stop() {
  clearTimeout(retryTimer)
  retryTimer = null
  const id = sessionId
  sessionId = null
  try { await writer?.close?.() } catch {}
  writer = null
  try { decoder?.dispose?.() } catch {}
  decoder = null
  if (id) {
    try { await window.$preload.grid.stopSession(id) } catch {}
  }
  if (status.value !== 'error') status.value = 'idle'
}

function handleDisconnect() {
  // G0.6: 스트림 단절 시 세션 정리 후 백오프 재기동(활성 상태일 때만)
  status.value = 'error'
  stop().then(() => {
    status.value = 'error'
    if (props.active) {
      clearTimeout(retryTimer)
      retryTimer = setTimeout(() => {
        if (props.active) start()
      }, 2000)
    }
  })
}

// 포인터 위치를 canvas 표시영역 비율(0~1)로 환산
function toFraction(e) {
  const rect = canvasRef.value.getBoundingClientRect()
  return {
    fx: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
    fy: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
  }
}

// 브로드캐스트 진입점: 분수좌표를 이 기기의 현재 비디오 픽셀로 정규화해 주입.
// (그룹 컨트롤의 이기종 해상도 정규화 — 각 타일이 자기 videoSize로 매핑)
function injectAt(fx, fy, action, pressure) {
  if (!sessionId || !videoSize.value.width) return
  const { width, height } = videoSize.value
  window.$preload.grid.injectTouch(sessionId, {
    action,
    pressure,
    pointerX: Math.round(fx * width),
    pointerY: Math.round(fy * height),
    videoWidth: width,
    videoHeight: height,
  })
}

let pointerDown = false

function onPointerDown(e) {
  if (!sessionId || !videoSize.value.width) return
  pointerDown = true
  canvasRef.value.setPointerCapture(e.pointerId)
  const { fx, fy } = toFraction(e)
  emit('gesture', { deviceId: props.device.id, fx, fy, action: AndroidMotionEventAction.Down, pressure: 1 })
}

function onPointerMove(e) {
  if (!pointerDown || !sessionId) return
  const { fx, fy } = toFraction(e)
  emit('gesture', { deviceId: props.device.id, fx, fy, action: AndroidMotionEventAction.Move, pressure: 1 })
}

function onPointerUp(e) {
  if (!pointerDown || !sessionId) return
  pointerDown = false
  const { fx, fy } = toFraction(e)
  emit('gesture', { deviceId: props.device.id, fx, fy, action: AndroidMotionEventAction.Up, pressure: 0 })
}

watch(() => props.active, (active) => {
  if (active) start()
  else stop()
})

onMounted(() => {
  if (props.active) start()
})

onBeforeUnmount(() => {
  stop()
})

async function wake() {
  if (sessionId) {
    try { await window.$preload.grid.backOrScreenOn(sessionId) } catch {}
  }
}

defineExpose({ start, stop, injectAt, wake, deviceId: props.device.id })
</script>

<style lang="postcss" scoped>
.grid-tile {
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  overflow: hidden;
  background: #000;
}
.tile-title {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
}
.tile-status.is-connecting { color: var(--el-color-warning); }
.tile-status.is-error { color: var(--el-color-danger); }
.tile-stage {
  background: #000;
}
.tile-canvas {
  max-width: 100%;
  max-height: 100%;
  touch-action: none;
}
</style>

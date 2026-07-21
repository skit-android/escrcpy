<template>
  <div class="grid-tile flex flex-col min-w-0 min-h-0">
    <div
      class="tile-title flex-none flex items-center gap-1 px-2 py-1 text-xs"
      :class="{ 'is-drag-over': isDragOver }"
      draggable="true"
      :title="$t('grid.reorder.hint')"
      @dragstart="onDragStart"
      @dragenter.prevent="onDragEnter"
      @dragleave="onDragLeave"
      @dragover.prevent
      @drop="onDrop"
    >
      <el-icon class="tile-drag-handle">
        <Rank />
      </el-icon>
      <span class="truncate flex-1">{{ label }}</span>
      <span class="tile-status" :class="statusClass">{{ statusText ? $t(statusText) : '' }}</span>
    </div>
    <div class="tile-stage flex-1 min-h-0 flex items-center justify-center">
      <canvas
        ref="canvasRef"
        class="tile-canvas"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @wheel.prevent="onWheel"
      />
      <!--
        Offscreen input that owns keyboard focus for this tile. Routing through a
        real editable element (instead of listening on the canvas) is what makes
        IME composition work, so typing Korean/Japanese/Chinese reaches the
        device the same way it would through a native keyboard.
      -->
      <textarea
        ref="keyboardInputRef"
        class="tile-keyboard-input"
        tabindex="-1"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        @keydown="onKeyDown"
        @keyup="onKeyUp"
        @input="onTextInput"
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

const emit = defineEmits(['gesture', 'scroll', 'keycode', 'text', 'reorder'])

const AndroidMotionEventAction = { Down: 0, Up: 1, Move: 2 }
const AndroidKeyEventAction = { Down: 0, Up: 1 }

// android.view.KeyEvent meta flags, only the bits we combine from modifier keys.
const META_SHIFT = 1
const META_ALT = 2
const META_CTRL = 4096
const META_META = 65536

// KeyboardEvent.code -> android.view.KeyEvent code, for the physical keys we
// forward as raw key events (control/navigation keys and modifier shortcuts).
// Ordinary character keys are left to `onTextInput` so shift state, dead keys
// and IME composition are resolved by the browser instead of reimplemented.
const CODE_TO_ANDROID_KEYCODE = {
  Digit0: 7,
  Digit1: 8,
  Digit2: 9,
  Digit3: 10,
  Digit4: 11,
  Digit5: 12,
  Digit6: 13,
  Digit7: 14,
  Digit8: 15,
  Digit9: 16,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  KeyA: 29,
  KeyB: 30,
  KeyC: 31,
  KeyD: 32,
  KeyE: 33,
  KeyF: 34,
  KeyG: 35,
  KeyH: 36,
  KeyI: 37,
  KeyJ: 38,
  KeyK: 39,
  KeyL: 40,
  KeyM: 41,
  KeyN: 42,
  KeyO: 43,
  KeyP: 44,
  KeyQ: 45,
  KeyR: 46,
  KeyS: 47,
  KeyT: 48,
  KeyU: 49,
  KeyV: 50,
  KeyW: 51,
  KeyX: 52,
  KeyY: 53,
  KeyZ: 54,
  Comma: 55,
  Period: 56,
  AltLeft: 57,
  AltRight: 58,
  ShiftLeft: 59,
  ShiftRight: 60,
  Tab: 61,
  Space: 62,
  Enter: 66,
  Backspace: 67,
  Backquote: 68,
  Minus: 69,
  Equal: 70,
  BracketLeft: 71,
  BracketRight: 72,
  Backslash: 73,
  Semicolon: 74,
  Quote: 75,
  Slash: 76,
  PageUp: 92,
  PageDown: 93,
  Escape: 111,
  Delete: 112,
  ControlLeft: 113,
  ControlRight: 114,
  CapsLock: 115,
  ScrollLock: 116,
  MetaLeft: 117,
  MetaRight: 118,
  PrintScreen: 120,
  Pause: 121,
  Home: 122,
  End: 123,
  Insert: 124,
  F1: 131,
  F2: 132,
  F3: 133,
  F4: 134,
  F5: 135,
  F6: 136,
  F7: 137,
  F8: 138,
  F9: 139,
  F10: 140,
  F11: 141,
  F12: 142,
  NumLock: 143,
  Numpad0: 144,
  Numpad1: 145,
  Numpad2: 146,
  Numpad3: 147,
  Numpad4: 148,
  Numpad5: 149,
  Numpad6: 150,
  Numpad7: 151,
  Numpad8: 152,
  Numpad9: 153,
  NumpadDivide: 154,
  NumpadMultiply: 155,
  NumpadSubtract: 156,
  NumpadAdd: 157,
  NumpadDecimal: 158,
  NumpadComma: 159,
  NumpadEnter: 160,
  NumpadEqual: 161,
  ContextMenu: 82,
}

// Keys that must always travel as raw key events, even with no modifier held,
// because they act on the device (navigation, editing) rather than typing text.
const ALWAYS_KEYCODE = new Set([
  'Backspace',
  'Enter',
  'NumpadEnter',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
  'Space',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
])

const canvasRef = ref(null)
const keyboardInputRef = ref(null)
const status = ref('idle') // idle | connecting | streaming | error
const videoSize = ref({ width: 0, height: 0 })

let decoder = null
let writer = null
let sessionId = null
let starting = false
let retryTimer = null

const label = computed(() => props.device.remark || props.device.name || props.device.id)
const statusText = computed(() => ({
  connecting: 'grid.status.connecting',
  error: 'grid.status.error',
}[status.value] || ''))
const statusClass = computed(() => `is-${status.value}`)

const isDragOver = ref(false)

// Dragging the title bar reorders tiles: the dragged device id travels via
// dataTransfer, and the tile under the cursor on drop tells the parent where
// to move it (parent owns `devices` and persists the new order).
function onDragStart(e) {
  e.dataTransfer.setData('text/plain', props.device.id)
  e.dataTransfer.effectAllowed = 'move'
}

function onDragEnter() {
  isDragOver.value = true
}

function onDragLeave() {
  isDragOver.value = false
}

function onDrop(e) {
  isDragOver.value = false
  const fromId = e.dataTransfer.getData('text/plain')
  if (fromId && fromId !== props.device.id)
    emit('reorder', { fromId, toId: props.device.id })
}

// Reconnect backoff bounds.
const BASE_RETRY_MS = 2000
const MAX_RETRY_MS = 30000
let retryCount = 0
let unmounted = false

async function start() {
  if (starting || sessionId)
    return
  starting = true
  status.value = 'connecting'
  try {
    const renderer = WebGLVideoFrameRenderer.isSupported
      ? new WebGLVideoFrameRenderer(canvasRef.value)
      : new BitmapVideoFrameRenderer(canvasRef.value)

    const info = await window.$preload.grid.startSession(props.device.id, {
      onPacket: async (pkt) => {
        if (!writer)
          return
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
    retryCount = 0 // reset backoff on a successful connection
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
  try {
    await writer?.close?.()
  }
  catch {}
  writer = null
  try {
    decoder?.dispose?.()
  }
  catch {}
  decoder = null
  if (id) {
    try {
      await window.$preload.grid.stopSession(id)
    }
    catch {}
  }
  if (status.value !== 'error')
    status.value = 'idle'
}

// On a dropped stream, clean up and retry with exponential backoff, but only
// while the tile is still mounted and its view is active.
function handleDisconnect() {
  if (unmounted)
    return
  status.value = 'error'
  stop().then(() => {
    if (unmounted)
      return
    status.value = 'error'
    if (props.active) {
      const delay = Math.min(BASE_RETRY_MS * 2 ** retryCount, MAX_RETRY_MS)
      retryCount++
      clearTimeout(retryTimer)
      retryTimer = setTimeout(() => {
        if (props.active && !unmounted)
          start()
      }, delay)
    }
  })
}

// Pointer position as a fraction (0-1) of the canvas display area.
function toFraction(e) {
  const rect = canvasRef.value.getBoundingClientRect()
  return {
    fx: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
    fy: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
  }
}

// Broadcast entry point: map a fraction to this device's current video pixels
// and inject. This is what lets group control span devices of different sizes.
function injectAt(fx, fy, action, pressure) {
  if (!sessionId || !videoSize.value.width)
    return
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
  if (!sessionId || !videoSize.value.width)
    return
  // The canvas isn't a focusable element, so the browser's default mousedown
  // action would blur whatever we focus below right after we focus it.
  // Suppressing that default is what makes the focus() below actually stick.
  e.preventDefault()
  pointerDown = true
  canvasRef.value.setPointerCapture(e.pointerId)
  // Clicking a tile is also how it claims keyboard focus, matching how
  // clicking a window pane in Android Studio's Running Devices does.
  keyboardInputRef.value?.focus({ preventScroll: true })
  const { fx, fy } = toFraction(e)
  emit('gesture', { deviceId: props.device.id, fx, fy, action: AndroidMotionEventAction.Down, pressure: 1 })
}

function onPointerMove(e) {
  if (!pointerDown || !sessionId)
    return
  const { fx, fy } = toFraction(e)
  emit('gesture', { deviceId: props.device.id, fx, fy, action: AndroidMotionEventAction.Move, pressure: 1 })
}

function onPointerUp(e) {
  if (!pointerDown || !sessionId)
    return
  pointerDown = false
  const { fx, fy } = toFraction(e)
  emit('gesture', { deviceId: props.device.id, fx, fy, action: AndroidMotionEventAction.Up, pressure: 0 })
}

// Wheel scroll is emitted like a gesture so the parent can broadcast it too.
function onWheel(e) {
  if (!sessionId || !videoSize.value.width)
    return
  const { fx, fy } = toFraction(e)
  emit('scroll', { deviceId: props.device.id, fx, fy, deltaY: e.deltaY })
}

function scrollAt(fx, fy, deltaY) {
  if (!sessionId || !videoSize.value.width)
    return
  const { width, height } = videoSize.value
  window.$preload.grid.injectScroll(sessionId, {
    pointerX: Math.round(fx * width),
    pointerY: Math.round(fy * height),
    videoWidth: width,
    videoHeight: height,
    scrollX: 0,
    scrollY: -Math.sign(deltaY),
  })
}

function metaStateFor(e) {
  let meta = 0
  if (e.shiftKey)
    meta |= META_SHIFT
  if (e.altKey)
    meta |= META_ALT
  if (e.ctrlKey)
    meta |= META_CTRL
  if (e.metaKey)
    meta |= META_META
  return meta
}

// Control/navigation keys and modifier shortcuts (Ctrl/Alt/Meta + key) go as raw
// key events; plain character keys fall through to the textarea and are picked
// up by `onTextInput` instead, so shift state and IME composition stay correct.
function onKeyDown(e) {
  if (!sessionId || e.isComposing)
    return
  const keyCode = CODE_TO_ANDROID_KEYCODE[e.code]
  if (!keyCode)
    return
  const isShortcut = e.ctrlKey || e.altKey || e.metaKey
  if (!ALWAYS_KEYCODE.has(e.code) && !isShortcut)
    return
  e.preventDefault()
  e.stopPropagation()
  emit('keycode', { deviceId: props.device.id, action: AndroidKeyEventAction.Down, keyCode, repeat: e.repeat ? 1 : 0, metaState: metaStateFor(e) })
}

function onKeyUp(e) {
  if (!sessionId)
    return
  const keyCode = CODE_TO_ANDROID_KEYCODE[e.code]
  if (!keyCode)
    return
  const isShortcut = e.ctrlKey || e.altKey || e.metaKey
  if (!ALWAYS_KEYCODE.has(e.code) && !isShortcut)
    return
  e.preventDefault()
  e.stopPropagation()
  emit('keycode', { deviceId: props.device.id, action: AndroidKeyEventAction.Up, keyCode, repeat: 0, metaState: metaStateFor(e) })
}

// Fires for normal typing and, on composition end, with the fully composed
// text (Korean/Japanese/Chinese IME) - mid-composition events are skipped so
// the candidate window isn't disturbed. The field is cleared after every
// commit so it never accumulates stale text.
function onTextInput(e) {
  const value = e.target.value
  if (e.isComposing)
    return
  e.target.value = ''
  if (sessionId && value)
    emit('text', { deviceId: props.device.id, text: value })
}

function injectKeyCode(action, keyCode, repeat, metaState) {
  if (!sessionId)
    return
  window.$preload.grid.injectKeyCode(sessionId, { action, keyCode, repeat, metaState })
    .catch(error => console.warn('grid-tile.injectKeyCode.error', props.device.id, error?.message || error))
}

function injectText(text) {
  if (!sessionId)
    return
  window.$preload.grid.injectText(sessionId, text)
    .catch(error => console.warn('grid-tile.injectText.error', props.device.id, error?.message || error))
}

watch(() => props.active, (active) => {
  if (active) {
    start()
  }
  else {
    stop()
    keyboardInputRef.value?.blur()
  }
})

onMounted(() => {
  if (props.active)
    start()
})

onBeforeUnmount(() => {
  unmounted = true
  stop()
})

async function wake() {
  if (sessionId) {
    try {
      await window.$preload.grid.backOrScreenOn(sessionId)
    }
    catch {}
  }
}

// Send a system key (Back/Home/Recents) to this device.
function pressKey(keyCode) {
  if (sessionId) {
    window.$preload.grid.injectKey(sessionId, keyCode)
  }
}

defineExpose({ start, stop, injectAt, scrollAt, wake, pressKey, injectKeyCode, injectText, deviceId: props.device.id })
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
  cursor: grab;
}
.tile-title.is-drag-over {
  outline: 2px solid var(--el-color-primary);
  outline-offset: -2px;
}
.tile-drag-handle {
  flex: none;
}
.tile-status.is-connecting {
  color: var(--el-color-warning);
}
.tile-status.is-error {
  color: var(--el-color-danger);
}
.tile-stage {
  position: relative;
  background: #000;
}
.tile-canvas {
  max-width: 100%;
  max-height: 100%;
  touch-action: none;
}
.tile-keyboard-input {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  border: none;
  outline: none;
  resize: none;
  opacity: 0;
  pointer-events: none;
}
</style>

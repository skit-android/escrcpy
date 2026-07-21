import fs from 'node:fs/promises'
import adbMiddleware from '$electron/middleware/adb/index.js'
import { extraResolve } from '$electron/process/resources.js'
import { AdbServerClient } from '@yume-chan/adb'
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp'
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from '@yume-chan/adb-scrcpy'
import {
  DefaultServerPath,
  ScrcpyInstanceId,
  ScrcpyPointerId,
} from '@yume-chan/scrcpy'
import { ReadableStream, WritableStream } from '@yume-chan/stream-extra'

// The grid renders device screens in-app by decoding the scrcpy video stream
// with WebCodecs, so it talks to the device through Tango (ya-webadb) rather
// than the external `scrcpy` binary used by the mirror feature.
//
// Tango's scrcpy client speaks the 3.3.x server protocol, so the grid ships its
// own server binary instead of reusing the bundled `scrcpy` binary (4.x). The
// client version is overridden to match the shipped server exactly.
const SERVER_BIN = extraResolve('common/grid/server.bin')
const SERVER_VERSION = '3.3.4'

// Video encoding defaults tuned for showing many devices at once: a smaller
// frame and bitrate than single-window mirroring keeps decode cost low.
const MAX_SIZE = 1024
const VIDEO_BIT_RATE = 4_000_000
const MAX_FPS = 60

const sessions = new Map()
let nextId = 1
let client = null
let guardsInstalled = false

// Tango does not surface a device disconnect through a resolvable promise; when
// the ADB server dies or a device unplugs, a floating read in its internals
// rejects with `ExactReadableEndedError`. Swallow only that class while grid
// sessions are live (each session recovers via its own `onExit`); let every
// other rejection through so unrelated bugs stay loud.
function installGlobalGuards() {
  if (guardsInstalled) {
    return
  }
  guardsInstalled = true
  process.on('unhandledRejection', (reason) => {
    const name = reason?.constructor?.name || ''
    const isSessionDrop = name === 'ExactReadableEndedError' || name === 'AdbServerConnectionError'
    if (isSessionDrop && sessions.size > 0) {
      return
    }
    console.error('grid.unhandledRejection', reason)
  })
}

// Reuse a single connection to the running ADB server. Honours the standard
// `ANDROID_ADB_SERVER_ADDRESS` / `ANDROID_ADB_SERVER_PORT` overrides so the grid
// targets the same server as the rest of the app.
function getClient() {
  if (!client) {
    client = new AdbServerClient(
      new AdbServerNodeTcpConnector({
        host: process.env.ANDROID_ADB_SERVER_ADDRESS || '127.0.0.1',
        port: Number(process.env.ANDROID_ADB_SERVER_PORT) || 5037,
      }),
    )
  }
  return client
}

/**
 * Start a scrcpy video session for a single device.
 *
 * `onPacket` crosses the contextBridge to the renderer's decoder. It may return
 * a promise; the read loop awaits it so decode back-pressure reaches the video
 * stream and the packet queue cannot grow unbounded. `onExit` fires once when
 * the stream ends or errors (the caller owns reconnection).
 *
 * @returns {Promise<{id: string, serial: string, width: number, height: number, codec: number, deviceName: string}>}
 */
export async function startSession(serial, callbacks = {}) {
  installGlobalGuards()
  const { onPacket, onExit } = callbacks

  const adb = await getClient().createAdb({ serial })
  const server = await fs.readFile(SERVER_BIN)
  await AdbScrcpyClient.pushServer(
    adb,
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(server))
        controller.close()
      },
    }),
  )

  // Throws `AdbScrcpyExitedError` (with the server's stderr in `.output`) if the
  // server exits early; the caller surfaces it.
  const scrcpy = await AdbScrcpyClient.start(
    adb,
    DefaultServerPath,
    new AdbScrcpyOptionsLatest(
      {
        video: true,
        audio: false,
        control: true,
        videoCodec: 'h264',
        maxSize: MAX_SIZE,
        videoBitRate: VIDEO_BIT_RATE,
        maxFps: MAX_FPS,
        clipboardAutosync: false,
        scid: ScrcpyInstanceId.random(),
      },
      { version: SERVER_VERSION },
    ),
  )
  scrcpy.output.pipeTo(new WritableStream({ write() {} })).catch(() => {})

  const video = await scrcpy.videoStream

  const id = String(nextId++)
  const session = { id, serial, adb, scrcpy, video, stopped: false }
  sessions.set(id, session)

  ;(async () => {
    const reader = video.stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done || session.stopped) {
          break
        }
        // `pts` is a bigint; it survives the contextBridge unchanged.
        const packet = { type: value.type, keyframe: value.keyframe, data: value.data }
        if (value.pts !== undefined) {
          packet.pts = value.pts
        }
        await onPacket?.(packet)
      }
    }
    catch (error) {
      // A read error is the disconnect signal; the view schedules a reconnect.
      if (!session.stopped) {
        onExit?.(String(error?.message || error))
      }
    }
    finally {
      try {
        reader.releaseLock()
      }
      catch {}
    }
  })()

  return {
    id,
    serial,
    width: video.width,
    height: video.height,
    codec: video.metadata.codec,
    deviceName: video.metadata.deviceName,
  }
}

export async function injectTouch(id, message) {
  const session = sessions.get(id)
  if (!session || session.stopped) {
    return
  }
  await session.scrcpy.controller.injectTouch({
    action: message.action,
    pointerId: ScrcpyPointerId.Finger,
    pointerX: message.pointerX,
    pointerY: message.pointerY,
    videoWidth: message.videoWidth,
    videoHeight: message.videoHeight,
    pressure: message.pressure ?? 1,
    actionButton: 1,
    buttons: message.buttons ?? (message.action === 1 ? 0 : 1),
  })
}

export async function injectScroll(id, message) {
  const session = sessions.get(id)
  if (!session || session.stopped) {
    return
  }
  await session.scrcpy.controller.injectScroll({
    pointerX: message.pointerX,
    pointerY: message.pointerY,
    videoWidth: message.videoWidth,
    videoHeight: message.videoHeight,
    scrollX: message.scrollX ?? 0,
    scrollY: message.scrollY ?? 0,
    buttons: 0,
  })
}

export async function backOrScreenOn(id) {
  const session = sessions.get(id)
  if (!session || session.stopped) {
    return
  }
  // Send a complete key event: wakes the screen, or acts as Back when already on.
  await session.scrcpy.controller.backOrScreenOn(0)
  await session.scrcpy.controller.backOrScreenOn(1)
}

// Inject a system key (android.view.KeyEvent code) as a full Down/Up press.
// Unlike a coordinate tap, this reaches the same action on every device
// regardless of its navigation style (gesture vs. buttons).
export async function injectKey(id, keyCode) {
  const session = sessions.get(id)
  if (!session || session.stopped) {
    return
  }
  await session.scrcpy.controller.injectKeyCode({ action: 0, keyCode, repeat: 0, metaState: 0 })
  await session.scrcpy.controller.injectKeyCode({ action: 1, keyCode, repeat: 0, metaState: 0 })
}

// Inject a single key Down or Up event (as opposed to `injectKey`'s combined
// press), so the renderer can forward real hardware keyboard events.
export async function injectKeyCode(id, message) {
  const session = sessions.get(id)
  if (!session || session.stopped) {
    return
  }
  await session.scrcpy.controller.injectKeyCode({
    action: message.action,
    keyCode: message.keyCode,
    repeat: message.repeat ?? 0,
    metaState: message.metaState ?? 0,
  })
}

// Printable-ASCII check: the bundled server's `injectText` maps characters to
// key events via a Latin virtual-keyboard character map, so anything outside
// this range (Hangul, other CJK, accented Latin, emoji, ...) is silently
// dropped rather than typed.
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/

const ADB_KEYBOARD_IME = 'com.android.adbkeyboard/.AdbIME'

// Devices we've switched to AdbKeyboard this app run, mapped to their prior
// default IME (so it can be restored on quit). Keyed by device serial, not
// grid session id, so it survives the grid's own reconnects.
const originalImeBySerial = new Map()

// One-time-per-device setup for non-ASCII text: install AdbKeyboard (a
// headless IME that types whatever text it's broadcast, unlike the server's
// own key-event injection which can't represent non-Latin scripts) and make
// it the active input method. Cheap no-op on every call after the first.
async function ensureAdbKeyboardActive(serial) {
  if (originalImeBySerial.has(serial)) {
    return
  }
  const installed = await adbMiddleware.installAdbKeyboard(serial)
  if (!installed) {
    throw new Error(`AdbKeyboard is not available on device ${serial}`)
  }
  let previousIme = ''
  try {
    previousIme = (await adbMiddleware.deviceShell(serial, 'settings get secure default_input_method')).trim()
  }
  catch {}
  await adbMiddleware.deviceShell(serial, `ime set ${ADB_KEYBOARD_IME}`)
  // `ime set` doesn't throw on failure (e.g. against a disabled IME) - it
  // just prints a message - so confirm the switch actually landed before
  // caching it as done, or every future keystroke would silently go nowhere.
  const active = (await adbMiddleware.deviceShell(serial, 'settings get secure default_input_method')).trim()
  if (active !== ADB_KEYBOARD_IME) {
    throw new Error(`Failed to activate AdbKeyboard on device ${serial} (still on ${active})`)
  }
  // Record even a blank/"null" previous IME (still a marker that we've
  // switched this device), so we don't redo setup on every keystroke.
  originalImeBySerial.set(serial, previousIme && previousIme !== ADB_KEYBOARD_IME ? previousIme : '')
}

// Give devices back their original keyboard so they aren't left with a
// headless IME (no visible on-screen keyboard) after the app quits.
async function restoreOriginalImes() {
  const entries = [...originalImeBySerial.entries()]
  originalImeBySerial.clear()
  await Promise.all(entries.map(async ([serial, previousIme]) => {
    if (!previousIme) {
      return
    }
    try {
      await adbMiddleware.deviceShell(serial, `ime set ${previousIme}`)
    }
    catch (error) {
      console.warn('grid.restoreOriginalImes.error', serial, error?.message || error)
    }
  }))
}

// Inject composed/printable text (typed characters, IME output) in one shot.
// Non-ASCII text can't be represented as key events by the bundled server, so
// it's routed through AdbKeyboard's broadcast-to-IME mechanism instead - the
// standard scrcpy-community workaround for typing non-Latin scripts.
export async function injectText(id, text) {
  const session = sessions.get(id)
  if (!session || session.stopped) {
    return
  }
  if (PRINTABLE_ASCII.test(text)) {
    await session.scrcpy.controller.injectText(text)
    return
  }
  await ensureAdbKeyboardActive(session.serial)
  const base64 = Buffer.from(text, 'utf8').toString('base64')
  await adbMiddleware.deviceShell(session.serial, `am broadcast -a ADB_INPUT_B64 --es msg ${base64}`)
}

export async function stopSession(id) {
  const session = sessions.get(id)
  if (!session) {
    return
  }
  session.stopped = true
  sessions.delete(id)
  try {
    await session.scrcpy.close()
  }
  catch {}
  try {
    await session.adb.close()
  }
  catch {}
}

export async function stopAll() {
  await Promise.all([...sessions.keys()].map(id => stopSession(id)))
  await restoreOriginalImes()
}

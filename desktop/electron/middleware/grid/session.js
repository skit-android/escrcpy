import fs from 'node:fs/promises'
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

// 번들된 scrcpy 3.3.4 서버. ya-webadb 클라이언트(≤3.3.3 프로토콜)와 version 오버라이드로 매칭.
const SERVER_BIN = extraResolve('common/grid/server.bin')
const SERVER_VERSION = '3.3.4'

// Phase 0 발견(G0.6): adb 서버 단절 시 라이브러리 내부 read 체인이 rejection을 던진다.
// transport.disconnected는 신뢰할 수 없으므로 스트림 read 에러/종료를 단절 신호로 쓰고,
// 프로세스 전역 가드로 크래시를 막는다.
let guardsInstalled = false
function installGlobalGuards() {
  if (guardsInstalled) return
  guardsInstalled = true
  process.on('unhandledRejection', (reason) => {
    const name = reason?.constructor?.name || ''
    if (name === 'ExactReadableEndedError' || name === 'AdbServerConnectionError') {
      // 세션 단절로 인한 알려진 rejection — 삼킨다(세션별 onExit이 복구 담당)
      return
    }
    console.warn('grid.unhandledRejection', reason?.message || reason)
  })
}

let client = null
function getClient() {
  if (!client) {
    client = new AdbServerClient(
      new AdbServerNodeTcpConnector({ host: '127.0.0.1', port: 5037 }),
    )
  }
  return client
}

const sessions = new Map()
let nextId = 1

/**
 * 단일 기기의 scrcpy 세션 기동. onPacket은 contextBridge를 건너는 콜백.
 * onPacket은 Promise를 반환할 수 있고, 읽기 루프가 이를 await하여 backpressure를 유지한다.
 */
export async function startSession(serial, callbacks = {}) {
  installGlobalGuards()
  const { onPacket, onSizeChanged, onExit } = callbacks

  const adb = await getClient().createAdb({ serial })
  const server = await fs.readFile(SERVER_BIN)
  await AdbScrcpyClient.pushServer(
    adb,
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(server))
        c.close()
      },
    }),
  )

  const scrcpy = await AdbScrcpyClient.start(
    adb,
    DefaultServerPath,
    new AdbScrcpyOptionsLatest(
      {
        video: true,
        audio: false,
        control: true,
        videoCodec: 'h264',
        maxSize: 1024,
        videoBitRate: 4_000_000,
        maxFps: 60,
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

  // 읽기 루프: onPacket이 반환하는 Promise를 await → backpressure 유지
  ;(async () => {
    const reader = video.stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done || session.stopped) break
        const packet = { type: value.type, keyframe: value.keyframe, data: value.data }
        if (value.pts !== undefined) packet.pts = value.pts // bigint는 브릿지를 그대로 통과(Phase 0 실증)
        await onPacket?.(packet)
      }
    }
    catch (error) {
      if (!session.stopped) {
        // 스트림 read 에러 = 단절 신호(G0.6). 세션 정리 후 상위에 통지 → 재기동은 뷰가 담당.
        onExit?.(String(error?.message || error))
      }
    }
    finally {
      try { reader.releaseLock() } catch {}
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

export async function injectTouch(id, msg) {
  const s = sessions.get(id)
  if (!s || s.stopped) return
  await s.scrcpy.controller.injectTouch({
    action: msg.action,
    pointerId: ScrcpyPointerId.Finger,
    pointerX: msg.pointerX,
    pointerY: msg.pointerY,
    videoWidth: msg.videoWidth,
    videoHeight: msg.videoHeight,
    pressure: msg.pressure ?? 1,
    actionButton: 1,
    buttons: msg.buttons ?? (msg.action === 1 ? 0 : 1),
  })
}

export async function injectScroll(id, msg) {
  const s = sessions.get(id)
  if (!s || s.stopped) return
  await s.scrcpy.controller.injectScroll({
    pointerX: msg.pointerX,
    pointerY: msg.pointerY,
    videoWidth: msg.videoWidth,
    videoHeight: msg.videoHeight,
    scrollX: msg.scrollX ?? 0,
    scrollY: msg.scrollY ?? 0,
    buttons: 0,
  })
}

export async function backOrScreenOn(id) {
  const s = sessions.get(id)
  if (!s || s.stopped) return
  await s.scrcpy.controller.backOrScreenOn(0) // Down
}

export async function stopSession(id) {
  const s = sessions.get(id)
  if (!s) return
  s.stopped = true
  sessions.delete(id)
  try { await s.scrcpy.close() } catch {}
  try { await s.adb.close() } catch {}
}

export async function stopAll() {
  const ids = [...sessions.keys()]
  await Promise.all(ids.map(id => stopSession(id)))
}

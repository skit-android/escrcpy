import { electronAPI } from '@electron-toolkit/preload'
import {
  backOrScreenOn,
  getStats,
  injectScroll,
  injectTouch,
  startSession,
  stopAll,
  stopSession,
} from './session.js'

// 앱 종료 시 모든 grid 세션 정리(기존 adb 미들웨어의 quit-before 패턴과 동일)
electronAPI.ipcRenderer.on('quit-before', () => {
  stopAll()
})

export default {
  startSession,
  stopSession,
  stopAll,
  injectTouch,
  injectScroll,
  backOrScreenOn,
  getStats,
}

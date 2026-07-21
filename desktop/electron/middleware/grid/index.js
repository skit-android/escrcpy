import { electronAPI } from '@electron-toolkit/preload'
import {
  backOrScreenOn,
  injectKey,
  injectKeyCode,
  injectScroll,
  injectText,
  injectTouch,
  startSession,
  stopAll,
  stopSession,
} from './session.js'

// Tear down every session on quit, matching the adb/scrcpy middlewares.
electronAPI.ipcRenderer.on('quit-before', () => {
  stopAll()
})

export default {
  startSession,
  stopSession,
  stopAll,
  injectTouch,
  injectScroll,
  injectKey,
  injectKeyCode,
  injectText,
  backOrScreenOn,
}

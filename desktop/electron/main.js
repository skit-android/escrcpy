// Process configuration must be imported first
import './process/index.js'

import './helpers/store/index.js'

// Post configuration must be imported after store configuration
import './process/index.post.js'

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import './helpers/debugger/index.js'
import './helpers/debugger/main.js'

import { app } from 'electron'
import { createElectronApp } from '@escrcpy/electron-setup/main'

// DEV 전용: 패키징 안 된 개발 실행에서 CDP 원격 디버깅 활성화(그리드 뷰 자동 검증용)
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.GRID_DEBUG_PORT || '9222')
  app.commandLine.appendSwitch('remote-allow-origins', '*')
}

import {
  clipboardPlugin,
  sandboxPlugin,
  themePlugin,
  windowIPCPlugin,
} from '@escrcpy/electron-setup/plugins'

import { browserWindowHeight, browserWindowWidth, getLogoPath } from './configs/index.js'
import { getAppBackgroundColor } from './helpers/index.js'

import {
  contextMenuService,
  edgerService,
  handlesService,
  launchService,
  lifecycleService,
  listenersService,
  shortcutsService,
  trayService,
  updaterService,
} from './services/index.js'

import {
  controlModule,
  explorerModule,
  mainModule,
  scheduleModule,
  terminalModule,
} from './modules/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const mainApp = createElectronApp({
  preloadDir: __dirname,
  rendererDir: path.join(__dirname, '../dist'),
  devRendererDir: process.env.VITE_DEV_SERVER_URL,
  icon: getLogoPath(),
  width: browserWindowWidth,
  height: browserWindowHeight,
  backgroundColor: getAppBackgroundColor(),
})

mainApp.use(sandboxPlugin)
mainApp.use(mainModule)
mainApp.use(lifecycleService)

mainApp.use(themePlugin)
mainApp.use(windowIPCPlugin)
mainApp.use(clipboardPlugin)

mainApp.use(edgerService)
mainApp.use(listenersService)
mainApp.use(handlesService)
mainApp.use(trayService)
mainApp.use(contextMenuService)
mainApp.use(updaterService)
mainApp.use(launchService)
mainApp.use(shortcutsService)

mainApp.use(controlModule)
mainApp.use(explorerModule)
mainApp.use(terminalModule)
mainApp.use(scheduleModule)

app.whenReady().then(() => {
  mainApp.start()
})

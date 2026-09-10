import type { BrowserAPI } from './index'

declare global {
  interface Window {
    browserAPI: BrowserAPI
  }
}

export {}
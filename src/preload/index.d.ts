import type { RipponApi } from './index'

declare global {
  interface Window {
    rippon: RipponApi
  }
}

export {}

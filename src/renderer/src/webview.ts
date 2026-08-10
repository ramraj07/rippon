import type { FC, HTMLAttributes, Ref } from 'react'

/**
 * <webview> is a real DOM element in Electron but has no React typing, so we
 * borrow HTMLElement's props and add the attributes we actually use.
 */
export interface WebviewElement extends HTMLElement {
  src: string
  getURL(): string
  loadURL(url: string): Promise<void>
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  isLoading(): boolean
  openDevTools(): void
  focus(): void
}

interface WebviewProps extends HTMLAttributes<HTMLElement> {
  ref?: Ref<WebviewElement>
  src?: string
  partition?: string
  allowpopups?: string
  useragent?: string
  webpreferences?: string
}

export const Webview = 'webview' as unknown as FC<WebviewProps>

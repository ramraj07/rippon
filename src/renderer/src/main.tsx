import { createRoot } from 'react-dom/client'
import App from './App'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

// Deliberately not StrictMode: terminals, PTYs and <webview> guests are
// long-lived imperative resources that double-mounting would tear down.
createRoot(document.getElementById('root')!).render(<App />)

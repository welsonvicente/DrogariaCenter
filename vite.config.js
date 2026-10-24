import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { copyFileSync, cpSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const configuredBase = process.env.VITE_BASE_PATH || '/'
const base = `/${configuredBase.replace(/^\/+|\/+$/g, '')}${configuredBase === '/' ? '' : '/'}`

function spaFallback() {
  return {
    name: 'spa-fallback',
    closeBundle() {
      // O projeto fica em uma pasta sincronizada pelo OneDrive. Nessa situacao
      // o Vite pode ignorar arquivos publicos marcados como reparse point.
      // Copie-os explicitamente para garantir PWA, logo, fundo e redirects.
      const publicDir = resolve('public')
      const distDir = resolve('dist')
      if (existsSync(publicDir)) cpSync(publicDir, distDir, { recursive: true, force: true })
      const indexFile = resolve('dist/index.html')
      if (existsSync(indexFile)) copyFileSync(indexFile, resolve('dist/404.html'))
    },
  }
}

export default defineConfig({
  base,
  plugins: [react(), tailwindcss(), spaFallback()],
})

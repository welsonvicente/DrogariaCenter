import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const configuredBase = process.env.VITE_BASE_PATH || '/'
const base = `/${configuredBase.replace(/^\/+|\/+$/g, '')}${configuredBase === '/' ? '' : '/'}`

function spaFallback() {
  return {
    name: 'spa-fallback',
    closeBundle() {
      const indexFile = resolve('dist/index.html')
      if (existsSync(indexFile)) copyFileSync(indexFile, resolve('dist/404.html'))
    },
  }
}

export default defineConfig({
  base,
  plugins: [react(), tailwindcss(), spaFallback()],
})

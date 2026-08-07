import path from 'node:path'
import { defineConfig } from 'vite'

const root = import.meta.dirname

export default defineConfig({
  root,
  base: './',
  build: {
    emptyOutDir: true,
    outDir: path.resolve(root, '../../../../fixtures/static-sites/react-spa'),
  },
})

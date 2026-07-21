import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const isWin = process.platform === 'win32'
const npmCmd = isWin ? 'npm.cmd' : 'npm'

// Bundle all main-process deps except electron so packaged apps
// do not need a full node_modules tree next to the binary.
await Promise.all([
  esbuild.build({
    entryPoints: [path.join(root, 'electron/main.ts')],
    outfile: path.join(root, 'dist-electron/main.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['electron'],
    sourcemap: true
  }),
  esbuild.build({
    entryPoints: [path.join(root, 'electron/preload.ts')],
    outfile: path.join(root, 'dist-electron/preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    sourcemap: true
  })
])

const vite = spawnSync(npmCmd, ['exec', 'vite', '--', 'build'], {
  cwd: root,
  stdio: 'inherit',
  shell: isWin
})

if (vite.status !== 0) process.exit(vite.status ?? 1)
console.log('Build complete: dist/ + dist-electron/')

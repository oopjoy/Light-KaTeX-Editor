import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const isWin = process.platform === 'win32'
const npmCmd = isWin ? 'npm.cmd' : 'npm'
const electronCmd = isWin
  ? path.join(root, 'node_modules', '.bin', 'electron.cmd')
  : path.join(root, 'node_modules', '.bin', 'electron')

function run(command, args, opts = {}) {
  return spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWin,
    ...opts
  })
}

async function buildElectron({ watch = false } = {}) {
  const mainOptions = {
    entryPoints: [path.join(root, 'electron/main.ts')],
    outfile: path.join(root, 'dist-electron/main.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    sourcemap: true
  }

  // Preload must be CommonJS for reliable contextBridge loading.
  const preloadOptions = {
    entryPoints: [path.join(root, 'electron/preload.ts')],
    outfile: path.join(root, 'dist-electron/preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    packages: 'external',
    sourcemap: true
  }

  if (watch) {
    const mainCtx = await esbuild.context(mainOptions)
    const preloadCtx = await esbuild.context(preloadOptions)
    await Promise.all([mainCtx.watch(), preloadCtx.watch()])
    return { mainCtx, preloadCtx }
  }

  await Promise.all([esbuild.build(mainOptions), esbuild.build(preloadOptions)])
  return null
}

await buildElectron({ watch: true })

const vite = run(npmCmd, ['exec', 'vite', '--', '--host', '127.0.0.1', '--port', '5173'])

// Wait briefly for Vite before launching Electron
await new Promise((resolve) => setTimeout(resolve, 1200))

const electron = run(electronCmd, ['.'], {
  env: {
    ...process.env,
    LIGHT_EDITOR_DEV: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
  }
})

function shutdown(code = 0) {
  if (!vite.killed) vite.kill()
  if (!electron.killed) electron.kill()
  process.exit(code)
}

vite.on('exit', (code) => {
  if (!electron.killed) electron.kill()
  process.exit(code ?? 0)
})

electron.on('exit', (code) => {
  if (!vite.killed) vite.kill()
  process.exit(code ?? 0)
})

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

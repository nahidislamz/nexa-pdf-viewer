const { spawn } = require('node:child_process')
const path = require('node:path')

const env = { ...process.env }

if (process.platform === 'win32') {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path'
  const powershellDirectory = path.join(
    env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
  )
  const pathEntries = (env[pathKey] || '').split(path.delimiter)

  if (!pathEntries.some((entry) => entry.toLowerCase() === powershellDirectory.toLowerCase())) {
    env[pathKey] = [powershellDirectory, ...pathEntries].filter(Boolean).join(path.delimiter)
  }

  const nodeOptions = env.NODE_OPTIONS || ''
  if (!nodeOptions.includes('--use-system-ca')) {
    env.NODE_OPTIONS = `${nodeOptions} --use-system-ca`.trim()
  }
}

delete env.ELECTRON_RUN_AS_NODE

const builderCli = require.resolve('electron-builder/cli.js')
const child = spawn(process.execPath, [builderCli, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
})

child.on('error', (error) => {
  console.error(`Failed to start electron-builder: ${error.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 1)
})

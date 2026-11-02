import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))

// Exercise the APIs used by each overridden consumer, including ESLint's partial
// directory traversal and TypeScript's optional default-project matching.
for (const consumer of ['eslint', '@eslint/config-array', '@typescript-eslint/typescript-estree']) {
  const glob = createRequire(require.resolve(consumer))('minimatch')
  test(`${consumer}: supported glob matching and bounded preprocessing`, () => {
    for (const [file, pattern, options, expected] of [
      ['src/view.tsx', '**/*.{ts,tsx}', { dot: true }, true],
      ['src/.hidden.ts', '**/*.{ts,tsx}', { dot: true }, true],
      ['src/view.js', '**/*.{ts,tsx}', { dot: true }, false],
      ['src/nested/view.ts', 'src/**/!(*.test).ts', {}, true],
      ['src/view.test.ts', 'src/**/!(*.test).ts', {}, false],
      ['dist/view.ts', '!dist/**', { flipNegate: true }, true],
      ['src/view.ts', '!dist/**', { flipNegate: true }, false],
    ]) {
      assert.equal(new glob.Minimatch(pattern, options).match(file), expected)
      assert.equal(glob.minimatch(file, pattern, options), expected)
    }
    const traversal = new glob.Minimatch('src/**/*.tsx', { dot: true })
    assert.equal(traversal.match('src/nested', true), true)
    assert.equal(traversal.match('other', true), false)
    // GHSA-g3hv-75wg-m249: optimization must respect the configured expansion
    // budget even when **/../ preprocessing creates alternatives.
    const bounded = new glob.Minimatch('**/../a/b/'.repeat(6) + 'x', {
      optimizationLevel: 2, braceExpandMax: 16,
    })
    assert.ok(bounded.globParts.length <= 16)
  })
}

test('ESLint still selects TypeScript sources and ignores build output', async () => {
  const { ESLint } = require('eslint')
  const eslint = new ESLint({ cwd: fileURLToPath(new URL('../frontend/', import.meta.url)) })
  assert.equal(await eslint.isPathIgnored('src/maintenance-check.tsx'), false)
  assert.equal(await eslint.isPathIgnored('src/.maintenance-check.tsx'), false)
  assert.equal(await eslint.isPathIgnored('dist/maintenance-check.tsx'), true)
})

test('nodemon preserves matching and restarts its TypeScript development process', { timeout: 20000 }, async () => {
  const backend = createRequire(new URL('../backend/package.json', import.meta.url))
  const glob = createRequire(backend.resolve('nodemon'))('minimatch')
  assert.equal(glob.minimatch('src/nested/order.ts', '**/*.{ts,json}'), true)
  assert.equal(glob.minimatch('src/order.test.ts', '**/!(*.test).ts'), false)
  assert.ok(new glob.Minimatch('**/../a/b/'.repeat(6) + 'x', {
    optimizationLevel: 2, braceExpandMax: 16,
  }).globParts.length <= 16)

  const directory = await mkdtemp(path.join(tmpdir(), 'oms-watch-check-'))
  await mkdir(path.join(directory, 'src'))
  const nodemonConfig = path.join(directory, 'nodemon.json')
  await writeFile(nodemonConfig, JSON.stringify({ updateNotifier: false }))
  await writeFile(path.join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'CommonJS' } }))
  const entry = path.join(directory, 'src/index.ts')
  const backendBin = path.resolve(path.dirname(backend.resolve('ts-node/package.json')), '..', '.bin')
  await writeFile(entry, 'console.log("WATCH_FIRST");\n')
  const child = spawn(process.execPath, [backend.resolve('nodemon/bin/nodemon.js'),
    '--config', nodemonConfig, '--watch', 'src', '--exec', 'ts-node', 'src/index.ts'], {
    // nodemon reads ~/nodemon.json, including shell event hooks. The fixture
    // must never load a developer's global configuration or credentials.
    cwd: directory, env: { PATH: `${backendBin}${path.delimiter}${process.env.PATH}`, HOME: directory, HOMEPATH: directory, NO_UPDATE_NOTIFIER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  let output = ''
  const waitFor = (marker: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Watcher did not emit ${marker}: ${output}`)) }, 8000)
    const inspect = (chunk: Buffer) => { output += chunk; if (output.includes(marker)) { cleanup(); resolve() } }
    const cleanup = () => { clearTimeout(timer); child.stdout.off('data', inspect); child.stderr.off('data', inspect) }
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
  })
  try {
    await waitFor('WATCH_FIRST')
    const restarted = waitFor('WATCH_SECOND')
    await writeFile(entry, 'console.log("WATCH_SECOND");\n')
    await restarted
  } finally {
    // Nodemon invokes a shell and ts-node beneath it. Terminate only this
    // fixture's process group so descendants cannot retain CI's output pipes.
    const stop = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
    stop('SIGTERM')
    await new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      const timer = setTimeout(() => { stop('SIGKILL'); resolve() }, 2000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
    child.stdout.destroy()
    child.stderr.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})

// Ported from Ferret test/unit/platform.test.ts (the windowsSpawn part) (MIT).
import { describe, expect, it } from 'vitest'
import {
  buildWindowsCmdShimCommandLine,
  findWindowsExecutable,
  parseWindowsCmdShim,
  pickWindowsWhereResult,
  resolveSpawn,
  type WindowsFs
} from '../../src/main/platform/windowsSpawn'
import { quoteWindowsCmdArgument } from '@solocut/agents'

/** 中身を持つ仮のファイルシステム（パスは大文字小文字を区別しない＝Windows と同じ） */
function fakeFs(files: Record<string, string>): WindowsFs {
  const table = new Map(Object.entries(files).map(([path, body]) => [path.toLowerCase(), body]))
  return {
    fileSize: (path) => (table.has(path.toLowerCase()) ? table.get(path.toLowerCase())!.length || 1 : null),
    readText: (path) => table.get(path.toLowerCase()) ?? null
  }
}

/** 今の npm（cmd-shim）が codex に生成する .cmd（実物と同じ形） */
const NPM_CODEX_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ''
].join('\r\n')

const NPM_DIR = 'C:\\Users\\me\\AppData\\Roaming\\npm'
const WIN_ENV = { Path: `${NPM_DIR};C:\\Program Files\\nodejs`, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe' }

describe('Windows で CLI を起動する', () => {
  it('Windows 以外は何も変えない', () => {
    const resolved = resolveSpawn('codex', ['exec', '-'], { PATH: '/usr/bin' }, 'linux', fakeFs({}))
    expect(resolved).toEqual({ file: 'codex', args: ['exec', '-'], env: { PATH: '/usr/bin' } })
  })

  it('PATHEXT で .cmd を見つけ、拡張子の無い sh 用スクリプトは選ばない', () => {
    const fs = fakeFs({ [`${NPM_DIR}\\codex`]: '#!/bin/sh', [`${NPM_DIR}\\codex.cmd`]: NPM_CODEX_SHIM })
    expect(findWindowsExecutable('codex', WIN_ENV, fs)).toBe(`${NPM_DIR}\\codex.cmd`)
  })

  it('.exe があればそのまま起動する（claude のネイティブ版など）', () => {
    const fs = fakeFs({ 'C:\\Users\\me\\.local\\bin\\claude.exe': 'MZ' })
    const resolved = resolveSpawn('claude', ['-p'], { PATH: 'C:\\Users\\me\\.local\\bin' }, 'win32', fs)
    expect(resolved.file).toBe('C:\\Users\\me\\.local\\bin\\claude.exe')
    expect(resolved.windowsVerbatimArguments).toBeUndefined()
  })

  it('npm の .cmd は中身を読んで node.exe で直接起動する（cmd.exe を通さない）', () => {
    const fs = fakeFs({
      [`${NPM_DIR}\\codex.cmd`]: NPM_CODEX_SHIM,
      [`${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`]: '// js',
      'C:\\Program Files\\nodejs\\node.exe': 'MZ'
    })
    const resolved = resolveSpawn('codex', ['exec', '--output-schema', 'C:\\tmp\\s.json', '-'], WIN_ENV, 'win32', fs)
    expect(resolved.file).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(resolved.args).toEqual([`${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`, 'exec', '--output-schema', 'C:\\tmp\\s.json', '-'])
    expect(resolved.windowsVerbatimArguments).toBeUndefined()
  })

  it('読めない .cmd は cmd.exe 経由にし、引数を組み立て済みの1行で渡す', () => {
    const fs = fakeFs({ [`${NPM_DIR}\\tool.cmd`]: '@echo off\r\ncall something.bat %*' })
    const resolved = resolveSpawn('tool', ['a b', '{"x":1}'], WIN_ENV, 'win32', fs)
    expect(resolved.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(resolved.windowsVerbatimArguments).toBe(true)
    expect(resolved.args).toEqual([`/d /v:off /s /c ""${NPM_DIR}\\tool.cmd" "a b" "{""x"":1}""`])
  })

  it('PATH の最初の node が .cmd なら、その先の node.exe を勝手に選ばない', () => {
    const fs = fakeFs({
      [`${NPM_DIR}\\codex.cmd`]: NPM_CODEX_SHIM,
      [`${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`]: '// js',
      'C:\\shims\\node.cmd': '@echo off',
      'C:\\Program Files\\nodejs\\node.exe': 'MZ'
    })
    const env = { ...WIN_ENV, Path: `${NPM_DIR};C:\\shims;C:\\Program Files\\nodejs` }
    expect(resolveSpawn('codex', [], env, 'win32', fs).file).toBe('C:\\Windows\\System32\\cmd.exe')
  })
})

describe('cmd.exe 用の引数の書き方（Orca の検証例）', () => {
  it('" は "" にし、% は囲みの外で ^% にする', () => {
    expect(quoteWindowsCmdArgument('plain')).toBe('"plain"')
    expect(quoteWindowsCmdArgument('c"d')).toBe('"c""d"')
    expect(quoteWindowsCmdArgument('e%F%g')).toBe('"e"^%"F"^%"g"')
    expect(quoteWindowsCmdArgument('C:\\dir\\')).toBe('"C:\\dir\\\\"')
  })

  it('改行を含む引数は渡せない', () => {
    expect(() => buildWindowsCmdShimCommandLine('x.cmd', ['a\nb'])).toThrow()
  })

  it('形の違う .cmd や、フォルダの外を指すものは読まない', () => {
    expect(parseWindowsCmdShim('@echo off\r\nnode evil.js %*')).toBeNull()
    expect(parseWindowsCmdShim(NPM_CODEX_SHIM.replace('node_modules\\@openai', 'D:node_modules\\@openai'))).toBeNull()
    expect(parseWindowsCmdShim(NPM_CODEX_SHIM)).toEqual({ kind: 'node', script: 'node_modules\\@openai\\codex\\bin\\codex.js' })
  })

  it('where の出力から起動できるものを選ぶ', () => {
    const out = `${NPM_DIR}\\codex\r\n${NPM_DIR}\\codex.cmd\r\n${NPM_DIR}\\codex.ps1\r\n`
    expect(pickWindowsWhereResult(out)).toBe(`${NPM_DIR}\\codex.cmd`)
    expect(pickWindowsWhereResult(`${NPM_DIR}\\codex\r\n`)).toBeNull()
  })
})

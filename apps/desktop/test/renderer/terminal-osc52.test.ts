// Ported from Ferret test/unit/terminal-osc52.test.ts (MIT).
import { describe, expect, it } from 'vitest'
import { MAX_OSC52_BASE64_CHARS, parseOsc52 } from '../../src/renderer/src/terminal/terminalOsc52'

const bytesToB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const b64 = (text: string) => bytesToB64(new TextEncoder().encode(text))

describe('OSC 52 のコピー（Orca #8977 #22842）', () => {
  it('base64 の UTF-8 を戻す（種類の文字は問わない・空でもよい）', () => {
    expect(parseOsc52(`c;${b64('hello 日本語\nline2')}`)).toEqual({ kind: 'write', text: 'hello 日本語\nline2' })
    expect(parseOsc52(`;${b64('x')}`)).toEqual({ kind: 'write', text: 'x' })
    expect(parseOsc52(`pc;${b64('y')}`)).toEqual({ kind: 'write', text: 'y' })
  })

  it('読み出しの問い合わせ（?）は書き込みにしない', () => {
    expect(parseOsc52('c;?')).toEqual({ kind: 'query' })
  })

  it('壊れたもの・大きすぎるもの・UTF-8 でないものは捨てる', () => {
    expect(parseOsc52('nosemicolon')).toEqual({ kind: 'invalid' })
    expect(parseOsc52('c;***')).toEqual({ kind: 'invalid' })
    expect(parseOsc52('x;' + b64('a'))).toEqual({ kind: 'invalid' })
    expect(parseOsc52('c;' + 'A'.repeat(MAX_OSC52_BASE64_CHARS + 4))).toEqual({ kind: 'invalid' })
    expect(parseOsc52('c;' + bytesToB64(new Uint8Array([0xff, 0xfe])))).toEqual({ kind: 'invalid' })
  })
})

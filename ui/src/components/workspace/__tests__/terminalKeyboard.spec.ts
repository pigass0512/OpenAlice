// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

import {
  detectTerminalKeyboardPlatform,
  installTerminalKeyboardController,
  RESET_KITTY_KEYBOARD_PROTOCOL,
  type TerminalKeyboardPlatform,
} from '../terminalKeyboard'

interface MutableKeyEvent {
  type: string
  key: string
  code: string
  keyCode: number
  which: number
  repeat: boolean
  defaultPrevented: boolean
  isComposing: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  preventDefault: ReturnType<typeof vi.fn>
  stopPropagation: ReturnType<typeof vi.fn>
}

function keyEvent(
  type: string,
  key: string,
  overrides: Partial<MutableKeyEvent> = {},
): KeyboardEvent {
  return {
    type,
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    keyCode: 0,
    which: 0,
    repeat: false,
    defaultPrevented: false,
    isComposing: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent
}

function setup(options: {
  platform?: TerminalKeyboardPlatform
  hasSelection?: boolean
  keyMap?: Readonly<Record<string, string>>
} = {}) {
  const terminalElement = document.createElement('div')
  const textarea = document.createElement('textarea')
  terminalElement.append(textarea)
  document.body.append(terminalElement)
  const sent: Array<{ data: string; source: string }> = []
  const resetKittyProtocol = vi.fn()
  const controller = installTerminalKeyboardController({
    terminalElement,
    platform: options.platform ?? 'linux',
    getKeyMap: () => options.keyMap,
    hasSelection: () => options.hasSelection ?? false,
    sendInput: (data, source) => sent.push({ data, source }),
    resetKittyProtocol,
  })
  return {
    terminalElement,
    textarea,
    sent,
    resetKittyProtocol,
    controller,
    dispose: () => {
      controller.dispose()
      terminalElement.remove()
    },
  }
}

describe('terminal Kitty keyboard policy', () => {
  it('detects desktop renderer platforms without treating ChromeOS as Linux', () => {
    expect(detectTerminalKeyboardPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X)')).toBe('darwin')
    expect(detectTerminalKeyboardPlatform('Mozilla/5.0 (Windows NT 10.0)')).toBe('win32')
    expect(detectTerminalKeyboardPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux')
    expect(detectTerminalKeyboardPlatform('Mozilla/5.0 (X11; CrOS x86_64)')).toBe('other')
  })

  it('sends mapped Shift+Enter once and suppresses its press and release events', () => {
    const fixture = setup({ keyMap: { 'shift+enter': '\x1b[13;2u' } })
    try {
      const down = keyEvent('keydown', 'Enter', { code: 'Enter', shiftKey: true })
      expect(fixture.controller.handle(down)).toBe(false)
      expect(fixture.controller.handle(keyEvent('keypress', 'Enter', { code: 'Enter', shiftKey: true }))).toBe(false)
      expect(fixture.controller.handle(keyEvent('keyup', 'Enter', { code: 'Enter', shiftKey: true }))).toBe(false)
      expect(fixture.sent).toEqual([{ data: '\x1b[13;2u', source: 'key:shift+enter' }])
      expect(down.preventDefault).toHaveBeenCalledOnce()
    } finally {
      fixture.dispose()
    }
  })

  it('keeps Ctrl+C as ETX without a selection and resets stale Kitty state', () => {
    const fixture = setup()
    try {
      expect(fixture.controller.handle(keyEvent('keydown', 'c', { code: 'KeyC', ctrlKey: true }))).toBe(false)
      expect(fixture.controller.handle(keyEvent('keyup', 'c', { code: 'KeyC', ctrlKey: true }))).toBe(false)
      expect(fixture.sent).toEqual([{ data: '\x03', source: 'key:ctrl+c' }])
      expect(fixture.resetKittyProtocol).toHaveBeenCalledOnce()
      expect(RESET_KITTY_KEYBOARD_PROTOCOL).toBe('\x1b[<99u\x1b[=0u')
    } finally {
      fixture.dispose()
    }
  })

  it('lets native clipboard chords bypass xterm while preserving Linux Ctrl+C interrupt semantics', () => {
    const selected = setup({ hasSelection: true })
    const mac = setup({ platform: 'darwin' })
    try {
      expect(selected.controller.handle(keyEvent('keydown', 'c', { ctrlKey: true }))).toBe(false)
      expect(selected.controller.handle(keyEvent('keyup', 'c', { ctrlKey: true }))).toBe(false)
      expect(selected.controller.handle(keyEvent('keydown', 'v', { ctrlKey: true }))).toBe(false)
      expect(selected.sent).toEqual([])

      expect(mac.controller.handle(keyEvent('keydown', 'c', { metaKey: true }))).toBe(false)
      expect(mac.controller.handle(keyEvent('keydown', 'v', { metaKey: true }))).toBe(false)
      expect(mac.sent).toEqual([])
    } finally {
      selected.dispose()
      mac.dispose()
    }
  })

  it('suppresses standalone modifiers and shifted non-ASCII physical-key encoding', () => {
    const fixture = setup()
    try {
      expect(fixture.controller.handle(keyEvent('keydown', 'Shift', { code: 'ShiftLeft', shiftKey: true }))).toBe(false)
      expect(fixture.controller.handle(keyEvent('keyup', 'Shift', { code: 'ShiftLeft' }))).toBe(false)
      expect(fixture.controller.handle(keyEvent('keydown', '你', { code: 'KeyN', shiftKey: true }))).toBe(false)
      expect(fixture.controller.handle(keyEvent('keydown', 'a', { code: 'KeyA' }))).toBe(true)
    } finally {
      fixture.dispose()
    }
  })

  it('keeps IME navigation and candidate selectors out of the PTY', () => {
    const fixture = setup()
    try {
      fixture.terminalElement.dispatchEvent(new CompositionEvent('compositionstart', { data: 'n' }))
      expect(fixture.controller.handle(keyEvent('keydown', 'ArrowDown'))).toBe(false)

      const candidate = keyEvent('keydown', ' ', { code: 'Space' })
      expect(fixture.controller.handle(candidate)).toBe(false)
      expect(candidate.preventDefault).toHaveBeenCalledOnce()
      expect(fixture.controller.handle(keyEvent('keyup', ' ', { code: 'Space' }))).toBe(false)
      expect(fixture.sent).toEqual([])
    } finally {
      fixture.dispose()
    }
  })

  it('forwards direct macOS CJK punctuation from the committed input event', () => {
    const fixture = setup({ platform: 'darwin' })
    try {
      expect(
        fixture.controller.handle(keyEvent('keydown', '。', { code: 'Period', keyCode: 190 })),
      ).toBe(false)
      const input = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '。' })
      fixture.textarea.dispatchEvent(input)
      expect(fixture.sent).toEqual([{ data: '。', source: 'ime-native-text' }])
      expect(fixture.textarea.value).toBe('')
    } finally {
      fixture.dispose()
    }
  })
})

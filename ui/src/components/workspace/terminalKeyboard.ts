import type { KeyMap } from './terminalInput'
import { keySignature } from './terminalInput'

export type TerminalKeyboardPlatform = 'darwin' | 'linux' | 'win32' | 'other'

export interface TerminalKeyboardController {
  handle(event: KeyboardEvent): boolean
  dispose(): void
}

interface TerminalKeyboardControllerOptions {
  readonly terminalElement: HTMLElement | null | undefined
  readonly platform?: TerminalKeyboardPlatform
  readonly getKeyMap: () => KeyMap | undefined
  readonly hasSelection: () => boolean
  readonly sendInput: (data: string, source: string) => void
  readonly resetKittyProtocol: () => void
  readonly now?: () => number
}

interface KeyboardEventLike {
  readonly type: string
  readonly key: string
  readonly code?: string
  readonly keyCode?: number
  readonly which?: number
  readonly repeat?: boolean
  readonly defaultPrevented?: boolean
  readonly isComposing?: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly metaKey: boolean
  preventDefault(): void
  stopPropagation(): void
}

interface ImeOptions {
  readonly compositionActive: boolean
  readonly candidateKeyGuardActive: boolean
  readonly pendingCandidateKeyReleaseActive: boolean
  readonly linuxOrphanCandidateDigitGuardActive: boolean
  readonly isMac: boolean
  readonly isLinux: boolean
}

const TERMINAL_INTERRUPT_INPUT = '\x03'
export const RESET_KITTY_KEYBOARD_PROTOCOL = '\x1b[<99u\x1b[=0u'

const MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift'])
const IME_OWNED_KEYS = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'Backspace',
  'Delete',
  'End',
  'Enter',
  'Escape',
  'Home',
  'PageDown',
  'PageUp',
])
const IME_CANDIDATE_KEYS = new Set([' ', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])
const IME_CANDIDATE_DIGITS = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])
const CJK_DIRECT_PUNCTUATION_KEYS = new Set([
  '、', '。', '，', '．', '！', '？', '；', '：', '“', '”', '‘', '’',
  '（', '）', '【', '】', '《', '》', '〈', '〉', '「', '」', '『', '』',
  '￥', '～', '·', '…',
])

const IME_STALE_COMPOSITION_MS = 10_000
const IME_POST_COMPOSITION_MS = 250
const LINUX_ORPHAN_CANDIDATE_WINDOW_MS = 1_500

/** Detect the renderer platform without depending on Electron preload APIs. */
export function detectTerminalKeyboardPlatform(userAgent = navigator.userAgent): TerminalKeyboardPlatform {
  if (/Mac|iPhone|iPad/.test(userAgent)) return 'darwin'
  if (/Windows/.test(userAgent)) return 'win32'
  if (/Linux/.test(userAgent) && !/Android|CrOS/.test(userAgent)) return 'linux'
  return 'other'
}

/**
 * Install the input policy used by both browser WebSocket and Electron IPC
 * terminals. The policy is adapted from stablyai/orca's Kitty keyboard and
 * IME safeguards; see THIRD_PARTY_NOTICES.md.
 */
export function installTerminalKeyboardController(
  options: TerminalKeyboardControllerOptions,
): TerminalKeyboardController {
  const platform = options.platform ?? detectTerminalKeyboardPlatform()
  const isMac = platform === 'darwin'
  const isLinux = platform === 'linux'
  const now = options.now ?? Date.now
  const composition = installCompositionTracker(options.terminalElement, now)
  const linuxCandidateState = createLinuxCandidateState(now)
  const pendingCandidateReleases = new Map<string, number>()
  const mappedPresses = new Set<string>()
  let pendingInterruptKeyup = false

  const nativeTextForwarder = isMac
    ? installNativeTextForwarder({
        terminalElement: options.terminalElement,
        isComposing: composition.isActive,
        sendInput: (data) => options.sendInput(data, 'ime-native-text'),
      })
    : { claimKeyEvent: () => false, dispose: () => undefined }

  const handle = (keyboardEvent: KeyboardEvent): boolean => {
    const event = keyboardEvent as KeyboardEvent & KeyboardEventLike
    const linuxClassification = isLinux
      ? linuxCandidateState.classify(event)
      : { candidateDigitGuardActive: false }
    const observeLinuxEvent = (): void => {
      if (isLinux) linuxCandidateState.observe(event, linuxClassification)
    }

    const at = now()
    const pendingCandidateRelease = shouldApplyPendingCandidateRelease(
      event,
      pendingCandidateReleases,
      at,
    )
    const imeOptions: ImeOptions = {
      compositionActive: composition.isActive(),
      candidateKeyGuardActive:
        composition.isCandidateKeyGuardActive() || pendingCandidateRelease,
      pendingCandidateKeyReleaseActive: pendingCandidateRelease,
      linuxOrphanCandidateDigitGuardActive: linuxClassification.candidateDigitGuardActive,
      isMac,
      isLinux,
    }

    if (shouldSuppressImeEvent(event, imeOptions)) {
      clearPendingCandidateRelease(event, pendingCandidateReleases)
      if (shouldPreventDefaultCandidateKey(event, imeOptions)) {
        event.preventDefault()
        event.stopPropagation()
        armPendingCandidateRelease(event, pendingCandidateReleases, at)
      }
      observeLinuxEvent()
      return false
    }
    clearPendingCandidateRelease(event, pendingCandidateReleases)

    const pressId = keyboardPressId(event)
    if ((event.type === 'keyup' || event.type === 'keypress') && mappedPresses.has(pressId)) {
      if (event.type === 'keyup') mappedPresses.delete(pressId)
      observeLinuxEvent()
      return false
    }

    if (event.type === 'keydown') {
      const signature = keySignature(event)
      const mappedInput = options.getKeyMap()?.[signature]
      if (mappedInput !== undefined) {
        mappedPresses.add(pressId)
        event.preventDefault()
        event.stopPropagation()
        options.sendInput(mappedInput, `key:${signature}`)
        observeLinuxEvent()
        return false
      }
    }

    if (pendingInterruptKeyup && shouldSuppressInterruptKeyup(event)) {
      pendingInterruptKeyup = false
      observeLinuxEvent()
      return false
    }

    if (shouldHandleInterrupt(event, { isMac, hasSelection: options.hasSelection() })) {
      if (event.type === 'keydown') {
        pendingInterruptKeyup = true
        options.sendInput(TERMINAL_INTERRUPT_INPUT, 'key:ctrl+c')
        options.resetKittyProtocol()
      } else {
        pendingInterruptKeyup = false
      }
      observeLinuxEvent()
      return false
    }

    if (isHandledKeyEvent(event.type) && MODIFIER_KEYS.has(event.key)) {
      observeLinuxEvent()
      return false
    }

    if (nativeTextForwarder.claimKeyEvent(event)) {
      observeLinuxEvent()
      return false
    }

    const bypass = shouldBypassXterm(event, { isMac, hasSelection: options.hasSelection() })
    observeLinuxEvent()
    return !bypass
  }

  const resetTransientState = (): void => {
    pendingInterruptKeyup = false
    pendingCandidateReleases.clear()
    mappedPresses.clear()
    linuxCandidateState.reset()
  }
  options.terminalElement?.addEventListener('blur', resetTransientState, true)

  return {
    handle,
    dispose: () => {
      options.terminalElement?.removeEventListener('blur', resetTransientState, true)
      resetTransientState()
      nativeTextForwarder.dispose()
      composition.dispose()
    },
  }
}

function isHandledKeyEvent(type: string): boolean {
  return type === 'keydown' || type === 'keyup'
}

function keyboardPressId(event: KeyboardEventLike): string {
  return event.code || event.key
}

function isPlainCtrlC(event: KeyboardEventLike): boolean {
  const key = event.key.toLowerCase()
  const isC = key === 'c' || ((key === '' || key === 'unidentified') && (event.code === 'KeyC' || event.keyCode === 67))
  return isC && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
}

function shouldHandleInterrupt(
  event: KeyboardEventLike,
  options: { isMac: boolean; hasSelection: boolean },
): boolean {
  if (!isHandledKeyEvent(event.type) || !isPlainCtrlC(event)) return false
  return options.isMac || !options.hasSelection
}

function shouldSuppressInterruptKeyup(event: KeyboardEventLike): boolean {
  const key = event.key.toLowerCase()
  const isC = key === 'c' || event.code === 'KeyC' || event.keyCode === 67
  return event.type === 'keyup' && isC && !event.metaKey && !event.altKey && !event.shiftKey
}

function shouldBypassXterm(
  event: KeyboardEventLike,
  options: { isMac: boolean; hasSelection: boolean },
): boolean {
  if (!isHandledKeyEvent(event.type)) return false

  const platformModifierHeld = options.isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
  if (event.defaultPrevented && platformModifierHeld) return true

  if (
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    isSingleNonAsciiPrintable(event.key)
  ) {
    return true
  }

  const key = event.key.toLowerCase()
  if (options.isMac) {
    return event.metaKey && !event.ctrlKey && !event.altKey && (key === 'c' || key === 'v')
  }

  if (event.ctrlKey && !event.metaKey && !event.altKey) {
    if (key === 'c' && (event.shiftKey || options.hasSelection)) return true
    if (key === 'v') return true
  }
  return key === 'insert' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
}

function isSingleNonAsciiPrintable(key: string): boolean {
  const chars = Array.from(key)
  const codePoint = chars.length === 1 ? chars[0].codePointAt(0) : undefined
  return codePoint !== undefined && codePoint >= 0x80
}

function isCandidateSelectionKey(event: KeyboardEventLike): boolean {
  return (
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    IME_CANDIDATE_KEYS.has(event.key)
  )
}

function isCandidateDigit(event: KeyboardEventLike): boolean {
  return isCandidateSelectionKey(event) && IME_CANDIDATE_DIGITS.has(event.key)
}

function shouldSuppressImeEvent(event: KeyboardEventLike, options: ImeOptions): boolean {
  const suppressOrphanCandidateDigit =
    options.isLinux && options.linuxOrphanCandidateDigitGuardActive && isCandidateDigit(event)
  const suppressCandidateKey =
    options.isLinux &&
    (options.pendingCandidateKeyReleaseActive ||
      (options.candidateKeyGuardActive && isCandidateSelectionKey(event)) ||
      suppressOrphanCandidateDigit)

  if (event.type === 'keypress') return suppressCandidateKey
  if (!isHandledKeyEvent(event.type)) return false

  const passesStandalone229Keydown = options.isMac || options.isLinux
  return (
    event.isComposing === true ||
    (event.keyCode === 229 &&
      (event.type !== 'keydown' || options.compositionActive || !passesStandalone229Keydown)) ||
    (options.compositionActive && IME_OWNED_KEYS.has(event.key)) ||
    suppressCandidateKey
  )
}

function shouldPreventDefaultCandidateKey(event: KeyboardEventLike, options: ImeOptions): boolean {
  return (
    event.type === 'keydown' &&
    options.isLinux &&
    ((options.candidateKeyGuardActive && isCandidateSelectionKey(event)) ||
      (options.linuxOrphanCandidateDigitGuardActive && isCandidateDigit(event)))
  )
}

function armPendingCandidateRelease(
  event: KeyboardEventLike,
  releases: Map<string, number>,
  now: number,
): void {
  if (event.type === 'keydown' && isCandidateSelectionKey(event)) {
    releases.set(event.key, now + IME_POST_COMPOSITION_MS)
  }
}

function shouldApplyPendingCandidateRelease(
  event: KeyboardEventLike,
  releases: Map<string, number>,
  now: number,
): boolean {
  if (event.type === 'keydown') {
    return event.repeat === true && isCandidateSelectionKey(event) && releases.has(event.key)
  }
  if (event.type === 'keyup') return IME_CANDIDATE_KEYS.has(event.key) && releases.has(event.key)
  if (!isCandidateSelectionKey(event)) return false
  const expiresAt = releases.get(event.key)
  return expiresAt !== undefined && now <= expiresAt
}

function clearPendingCandidateRelease(event: KeyboardEventLike, releases: Map<string, number>): void {
  if (event.type === 'keyup' || (event.type === 'keydown' && event.repeat !== true)) {
    releases.delete(event.key)
  }
}

function installCompositionTracker(element: HTMLElement | null | undefined, now: () => number) {
  let active = false
  let lastCompositionEventAt: number | null = null
  let compositionEndedAt: number | null = null
  let sawEmptyCompositionUpdate = false

  const isActive = (): boolean =>
    active &&
    (lastCompositionEventAt === null || now() - lastCompositionEventAt <= IME_STALE_COMPOSITION_MS)
  const isCandidateKeyGuardActive = (): boolean =>
    isActive() ||
    (compositionEndedAt !== null && now() - compositionEndedAt <= IME_POST_COMPOSITION_MS)

  const markActive = (): void => {
    active = true
    lastCompositionEventAt = now()
    compositionEndedAt = null
    sawEmptyCompositionUpdate = false
  }
  const updateComposition = (event: Event): void => {
    lastCompositionEventAt = now()
    const data = (event as CompositionEvent).data
    if (data === '') {
      sawEmptyCompositionUpdate = true
    } else {
      active = true
    }
  }
  const endComposition = (): void => {
    active = false
    compositionEndedAt = sawEmptyCompositionUpdate ? now() : null
    sawEmptyCompositionUpdate = false
  }
  const handleInput = (event: Event): void => {
    if ((event as InputEvent).inputType === 'insertCompositionText') return
    active = false
    compositionEndedAt = null
    sawEmptyCompositionUpdate = false
  }
  const reset = (): void => {
    active = false
    lastCompositionEventAt = null
    compositionEndedAt = null
    sawEmptyCompositionUpdate = false
  }

  element?.addEventListener('compositionstart', markActive, true)
  element?.addEventListener('compositionupdate', updateComposition, true)
  element?.addEventListener('compositionend', endComposition, true)
  element?.addEventListener('input', handleInput, true)
  element?.addEventListener('blur', reset, true)

  return {
    isActive,
    isCandidateKeyGuardActive,
    dispose: () => {
      element?.removeEventListener('compositionstart', markActive, true)
      element?.removeEventListener('compositionupdate', updateComposition, true)
      element?.removeEventListener('compositionend', endComposition, true)
      element?.removeEventListener('input', handleInput, true)
      element?.removeEventListener('blur', reset, true)
    },
  }
}

function createLinuxCandidateState(now: () => number) {
  const pendingLetterKeydowns = new Set<string>()
  let candidateDigitUntil = 0

  const isPlainLetter = (event: KeyboardEventLike): boolean =>
    /^[a-z]$/.test(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
  const isPlainDigit = (event: KeyboardEventLike): boolean =>
    /^[0-9]$/.test(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey

  return {
    classify: (event: KeyboardEventLike) => ({
      candidateDigitGuardActive:
        event.type === 'keydown' && isPlainDigit(event) && candidateDigitUntil > now(),
    }),
    observe: (
      event: KeyboardEventLike,
      classification: { candidateDigitGuardActive: boolean },
    ): void => {
      const at = now()
      if (classification.candidateDigitGuardActive) {
        candidateDigitUntil = 0
        return
      }
      if (candidateDigitUntil <= at) candidateDigitUntil = 0

      if (event.type === 'keydown') {
        if (!isPlainDigit(event)) candidateDigitUntil = 0
        if (event.code && /^Key[A-Z]$/.test(event.code)) pendingLetterKeydowns.add(event.code)
        return
      }
      if (event.type === 'keyup' && isPlainLetter(event) && event.code) {
        const matchedKeydown = pendingLetterKeydowns.delete(event.code)
        if (!matchedKeydown) candidateDigitUntil = at + LINUX_ORPHAN_CANDIDATE_WINDOW_MS
      }
    },
    reset: (): void => {
      pendingLetterKeydowns.clear()
      candidateDigitUntil = 0
    },
  }
}

function installNativeTextForwarder(args: {
  terminalElement: HTMLElement | null | undefined
  isComposing: () => boolean
  sendInput: (data: string) => void
}) {
  let pendingForward = false
  let claimedPress: { key: string; code?: string } | null = null
  let clearTimer: number | null = null

  const clear = (): void => {
    if (clearTimer !== null) window.clearTimeout(clearTimer)
    clearTimer = null
    pendingForward = false
    claimedPress = null
  }
  const matchesClaim = (event: KeyboardEventLike): boolean => {
    if (!claimedPress) return false
    if (event.code && claimedPress.code) return event.code === claimedPress.code
    return event.key === claimedPress.key || (event.type === 'keypress' && isSinglePrintable(event.key))
  }
  const claimKeyEvent = (event: KeyboardEventLike): boolean => {
    if (event.type === 'keydown') {
      if (!isNativeTextCandidate(event, args.isComposing())) return false
      if (clearTimer !== null) window.clearTimeout(clearTimer)
      clearTimer = null
      pendingForward = true
      claimedPress = { key: event.key, code: event.code }
      return true
    }
    if (!matchesClaim(event) || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) {
      return false
    }
    if (event.type === 'keyup') {
      claimedPress = null
      clearTimer = window.setTimeout(clear, 100)
      return true
    }
    return event.type === 'keypress'
  }
  const forwardInput = (event: Event): void => {
    const input = event as InputEvent
    if (!pendingForward) return
    if (input.inputType !== 'insertText') {
      clear()
      return
    }
    const data = input.data
    clear()
    if (data) args.sendInput(data)
    event.stopImmediatePropagation()
    if (event.target instanceof HTMLTextAreaElement) event.target.value = ''
  }

  args.terminalElement?.addEventListener('input', forwardInput, true)
  args.terminalElement?.addEventListener('blur', clear, true)
  return {
    claimKeyEvent,
    dispose: () => {
      clear()
      args.terminalElement?.removeEventListener('input', forwardInput, true)
      args.terminalElement?.removeEventListener('blur', clear, true)
    },
  }
}

function isNativeTextCandidate(event: KeyboardEventLike, compositionActive: boolean): boolean {
  if (
    event.type !== 'keydown' ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    event.isComposing ||
    compositionActive
  ) {
    return false
  }
  const code = event.code?.trim()
  const unreliablePhysicalKey = !code || code === 'Unidentified' || (event.keyCode ?? event.which) === 0
  if (unreliablePhysicalKey && (event.key === 'Unidentified' || isSinglePrintable(event.key))) return true
  return Array.from(event.key).length === 1 && CJK_DIRECT_PUNCTUATION_KEYS.has(event.key)
}

function isSinglePrintable(key: string): boolean {
  const chars = Array.from(key)
  const codePoint = chars.length === 1 ? chars[0].codePointAt(0) : undefined
  return codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f
}

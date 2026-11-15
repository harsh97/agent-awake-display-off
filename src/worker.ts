// Keeps the computer awake while an Orca agent works, without keeping the
// display on.
//
// Orca's built-in keep-awake starts Electron's `prevent-display-sleep` blocker,
// which keeps the screen lit. This plugin holds only a logind sleep inhibitor
// (`sleep:handle-lid-switch`), the same `what` Orca already uses on Linux, and
// never an `idle` inhibitor or a display blocker. Logind blocks system
// suspend; GNOME's blank-screen and DPMS timers are untouched.
//
// The mode mirrors Orca's own keep-awake control:
//   on    — always hold the inhibitor
//   agent — hold it only while an agent's state is `working` (the default)
//   off   — never hold it
import { spawn, type ChildProcess } from 'node:child_process'
import type { OrcaWorkerApi } from 'orca/worker'

const ITEM_ID = 'agent-awake-status'
const COMMAND_CYCLE = 'agent-awake-display-off.cycle'
const COMMAND_SET_ON = 'agent-awake-display-off.set-on'
const COMMAND_SET_AGENT = 'agent-awake-display-off.set-agent'
const COMMAND_SET_OFF = 'agent-awake-display-off.set-off'
const COMMAND_REFRESH = 'agent-awake-display-off.refresh'
const WHAT = 'sleep:handle-lid-switch'
const WHO = 'orca-agent-awake'
const WHY = 'Orca agents are working; the display may turn off'
const POLL_MS = 30_000
const RETRY_MS = 30_000
const WARNING_POLL_MS = 5 * 60_000
const RECONCILE_MS = 3000
const TOOLTIP_MAX = 256

export type Mode = 'on' | 'agent' | 'off'
export const MODES: Mode[] = ['on', 'agent', 'off']
export const MODE_LABELS: Record<Mode, string> = { on: 'On', agent: 'Agent', off: 'Off' }

export function normalizeMode(value: unknown): Mode {
  return value === 'on' || value === 'agent' || value === 'off' ? value : 'agent'
}

// Same order as Orca's own control: On, Agent, Off.
export function nextMode(mode: Mode): Mode {
  const index = MODES.indexOf(mode)
  return MODES[(index + 1) % MODES.length]
}

export function shouldHold(mode: Mode, working: boolean): boolean {
  return mode === 'on' || (mode === 'agent' && working)
}

export type ReconcilePlan = {
  mode: Mode
  wanted: boolean
  held: boolean
  reverted: boolean
  mismatch: boolean
}

// What the click showed vs. what the system actually has: `stored` is the mode
// Orca saved, `held` is the logind inhibitor row. A change that did not stick
// reverts to the stored mode, and a mode/state mismatch is shown as ground truth.
export function planReconcile(shown: Mode, stored: unknown, held: boolean, working: boolean): ReconcilePlan {
  const mode = normalizeMode(stored)
  const wanted = shouldHold(mode, working)
  return { mode, wanted, held, reverted: mode !== shown, mismatch: held !== wanted }
}

export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

export type AgentStatusEvent = {
  workspaceId: string | null
  paneKey: string
  terminalId?: string
  title?: string
  state: AgentState
  receivedAt: number
}

export type ListedAgent = {
  terminalId: string | null
  state: AgentState
}

type Entry = { terminalId?: string; at: number }

// Mirrors Orca's own agent-awake rule: only `working` counts. `blocked` and
// `waiting` agents are waiting for a person, so the machine may suspend.
export class AgentStatusTracker {
  private running = new Map<string, Entry>()
  private listed = new Map<string, Entry>()

  update(event: AgentStatusEvent): void {
    const key = event.terminalId ?? event.paneKey
    if (event.state === 'working') {
      this.running.set(key, { terminalId: event.terminalId, at: event.receivedAt })
      if (event.terminalId) this.listed.delete(event.terminalId)
      return
    }
    this.running.delete(key)
    if (!event.terminalId) return
    this.listed.delete(event.terminalId)
    for (const [paneKey, entry] of this.running) {
      if (entry.terminalId === event.terminalId) this.running.delete(paneKey)
    }
  }

  // `agents.list` only covers the focused workspace, so it is a bootstrap and a
  // cleanup source, not the primary signal. Event entries win over listed ones.
  setListed(agents: ListedAgent[]): void {
    const next = new Map<string, Entry>()
    for (const agent of agents) {
      if (!agent.terminalId) continue
      if (agent.state === 'working') {
        if (!this.running.has(agent.terminalId)) {
          next.set(agent.terminalId, { terminalId: agent.terminalId, at: Date.now() })
        }
        continue
      }
      this.running.delete(agent.terminalId)
      for (const [paneKey, entry] of this.running) {
        if (entry.terminalId === agent.terminalId) this.running.delete(paneKey)
      }
    }
    this.listed = next
  }

  isActive(): boolean {
    return this.running.size + this.listed.size > 0
  }

  count(): number {
    return this.running.size + this.listed.size
  }
}

export type Logger = (message: string) => void
export type SpawnOptions = { stdio: ('pipe' | 'ignore')[]; windowsHide?: boolean }
export type SpawnFn = (program: string, args: string[], options: SpawnOptions) => ChildProcess

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingBinary(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

// `cat` on a stdin pipe is deliberate: if Orca or the plugin worker dies, the
// pipe closes, cat sees EOF, and the inhibitor is released by the kernel
// instead of leaking a machine that never sleeps again.
export class SleepInhibitor {
  private child: ChildProcess | null = null
  private unavailable = false
  private retryAt = 0
  lastError: string | null = null

  constructor(
    private log: Logger,
    private spawnProcess: SpawnFn = spawn,
    private now: () => number = Date.now
  ) {}

  get active(): boolean {
    return this.child !== null
  }

  get missing(): boolean {
    return this.unavailable
  }

  ensure(): void {
    if (this.child || this.unavailable || this.now() < this.retryAt) return
    let child: ChildProcess
    try {
      child = this.spawnProcess(
        'systemd-inhibit',
        [`--what=${WHAT}`, `--who=${WHO}`, `--why=${WHY}`, '--mode=block', 'cat'],
        { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }
      )
    } catch (error) {
      this.handleFailure(error)
      return
    }
    this.child = child
    child.on('error', (error: unknown) => {
      if (this.child !== child) return
      this.child = null
      this.handleFailure(error)
    })
    child.on('exit', (code: number | null, signal: string | null) => {
      if (this.child !== child) return
      this.child = null
      this.handleFailure(`systemd-inhibit exited (code ${String(code)}, signal ${String(signal)})`)
    })
  }

  release(): void {
    const child = this.child
    if (!child) return
    this.child = null
    try {
      child.stdin?.destroy()
    } catch {
      // Already gone; the exit handler below ignores stale children.
    }
    try {
      child.kill()
    } catch {
      // Same.
    }
  }

  private handleFailure(error: unknown): void {
    const message = errorMessage(error)
    if (isMissingBinary(error)) {
      this.unavailable = true
      this.lastError = 'systemd-inhibit is not installed'
      this.log('cannot hold the sleep inhibitor: systemd-inhibit is not installed')
      return
    }
    this.lastError = message
    this.retryAt = this.now() + RETRY_MS
    this.log(`sleep inhibitor failed: ${message}`)
  }
}

// The built-in setting (`Keep computer awake`) holds the same logind inhibitor
// with `--who=Orca`, plus Electron's display blocker. Seeing that row means the
// display will stay on no matter what this plugin does.
export function builtinAwakeActive(listing: string): boolean {
  for (const line of listing.split('\n')) {
    if (!/^Orca\s+\d+\s/.test(line)) continue
    if (/\bsleep\b/.test(line) && /handle-lid-switch/.test(line)) return true
  }
  return false
}

// The system's own answer to "is this plugin holding a sleep inhibitor right
// now?", independent of whether this worker thinks its child is alive.
export function ourInhibitorActive(listing: string): boolean {
  for (const line of listing.split('\n')) {
    if (!line.startsWith(`${WHO} `)) continue
    if (/\bsleep\b/.test(line) && /handle-lid-switch/.test(line)) return true
  }
  return false
}

export function readInhibitList(): Promise<string> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn('systemd-inhibit', ['--list'], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve('')
      return
    }
    let text = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Ignore.
      }
    }, 5000)
    child.stdout?.on('data', (chunk: unknown) => {
      text += String(chunk)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(text)
    })
  })
}

let timers: { unref?: () => void }[] = []
let subscriptions: { dispose(): void }[] = []
let inhibitor: SleepInhibitor | null = null
let reconcileTimer: { unref?: () => void } | null = null

export default function activate(orca: OrcaWorkerApi): void {
  const log: Logger = (message) => orca.log(String(message))
  if (process.platform !== 'linux') {
    log(`sleep inhibitors are logind-only; this plugin does nothing on ${process.platform}`)
    void orca.host
      .call('statusBar.update', {
        id: ITEM_ID,
        text: 'Awake: n/a',
        icon: 'warning',
        tone: 'warning',
        tooltip: 'Agent Awake holds a logind sleep inhibitor and only works on Linux.',
        visible: true
      })
      .catch(() => undefined)
    return
  }

  const tracker = new AgentStatusTracker()
  const sleeper = new SleepInhibitor(log)
  inhibitor = sleeper
  let mode: Mode = 'agent'
  let builtinConflict = false
  let verifiedHeld: boolean | null = null
  let optimistic = false
  let pendingToken = 0
  let shownKey = ''
  let lastActive = false
  let disposed = false
  let chain: Promise<void> = Promise.resolve()

  const queue = (task: () => Promise<void>): void => {
    chain = chain.then(task).catch((error) => log(`agent awake: ${errorMessage(error)}`))
  }

  const describe = (): string => {
    const active = shouldHold(mode, tracker.isActive())
    const state = !active
      ? 'not holding a sleep inhibitor'
      : mode === 'on'
        ? 'holding a sleep inhibitor'
        : `holding a sleep inhibitor for ${tracker.count()} working agent(s)`
    const warning = builtinConflict ? ' Built-in keep-awake is also on and keeps the display lit.' : ''
    return `Agent Awake mode ${MODE_LABELS[mode]}: ${state}; display may turn off.${warning}`
  }

  const publish = async (): Promise<void> => {
    const count = tracker.count()
    const active = shouldHold(mode, tracker.isActive())
    const held = verifiedHeld ?? sleeper.active
    const holding = active && held
    const failed = !optimistic && held !== active
    const warning = builtinConflict
      ? ' Orca\'s built-in "Keep computer awake" is also on and keeps the display lit: set it to Off in Settings.'
      : ''
    const failure =
      !optimistic && active && !held
        ? ` Could not hold the sleep inhibitor: ${sleeper.lastError ?? 'the inhibitor is not running'}.`
        : ''
    const stuck =
      !optimistic && !active && held
        ? ` An ${WHO} sleep inhibitor is still held although mode ${MODE_LABELS[mode]} does not want one; suspend may stay blocked until it exits.`
        : ''
    const text = failed ? 'Awake: Failed' : `Awake: ${MODE_LABELS[mode]}`
    const base = !active
      ? mode === 'off'
        ? 'Off: this computer may suspend as normal.'
        : 'Agent: no agent is working, so system sleep is allowed.'
      : optimistic || held
        ? mode === 'on'
          ? 'On: holding a sleep inhibitor; system sleep is blocked and the display can still turn off.'
          : `Agent: holding a sleep inhibitor for ${count} working agent${count === 1 ? '' : 's'}; the display can still turn off.`
        : `Agent: ${count} working agent${count === 1 ? '' : 's'}, but the inhibitor is not running.`
    const hint = ` Click to switch to ${MODE_LABELS[nextMode(mode)]}.`
    const key = `${text}|${String(count)}|${String(builtinConflict)}|${String(verifiedHeld)}|${String(optimistic)}|${sleeper.lastError ?? ''}`
    if (key === shownKey) return
    shownKey = key
    try {
      await orca.host.call('statusBar.update', {
        id: ITEM_ID,
        text,
        icon: failed ? 'warning' : holding ? 'zap' : active && optimistic ? 'zap' : 'pause',
        tone: failed ? 'danger' : holding ? 'accent' : active && optimistic ? 'accent' : 'neutral',
        tooltip: clip(`${base}${failure}${stuck}${warning}${hint}`, TOOLTIP_MAX),
        visible: true
      })
    } catch (error) {
      log(`statusBar.update failed: ${errorMessage(error)}`)
    }
  }

  const sync = async (): Promise<void> => {
    if (disposed) return
    const wanted = shouldHold(mode, tracker.isActive())
    // The system is about to change; stop reporting the last read snapshot.
    verifiedHeld = null
    if (wanted) sleeper.ensure()
    else sleeper.release()
    if (wanted !== lastActive) {
      lastActive = wanted
      log(
        wanted
          ? `mode ${MODE_LABELS[mode]}: holding sleep inhibitor for ${tracker.count()} working agent${tracker.count() === 1 ? '' : 's'}; display may turn off`
          : `mode ${MODE_LABELS[mode]}: released sleep inhibitor; system sleep allowed`
      )
    }
    await publish()
  }

  const refreshList = async (): Promise<void> => {
    if (!orca.host.has('agents.list')) return
    try {
      const { agents } = await orca.host.call('agents.list')
      tracker.setListed(agents)
    } catch (error) {
      log(`agents.list failed: ${errorMessage(error)}`)
    }
  }

  const checkBuiltin = async (): Promise<void> => {
    const listing = await readInhibitList()
    verifiedHeld = ourInhibitorActive(listing)
    const conflict = builtinAwakeActive(listing)
    if (conflict === builtinConflict) return
    builtinConflict = conflict
    log(
      conflict
        ? 'Orca\'s built-in "Keep computer awake" is holding a sleep inhibitor too. It also blocks display sleep; set Settings → Keep computer awake to Off.'
        : 'Orca\'s built-in keep-awake no longer holds a sleep inhibitor.'
    )
  }

  const applyMode = async (value: unknown): Promise<void> => {
    mode = normalizeMode(value)
    await refreshList()
    await sync()
  }

  const saveMode = async (next: Mode): Promise<void> => {
    try {
      await orca.settings.set('mode', next)
    } catch (error) {
      log(`could not save the mode setting: ${errorMessage(error)}`)
    }
    await applyMode(next)
  }

  // 3 seconds after a click, read the ground truth: the mode Orca actually
  // stored and the logind inhibitor row. If either differs from what the click
  // showed, show the real state. This does not repair anything; the regular
  // sync retries the mode on its next tick.
  const reconcile = async (): Promise<void> => {
    let stored: unknown = mode
    try {
      stored = await orca.settings.get('mode')
    } catch (error) {
      log(`could not re-read the mode setting: ${errorMessage(error)}`)
    }

    const listing = await readInhibitList()
    builtinConflict = builtinAwakeActive(listing)
    const plan = planReconcile(mode, stored, ourInhibitorActive(listing), tracker.isActive())
    if (plan.reverted) {
      log(`mode ${MODE_LABELS[mode]} was not applied; the stored mode is ${MODE_LABELS[plan.mode]}. Showing the real state.`)
    }
    if (plan.mismatch) {
      log(
        `ground truth after ${RECONCILE_MS / 1000}s: inhibitor ${plan.held ? 'held' : 'not held'}, mode ${MODE_LABELS[plan.mode]} wants it ${plan.wanted ? 'held' : 'not held'}. Showing the real state.`
      )
    }
    mode = plan.mode
    verifiedHeld = plan.held
    optimistic = false
    await publish()
  }

  const scheduleReconcile = (token: number, settle: Promise<void>): void => {
    if (reconcileTimer) clearTimeout(reconcileTimer)
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null
      queue(async () => {
        await settle.catch((error) => log(`mode change failed: ${errorMessage(error)}`))
        if (disposed || token !== pendingToken) return
        await reconcile()
      })
    }, RECONCILE_MS)
    reconcileTimer.unref?.()
  }

  // Show the new mode immediately, then persist and reconcile it.
  const changeMode = async (next: Mode): Promise<string> => {
    const token = ++pendingToken
    optimistic = true
    mode = next
    await publish()
    const settle = saveMode(next)
    scheduleReconcile(token, settle)
    await settle
    return describe()
  }

  const cycle = (): Promise<string> => changeMode(nextMode(mode))

  subscriptions.push(
    orca.events.on('agent.status.changed', (event) => {
      tracker.update(event)
      queue(sync)
    }),
    orca.settings.onDidChange((change) => {
      if (change.key !== 'mode') return
      queue(async () => {
        await applyMode(await orca.settings.get('mode'))
      })
    }),
    orca.commands.register(COMMAND_CYCLE, async () => cycle()),
    orca.commands.register(COMMAND_SET_ON, async () => changeMode('on')),
    orca.commands.register(COMMAND_SET_AGENT, async () => changeMode('agent')),
    orca.commands.register(COMMAND_SET_OFF, async () => changeMode('off')),
    orca.commands.register(COMMAND_REFRESH, async () => {
      await refreshList()
      await checkBuiltin()
      await sync()
      return describe()
    })
  )

  queue(async () => {
    const stored = await orca.settings.get('mode')
    log(`mode setting: ${stored === undefined ? 'unset' : JSON.stringify(stored)}`)
    await applyMode(stored)
    await checkBuiltin()
    await sync()
  })
  timers = [
    setInterval(() => {
      queue(async () => {
        await refreshList()
        await sync()
      })
    }, POLL_MS),
    setInterval(() => {
      queue(async () => {
        await checkBuiltin()
        await publish()
      })
    }, WARNING_POLL_MS)
  ]
  for (const timer of timers) timer.unref?.()
}

export function deactivate(): void {
  for (const timer of timers) clearInterval(timer)
  timers = []
  if (reconcileTimer) {
    clearTimeout(reconcileTimer)
    reconcileTimer = null
  }
  for (const subscription of subscriptions) subscription.dispose()
  subscriptions = []
  inhibitor?.release()
  inhibitor = null
}

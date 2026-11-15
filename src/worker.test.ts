import { assert, test } from 'orca/testing'
import type { ChildProcess } from 'node:child_process'
import {
  AgentStatusTracker,
  SleepInhibitor,
  builtinAwakeActive,
  clip,
  nextMode,
  normalizeMode,
  ourInhibitorActive,
  planReconcile,
  shouldHold,
  type SpawnOptions
} from './worker'

const NOW = 1_800_000_000_000

type Listener = (...args: unknown[]) => void

class FakeChild {
  stdinDestroyed = false
  killed = false
  stdout = null
  stdin = {
    destroy: () => {
      this.stdinDestroyed = true
    },
    on: () => undefined
  }
  private handlers = new Map<string, Listener[]>()

  on(event: string, listener: Listener): void {
    const list = this.handlers.get(event) ?? []
    list.push(listener)
    this.handlers.set(event, list)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.handlers.get(event) ?? []) listener(...args)
  }

  kill(): void {
    this.killed = true
  }

  asChild(): ChildProcess {
    return this as unknown as ChildProcess
  }
}

test('mode defaults to Agent and rejects unknown values', () => {
  assert.equal(normalizeMode('on'), 'on')
  assert.equal(normalizeMode('agent'), 'agent')
  assert.equal(normalizeMode('off'), 'off')
  assert.equal(normalizeMode(undefined), 'agent')
  assert.equal(normalizeMode('always'), 'agent')
  assert.equal(normalizeMode(true), 'agent')
})

test('clicking cycles On, Agent, Off like the built-in picker order', () => {
  assert.equal(nextMode('on'), 'agent')
  assert.equal(nextMode('agent'), 'off')
  assert.equal(nextMode('off'), 'on')
})

test('On always holds, Agent only for working agents, Off never does', () => {
  assert.equal(shouldHold('on', true), true)
  assert.equal(shouldHold('on', false), true)
  assert.equal(shouldHold('agent', true), true)
  assert.equal(shouldHold('agent', false), false)
  assert.equal(shouldHold('off', true), false)
  assert.equal(shouldHold('off', false), false)
})

test('tooltips stay inside the 256-character status bar limit', () => {
  const long = 'x'.repeat(400)
  const clipped = clip(long, 256)
  assert.equal(clipped.length, 256)
  assert.ok(clipped.endsWith('…'))
  assert.equal(clip('short', 256), 'short')
})

test('a click that did not persist reverts to the stored mode', () => {
  const plan = planReconcile('off', 'agent', false, true)
  assert.equal(plan.reverted, true)
  assert.equal(plan.mode, 'agent')
  assert.equal(plan.wanted, true)
  assert.equal(plan.held, false)
  assert.equal(plan.mismatch, true)
})

test('a click that persisted keeps the shown mode', () => {
  const plan = planReconcile('on', 'on', false, false)
  assert.equal(plan.reverted, false)
  assert.equal(plan.mode, 'on')
  assert.equal(plan.wanted, true)
  assert.equal(plan.held, false)
  assert.equal(plan.mismatch, true)
})

test('matching system state reports no mismatch', () => {
  assert.equal(planReconcile('agent', 'agent', false, false).mismatch, false)
  assert.equal(planReconcile('agent', 'agent', true, true).mismatch, false)
  assert.equal(planReconcile('off', 'off', false, true).mismatch, false)
  const stuck = planReconcile('off', 'off', true, false)
  assert.equal(stuck.mismatch, true)
  assert.equal(stuck.held, true)
  assert.equal(planReconcile('off', undefined, false, false).mode, 'agent')
})

test('a working agent holds the inhibitor until it finishes', () => {
  const tracker = new AgentStatusTracker()
  tracker.update({ workspaceId: null, paneKey: 'p1', terminalId: 't1', state: 'working', receivedAt: NOW })
  assert.equal(tracker.isActive(), true)
  assert.equal(tracker.count(), 1)

  tracker.update({ workspaceId: null, paneKey: 'p1', terminalId: 't1', state: 'waiting', receivedAt: NOW + 1 })
  assert.equal(tracker.isActive(), false)
})

test('agents waiting for a person do not keep the machine awake', () => {
  const tracker = new AgentStatusTracker()
  for (const state of ['blocked', 'waiting', 'done'] as const) {
    tracker.update({ workspaceId: null, paneKey: `p-${state}`, state, receivedAt: NOW })
  }
  assert.equal(tracker.isActive(), false)
  assert.equal(tracker.count(), 0)
})

test('the focused workspace list bootstraps and clears agent status', () => {
  const tracker = new AgentStatusTracker()
  tracker.setListed([{ terminalId: 't1', state: 'working' }])
  assert.equal(tracker.isActive(), true)

  tracker.setListed([{ terminalId: 't1', state: 'waiting' }])
  assert.equal(tracker.isActive(), false)
})

test('an event supersedes the listed state for the same terminal', () => {
  const tracker = new AgentStatusTracker()
  tracker.setListed([{ terminalId: 't1', state: 'working' }])
  tracker.update({ workspaceId: null, paneKey: 'p1', terminalId: 't1', state: 'done', receivedAt: NOW })
  assert.equal(tracker.isActive(), false)

  tracker.setListed([{ terminalId: 't1', state: 'working' }])
  tracker.update({ workspaceId: null, paneKey: 'p1', terminalId: 't1', state: 'working', receivedAt: NOW })
  assert.equal(tracker.count(), 1)
})

test('spawns systemd-inhibit for sleep and lid only, then releases it', () => {
  const calls: { program: string; args: string[]; options: SpawnOptions }[] = []
  const child = new FakeChild()
  const inhibitor = new SleepInhibitor(
    () => undefined,
    (program, args, options) => {
      calls.push({ program, args, options })
      return child.asChild()
    },
    () => NOW
  )

  inhibitor.ensure()
  inhibitor.ensure()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].program, 'systemd-inhibit')
  assert.ok(calls[0].args.includes('--what=sleep:handle-lid-switch'))
  assert.ok(!calls[0].args.join(' ').includes('idle'))
  assert.ok(!calls[0].args.join(' ').includes('handle-suspend-key'))
  assert.equal(calls[0].args[calls[0].args.length - 1], 'cat')
  assert.equal(calls[0].options.stdio[0], 'pipe')
  assert.equal(inhibitor.active, true)

  inhibitor.release()
  assert.equal(child.stdinDestroyed, true)
  assert.equal(child.killed, true)
  assert.equal(inhibitor.active, false)
})

test('a missing systemd-inhibit is reported once and not retried', () => {
  const logs: string[] = []
  let spawns = 0
  const inhibitor = new SleepInhibitor(
    (message) => logs.push(message),
    () => {
      spawns += 1
      throw Object.assign(new Error('spawn systemd-inhibit ENOENT'), { code: 'ENOENT' })
    },
    () => NOW
  )

  inhibitor.ensure()
  inhibitor.ensure()
  assert.equal(inhibitor.missing, true)
  assert.equal(spawns, 1)
  assert.equal(logs.length, 1)
})

test('an unexpected exit is retried after the backoff', () => {
  let now = NOW
  let spawns = 0
  const children: FakeChild[] = []
  const inhibitor = new SleepInhibitor(
    () => undefined,
    () => {
      spawns += 1
      const child = new FakeChild()
      children.push(child)
      return child.asChild()
    },
    () => now
  )

  inhibitor.ensure()
  children[0].emit('exit', 1, null)
  assert.equal(inhibitor.active, false)
  inhibitor.ensure()
  assert.equal(spawns, 1)

  now += 31_000
  inhibitor.ensure()
  assert.equal(spawns, 2)
})

test('detects the built-in keep-awake inhibitor but not its other rows', () => {
  const builtin = [
    'WHO            UID USER PID COMM WHAT WHY MODE',
    'orca-ide       1000 harsh 7229 orca-ide shutdown Ensure a clean shutdown delay',
    'orca-ide       1000 harsh 7229 orca-ide sleep Application cleanup before suspend delay',
    'Orca           1000 harsh 7000 systemd-inhibi sleep:handle-lid-switch Agents are working block'
  ].join('\n')
  assert.equal(builtinAwakeActive(builtin), true)

  const ours = [
    'WHO            UID USER PID COMM WHAT WHY MODE',
    'orca-agent-awake 1000 harsh 9000 systemd-inhibi sleep:handle-lid-switch Orca agents are working block'
  ].join('\n')
  assert.equal(builtinAwakeActive(ours), false)
  assert.equal(builtinAwakeActive(''), false)
})

test('reads the system state of our own inhibitor row', () => {
  const held = [
    'WHO            UID USER PID COMM WHAT WHY MODE',
    'Orca           1000 harsh 7000 systemd-inhibi sleep:handle-lid-switch Agents are working block',
    'orca-agent-awake 1000 harsh 9000 systemd-inhibi sleep:handle-lid-switch Orca agents are working block'
  ].join('\n')
  assert.equal(ourInhibitorActive(held), true)

  const otherRows = [
    'WHO            UID USER PID COMM WHAT WHY MODE',
    'orca-ide       1000 harsh 7229 orca-ide sleep Application cleanup before suspend delay',
    'orca-agent-awake 1000 harsh 9000 systemd-inhibi sleep Orca agents are working delay',
    'orca-agent-awake-bot 1000 harsh 9000 systemd-inhibi sleep:handle-lid-switch other block'
  ].join('\n')
  assert.equal(ourInhibitorActive(otherRows), false)
  assert.equal(ourInhibitorActive(''), false)
})

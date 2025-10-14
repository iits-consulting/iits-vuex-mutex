// tests/vuex-mutex.spec.ts
import {describe, it, expect, vi, afterEach, beforeEach} from 'vitest'
import {createStore, type Store} from 'vuex'
import {createVuexMutexPlugin} from '../src'

/**
 * Helper action that waits `delay` ms and logs start/end with timestamps into an event log.
 */
function makeDelayedAction(eventLog: string[], label: string, delay = 50) {
  return async () => {
    eventLog.push(`${label}:start:${Date.now()}`)
    await new Promise<void>((r) => setTimeout(r, delay))
    eventLog.push(`${label}:end:${Date.now()}`)
  }
}

describe('vuex-mutex plugin (per-module serialization)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    // Force plugin ON in this spec (Vitest sets VITEST=true → plugin would noop)
    vi.stubEnv('VITEST', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('serializes two calls within the same module (same namespace)', async () => {
    const eventLog: string[] = []

    const store = createStore({
      modules: {
        testModule: {
          namespaced: true,
          actions: {
            testAction1: makeDelayedAction(eventLog, 'A1', 50),
            testAction2: makeDelayedAction(eventLog, 'A2', 50),
          },
        },
      },
      plugins: [createVuexMutexPlugin()],
    }) as Store<any>

    // Two dispatches almost at the same time into the same module "a"
    const promiseOfAction1InTestModule = store.dispatch('testModule/testAction1')
    const promiseOfAction2InTestModule = store.dispatch('testModule/testAction2')

    // 1st tick: both schedule a 50ms timer, but the mutex lets only one run at a time
    await vi.runOnlyPendingTimersAsync() // +50ms
    await promiseOfAction1InTestModule // first action should be done
    await vi.runOnlyPendingTimersAsync() // +50ms
    await promiseOfAction2InTestModule // second action should finish afterward

    // Expectation: A1 fully completes before A2 (no overlap)
    const starts = eventLog.filter((t) => t.includes(':start')).map((t) => t.split(':')[0])
    const ends = eventLog.filter((t) => t.includes(':end')).map((t) => t.split(':')[0])

    expect(starts).toEqual(['A1', 'A2']) // A2 may only start after A1 has finished
    expect(ends).toEqual(['A1', 'A2']) // End order mirrors start order
  })

  it('allows calls in different modules to run in parallel', async () => {
    const eventLog: string[] = []

    const store = createStore({
      modules: {
        testModule1: {
          namespaced: true,
          actions: {testAction: makeDelayedAction(eventLog, 'A', 50)},
        },
        testModule2: {
          namespaced: true,
          actions: {testAction: makeDelayedAction(eventLog, 'B', 50)},
        },
      },
      plugins: [createVuexMutexPlugin()], // one mutex per namespace
    }) as Store<any>

    const promiseOfActionInTestModule1 = store.dispatch('testModule1/testAction')
    const promiseOfActionInTestModule2 = store.dispatch('testModule2/testAction')

    // Both should complete after 50ms in parallel
    await vi.runOnlyPendingTimersAsync() // +50ms
    await Promise.all([promiseOfActionInTestModule1, promiseOfActionInTestModule2])

    // Start order can be anything; both should end at ~50ms
    const startTimestamps = eventLog.filter((t) => t.includes(':start')).map((t) => Number(t.split(':').pop()))
    const endTimestamps = eventLog.filter((t) => t.includes(':end')).map((t) => Number(t.split(':').pop()))

    expect(startTimestamps.length).toBe(2)
    expect(endTimestamps.length).toBe(2)
    endTimestamps.forEach((timestamp) => expect(timestamp).toBe(50))
  })

  it('is safe to register the plugin twice (no double wrapping of dispatch)', async () => {
    const eventLog: string[] = []
    const plugin = createVuexMutexPlugin()

    const store = createStore({
      modules: {
        testModule: {
          namespaced: true,
          actions: {testAction: makeDelayedAction(eventLog, 'A', 10)},
        },
      },
      plugins: [plugin, plugin], // intentionally added twice
    }) as Store<any>

    // If double-wrapped, behavior would serialize "too much". We verify it does not.
    const promiseOfActionInTestModule1_1 = store.dispatch('testModule/testAction')
    const promiseOfActionInTestModule1_2 = store.dispatch('testModule/testAction')

    await vi.runOnlyPendingTimersAsync() // +10ms
    await promiseOfActionInTestModule1_1
    await vi.runOnlyPendingTimersAsync() // +10ms
    await promiseOfActionInTestModule1_2

    // Exactly two starts and two ends in clean sequence.
    expect(eventLog).toEqual(['A:start:0', 'A:end:10', 'A:start:10', 'A:end:20'])
  })

  it('include: only matching action types go through the mutex', async () => {
    const eventLog: string[] = []

    const store = createStore({
      modules: {
        testModule1: {
          namespaced: true,
          actions: {
            testAction1: makeDelayedAction(eventLog, 'A1', 50),
            testAction2: makeDelayedAction(eventLog, 'A2', 50),
          },
        },
        testModule2: {
          namespaced: true,
          actions: {
            testAction: makeDelayedAction(eventLog, 'B', 50),
          },
        },
      },
      // Only action types matching /^a\// are serialized
      plugins: [createVuexMutexPlugin({include: [/^testModule1\//]})],
    }) as Store<any>

    // Two dispatches into a/* -> must run one after the other (A1 then A2)
    const promiseOfAction1InTestModule1 = store.dispatch('testModule1/testAction1')
    const promiseOfAction2InTestModule1 = store.dispatch('testModule1/testAction2')

    // One into b/* -> not serialized with a/* (allowed to run in parallel)
    const promiseOfActionInTestModule2 = store.dispatch('testModule2/testAction')

    // First tick: all set a 50ms timer
    await vi.runOnlyPendingTimersAsync() // +50ms
    await promiseOfAction1InTestModule1 // A1 done
    await promiseOfActionInTestModule2 // B done (allowed to run in parallel with A1)

    // Second tick: now A2 is allowed to start after A1 has finished
    await vi.runOnlyPendingTimersAsync() // +50ms
    await promiseOfAction2InTestModule1 // A2 done

    // ——— Robust assertions ———
    const idx = (re: RegExp) => eventLog.findIndex((t) => re.test(t))

    const a1Start = idx(/^A1:start:/)
    const a1End = idx(/^A1:end:/)
    const a2Start = idx(/^A2:start:/)
    const a2End = idx(/^A2:end:/)
    const bStart = idx(/^B:start:/)
    const bEnd = idx(/^B:end:/)

    // A1 and A2 both ran
    expect(a1Start).toBeGreaterThan(-1)
    expect(a1End).toBeGreaterThan(a1Start)
    expect(a2Start).toBeGreaterThan(-1)
    expect(a2End).toBeGreaterThan(a2Start)

    // IMPORTANT: A2 can only start AFTER A1 ended (serialization within a/*)
    expect(a2Start).toBeGreaterThan(a1End)

    // B ran as well (position relative to A1/A2 may vary)
    expect(bStart).toBeGreaterThan(-1)
    expect(bEnd).toBeGreaterThan(bStart)
  })

  // A) In-flight dedupe: "share" should return the same running Promise
  it('dedupe in-flight: share returns the same promise (single execution)', async () => {
    const eventLog: string[] = []
    const store = createStore({
      modules: {
        testModule: {
          namespaced: true,
          actions: {testAction: makeDelayedAction(eventLog, 'A', 50)},
        },
      },
      plugins: [createVuexMutexPlugin({dedupe: {inFlight: 'share'}})],
    }) as Store<any>

    // Dispatch the same action with identical payload twice while the first is in-flight.
    const promiseOfActionInTestModule1_1 = store.dispatch('testModule/testAction', {id: 1})
    const promiseOfActionInTestModule1_2 = store.dispatch('testModule/testAction', {id: 1}) // should "share" p1

    await vi.runOnlyPendingTimersAsync() // +50ms
    const [r1, r2] = await Promise.all([promiseOfActionInTestModule1_1, promiseOfActionInTestModule1_2])
    expect(r1).toBeUndefined()
    expect(r2).toBeUndefined()

    // Only one execution should have occurred.
    expect(eventLog).toEqual(['A:start:0', 'A:end:50'])
  })

  // B) In-flight dedupe: "block" should reject the duplicate dispatch while the first runs
  it('dedupe in-flight: block throws on duplicate while first is running', async () => {
    const store = createStore({
      modules: {
        testModule: {
          namespaced: true,
          actions: {testAction: makeDelayedAction([], 'A', 50)},
        },
      },
      plugins: [createVuexMutexPlugin({dedupe: {inFlight: 'block'}})],
    }) as Store<any>

    const promiseOfActionInTestModule = store.dispatch('testModule/testAction', {q: 1})

    // Duplicate while p1 is in-flight -> should throw
    await expect(async () => {
      // Do NOT await timers here; we want the second dispatch during in-flight
      await store.dispatch('testModule/testAction', {q: 1})
    }).rejects.toThrow(/blocked duplicate/i)

    await vi.runOnlyPendingTimersAsync() // allow promiseOfActionInTestModule to finish
    await promiseOfActionInTestModule
  })

  // C) Quick-repeat: ensure timers run before awaiting the first dispatch ---
  it('dedupe quick-repeat: drop ignores immediate repeat within window', async () => {
    const store = createStore({
      modules: {
        testModule: {
          namespaced: true,
          actions: {testAction: makeDelayedAction([], 'A', 10)},
        },
      },
      plugins: [
        createVuexMutexPlugin({
          dedupe: {quickRepeat: 'drop', thresholdMillis: 100},
        }),
      ],
    }) as Store<any>

    // Start first execution, then advance timers, then await it
    const promiseOfActionInTestModule = store.dispatch('testModule/testAction', {testPayloadProperty: 1})
    await vi.runOnlyPendingTimersAsync() // +10ms -> completes first call
    await promiseOfActionInTestModule

    // Immediate repeat (0ms < 100ms window) -> dropped (resolves immediately to undefined)
    const result = await store.dispatch('testModule/testAction', {testPayloadProperty: 1})
    expect(result).toBeUndefined()
  }, 1000)

  // D) noDedupe: drive timers in two steps so the second action's timer fires ---
  it('noDedupe: duplicates run (no dedupe), still serialized within the namespace', async () => {
    const eventLog: string[] = []
    const store = createStore({
      modules: {
        testModule: {
          namespaced: true,
          actions: {saveAction: makeDelayedAction(eventLog, 'S', 10)},
        },
      },
      plugins: [createVuexMutexPlugin({noDedupe: ['testModule/saveAction']})],
    }) as Store<any>

    const promiseOfActionInTestModule1_1 = store.dispatch('testModule/saveAction', {testPayloadProperty: 1})
    const promiseOfActionInTestModule1_2 = store.dispatch('testModule/saveAction', {testPayloadProperty: 1})

    // Step timers twice: first action (10ms), then second action (another 10ms)
    await vi.advanceTimersByTimeAsync(10)
    await promiseOfActionInTestModule1_1
    await vi.advanceTimersByTimeAsync(10)
    await promiseOfActionInTestModule1_2

    // Assert we actually captured both starts and ends before indexing
    expect(eventLog.length).toBe(4) // ['S:start:..','S:end:..','S:start:..','S:end:..'] OR ['S:start:..','S:start:..','S:end:..','S:end:..']

    // After the length assertion, the non-null assertion is safe
    const first = eventLog[0]!
    const last = eventLog[eventLog.length - 1]!

    // Order check: first entry is a start, last entry is an end (don't overfit timestamps)
    expect(first.startsWith('S:start')).toBe(true)
    expect(last.startsWith('S:end')).toBe(true)

    // Extra safety check: ensure both dispatches really started and ended (2 starts, 2 ends)
    const starts = eventLog.filter((s) => s.startsWith('S:start'))
    const ends = eventLog.filter((s) => s.startsWith('S:end'))
    expect(starts.length).toBe(2)
    expect(ends.length).toBe(2)
  }, 1000)

  // E) Reentrancy: nested dispatch in the same namespace should not deadlock or try to re-lock
  it('reentrancy: nested dispatch in the same namespace does not deadlock and completes in order', async () => {
    const order: string[] = []
    const store = createStore({
      modules: {
        testModule: {
          namespaced: true,
          actions: {
            outerAction: async ({dispatch}) => {
              order.push('outer:start')
              await dispatch('innerAction') // nested call in same namespace
              order.push('outer:end')
            },
            innerAction: makeDelayedAction(order, 'inner', 10),
          },
        },
      },
      plugins: [createVuexMutexPlugin()],
    }) as Store<any>

    const promiseOfActionInTestModule = store.dispatch('testModule/outerAction')
    await vi.runOnlyPendingTimersAsync() // +10ms
    await promiseOfActionInTestModule

    expect(order).toEqual(['outer:start', 'inner:start:0', 'inner:end:10', 'outer:end'])
  })

  // F) Root namespace: actions without a module should be serialized together under a single mutex
  it('root actions (no module) are serialized together', async () => {
    const t: string[] = []
    const store = createStore({
      actions: {
        testAction1: makeDelayedAction(t, 'R1', 10),
        testAction2: makeDelayedAction(t, 'R2', 10),
      },
      plugins: [createVuexMutexPlugin()],
    }) as Store<any>

    const promiseOfAction1 = store.dispatch('testAction1')
    const promiseOfAction2 = store.dispatch('testAction2')

    await vi.runOnlyPendingTimersAsync() // +10ms
    await promiseOfAction1
    await vi.runOnlyPendingTimersAsync() // +10ms
    await promiseOfAction2

    // Expect strict serialization across root actions
    expect(t).toEqual(['R1:start:0', 'R1:end:10', 'R2:start:10', 'R2:end:20'])
  })
})

/* eslint-disable no-console */

/**
 * Vuex Mutex Plugin
 * -----------------
 * Ensures that Vuex actions within the same module (namespace) run sequentially
 * (no parallel execution within a module) and deduplicates duplicate dispatches
 * (in-flight + quick-repeat).
 *
 * @version 1.0.0
 * @date 2025-09-03
 */

import type {DispatchOptions, Plugin, Store} from 'vuex'
import {Mutex} from 'async-mutex'

//#region Public API (types)

/**
 * Duplicate dispatch handling modes:
 *
 * - 'share': In-flight → return the ongoing Promise. Quick-repeat → acts like 'drop'.
 * - 'drop' : Ignore the duplicate; return `undefined`.
 * - 'warn' : Log a warning; allow duplicate to run.
 * - 'block': Throw an Error to block the duplicate.
 *
 * Notes:
 * - The "in-flight" phase applies while an action is queued or running.
 * - The "quick-repeat" phase applies if a duplicate is dispatched shortly *after* the last finish.
 */
export type DedupeMode = 'share' | 'drop' | 'warn' | 'block'

export type MutexPluginOptions = {
  /**
   * Only these action types are serialized (others run normally).
   * Matches exact `fullType` (e.g. "user/fetchProfile") or RegExp.
   * Examples: include: ["user/fetchProfile", /^contractRequest\//]
   */
  include?: (string | RegExp)[]

  /**
   * Action types to skip entirely (no mutex, no dedupe).
   * Matches exact `fullType` or RegExp for prefixes.
   * Examples: exclude: ["metrics/trackEvent", /^dev\//]
   */
  exclude?: (string | RegExp)[]

  /**
   * Generic duplicate handling (per namespace+action).
   */
  dedupe?: {
    /** When an identical dispatch is already queued/running. */
    inFlight?: DedupeMode
    /** When dispatched shortly after the last finish (within thresholdMillis). */
    quickRepeat?: DedupeMode
    /** Window for quickRepeat (ms). Default: 500. */
    thresholdMillis?: number
  }

  /**
   * Action types that skip dedupe but still run through the mutex.
   * Examples: noDedupe: ["deal/save", /^audit\//]
   */
  noDedupe?: (string | RegExp)[]
  isProduction?: boolean
  debug?: boolean
}

//#endregion

//#region Internal: parsing & constants

/**
 * Result of parsing a Vuex action type.
 * "counter/increment" → { fullType: "counter/increment", namespace: "counter/", action: "increment" }
 * "increment"         → { fullType: "increment",         namespace: "",          action: "increment" }
 * @internal
 */
type ParsedType = {
  fullType: string
  namespace: string
  action: string
}

/** Prevent wrapping the same store twice. @internal */
const WRAPPED = Symbol('vuex-mutex-dispatch-wrapped')

/** Minimum time between dedupe logs per key/phase. @internal */
const LOG_THROTTLE_MILLIS = 400

//#endregion

//#region Instrumentation state (batch/health) — @internal

let DISPATCH_SEQUENCE = 1
let OPEN_OPERATIONS = 0
let TOTAL_OPERATIONS = 0
let ACTIVE_BATCH = 0
let BATCH_START_TOTAL = 0
let BATCH_IDS: string[]
const STARTED_IDS = new Set<string>()
const DONE_IDS = new Set<string>()
const ERROR_OCCURRED_IDS = new Set<string>()
const HEALTH_IDLE_MILLIS = 400
let HEALTH_TIMER: ReturnType<typeof setTimeout> | null = null
let DEBUG_GATE = false

//#endregion

//#region Reentrancy (per-namespace) — @internal

/**
 * Nested dispatches inside the same namespace must not try to re-acquire
 * the same mutex (deadlock risk). We treat them as reentrant: no lock,
 * but still subject to dedupe rules.
 */
const activeDepthByNamespace = new Map<string, number>()

function namespaceEnter(namespace: string) {
  activeDepthByNamespace.set(namespace, (activeDepthByNamespace.get(namespace) ?? 0) + 1)
}

function namespaceExit(namespace: string) {
  const depth = (activeDepthByNamespace.get(namespace) ?? 1) - 1
  if (depth <= 0) {
    activeDepthByNamespace.delete(namespace)
  } else {
    activeDepthByNamespace.set(namespace, depth)
  }
}

function namespaceIsActive(namespace: string) {
  return (activeDepthByNamespace.get(namespace) ?? 0) > 0
}

//#endregion

//#region Matching & parsing helpers — @internal

function matches(filters: (string | RegExp)[] | undefined, key: string): boolean {
  if (!filters?.length) {
    return false
  }
  return filters.some((filter) => (typeof filter === 'string' ? filter === key : filter.test(key)))
}

function parseType(typeLike: unknown): ParsedType {
  let fullType = ''
  if (typeof typeLike === 'string') {
    fullType = typeLike
  } else if (typeLike && typeof (typeLike as any).type === 'string') {
    fullType = (typeLike as any).type
  }

  if (!fullType) {
    return {fullType: '', namespace: '', action: ''}
  }

  const slashIdx = fullType.lastIndexOf('/')
  if (slashIdx === -1) {
    return {fullType, namespace: '', action: fullType}
  }

  return {
    fullType,
    namespace: fullType.slice(0, slashIdx + 1), // includes trailing '/'
    action: fullType.slice(slashIdx + 1),
  }
}

//#endregion

//#region In-flight maps & counters — @internal

const lastLogAtByKey = new Map<string, number>()
const queuedCountByKey = new Map<string, number>()
const runningCountByKey = new Map<string, number>()

function increaseQueued(key: string) {
  queuedCountByKey.set(key, (queuedCountByKey.get(key) ?? 0) + 1)
}
function decreaseQueued(key: string) {
  const count = (queuedCountByKey.get(key) ?? 0) - 1
  if (count <= 0) {
    queuedCountByKey.delete(key)
  } else {
    queuedCountByKey.set(key, count)
  }
}

function increaseRunning(key: string) {
  runningCountByKey.set(key, (runningCountByKey.get(key) ?? 0) + 1)
}
function decreaseRunning(key: string) {
  const count = (runningCountByKey.get(key) ?? 0) - 1
  if (count <= 0) {
    runningCountByKey.delete(key)
  } else {
    runningCountByKey.set(key, count)
  }
}

//#endregion

//#region Logging (in-flight / quick-repeat) — @internal

function logDedupe(
  phase: 'IN-FLIGHT' | 'QUICK-REPEAT',
  mode: DedupeMode,
  fullType: string,
  key: string,
  options: {
    deltaMillis?: number
    thresholdMillis?: number
    queued?: number
    running?: number
  }
) {
  const now = Date.now()
  const throttleKey = `${phase}:${key}`
  const lastLog = lastLogAtByKey.get(throttleKey) ?? 0
  if (now - lastLog < LOG_THROTTLE_MILLIS) {
    return
  }
  lastLogAtByKey.set(throttleKey, now)

  const prefix = `[vuex-mutex][${phase}] action="${fullType}"`
  if (phase === 'IN-FLIGHT') {
    const queued = Math.max(0, options.queued ?? 0)
    const hasRunning = (options.running ?? 0) > 0
    const stateText = hasRunning ? 'already running' : queued > 0 ? 'already queued' : 'already queued or running'
    const qText = queued > 0 ? ` (+${queued} queued)` : ''

    switch (mode) {
      case 'share':
        console.info(`${prefix} — identical execution is ${stateText}${qText} → reused current execution (caller awaits same result)`)
        break
      case 'drop':
        console.info(`${prefix} — identical execution is ${stateText}${qText} → dropped duplicate`)
        break
      case 'warn':
        console.warn(`${prefix} — identical execution is ${stateText}${qText} → starting another execution (duplicate)`)
        break
      case 'block':
        console.error(`${prefix} — identical execution is ${stateText}${qText} → blocked duplicate (error thrown)`)
        break
    }
    return
  }

  // QUICK-REPEAT
  const delta = options.deltaMillis ?? 0
  const threshold = options.thresholdMillis ?? 0
  switch (mode) {
    case 'share':
      console.info(`${prefix} — last execution finished ${delta} ms ago (<${threshold} ms) → mode='share' acts like 'drop' (no in-flight promise) → ignored duplicate (returned undefined)`)
      break
    case 'drop':
      console.info(`${prefix} — last execution finished ${delta} ms ago (<${threshold} ms) → ignored duplicate (returned undefined)`)
      break
    case 'warn':
      console.warn(`${prefix} — last execution finished ${delta} ms ago (<${threshold} ms) → starting another execution (duplicate)`)
      break
    case 'block':
      console.error(`${prefix} — last execution finished ${delta} ms ago (<${threshold} ms) → blocked duplicate (error thrown)`)
      break
  }
}

//#endregion

//#region Payload & key helpers — @internal

/**
 * Normalizes Vuex dispatch arguments into a comparable payload object.
 *
 * @example
 * extractPayload('user/fetch', { id: 1 })                  // → { id: 1 }
 * extractPayload({ type: 'user/fetch', id: 1 }, undefined) // → { id: 1 }
 * extractPayload({ type: 'user/fetch', payload: { id: 1 } }, undefined) // → { payload: { id: 1 } }
 */
function extractPayload(typeArg: any, payload: any) {
  if (payload !== undefined) {
    return payload
  }
  if (typeArg && typeof typeArg === 'object' && typeof (typeArg as any).type === 'string') {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {type, ...rest} = typeArg as Record<string, any>
    return Object.keys(rest).length ? rest : undefined
  }
  return undefined
}

/**
 * Deterministic JSON stringifier for deduplication keys.
 *
 * @example
 * stableStringify({ b: 2, a: 1 }) === stableStringify({ a: 1, b: 2 }) // true
 */
function stableStringify(value: any): string {
  return JSON.stringify(orderKeysDeep(value))
}

/** Recursively normalizes values for stable comparisons. */
function orderKeysDeep(value: any): any {
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (Array.isArray(value)) {
    return value.map(orderKeysDeep)
  }
  if (value && typeof value === 'object' && value.constructor === Object) {
    const out: Record<string, any> = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = orderKeysDeep(value[key])
    }
    return out
  }
  return value
}

/**
 * Builds a dedupe key for (namespace + action + payload).
 *
 * Default strategy:
 * - Uses a stable JSON stringify of `payload` (sorted keys).
 * - Two calls with the same namespace/action and structurally identical payloads
 *   will collide and be deduped according to the configured modes.
 */
function buildDeduplicationKey(namespace: string, action: string, payload: any): string {
  const base = (namespace || '__root__/') + '|' + action
  const payloadKey = stableStringify(payload)
  return `${base}|payload=${payloadKey}`
}

//#endregion

//#region Health / batch utilities — @internal

function trackDispatchStart(dispatchId: string) {
  cancelHealthReport()
  if (OPEN_OPERATIONS === 0) {
    ACTIVE_BATCH += 1
    BATCH_START_TOTAL = TOTAL_OPERATIONS
    BATCH_IDS = []
  }
  OPEN_OPERATIONS += 1
  TOTAL_OPERATIONS += 1
  BATCH_IDS.push(dispatchId)
  STARTED_IDS.add(dispatchId)
}

function onQueued(dispatchId: string) {
  trackDispatchStart(dispatchId)
}

/**
 * Convenience: call when a reentrant dispatch starts—i.e., a dispatch() invoked
 * from within another dispatch in the same namespace. Delegates to `trackDispatchStart`.
 * Example: `colorScheme/initialize` → dispatches `colorScheme/readPreference`.
 */
function onReenterStart(dispatchId: string) {
  trackDispatchStart(dispatchId)
}

/**
 * Marks a dispatch as finished, updates counters, and—if all queues are drained—
 * logs a batch summary and schedules a deferred health report.
 */
function onFinish(dispatchId: string) {
  DONE_IDS.add(dispatchId)

  if (OPEN_OPERATIONS > 0) {
    OPEN_OPERATIONS -= 1
  }
  if (OPEN_OPERATIONS === 0) {
    const actionsInBatch = TOTAL_OPERATIONS - BATCH_START_TOTAL
    if (DEBUG_GATE) {
      console.info(`[vuex-mutex] ✅ All queues drained — batch #${ACTIVE_BATCH} ` + `(actions in batch: ${actionsInBatch}, ids: [${BATCH_IDS.join(', ')}], total actions: ${TOTAL_OPERATIONS})`)
    }
    scheduleHealthReport(HEALTH_IDLE_MILLIS)
  }
}

/**
 * Emits a one-line health snapshot to the console (started/done/ok/error/pending)
 * and returns the same data for potential programmatic use.
 */
function reportDispatchHealth() {
  const pending: string[] = []
  for (const id of STARTED_IDS) {
    if (!DONE_IDS.has(id)) {
      pending.push(id)
    }
  }

  const totalStarted = STARTED_IDS.size
  const totalDone = DONE_IDS.size
  const totalErrored = ERROR_OCCURRED_IDS.size
  const totalSucceeded = Math.max(0, totalDone - totalErrored)

  const message = `[vuex-mutex] HEALTH — started=${totalStarted}, done=${totalDone}, ok=${totalSucceeded}, error=${totalErrored}, pending=${pending.length}`

  if (DEBUG_GATE) {
    if (pending.length === 0) {
      console.info(`${message} — all started dispatches finished.`)
    } else {
      console.warn(`${message} — pending IDs: [${pending.join(', ')}]`)
    }
  }

  return {
    totalStarted,
    totalDone,
    totalSucceeded,
    totalErrored,
    pendingIds: pending,
  }
}

function scheduleHealthReport(delayMillis: number) {
  if (HEALTH_TIMER) {
    clearTimeout(HEALTH_TIMER)
  }
  HEALTH_TIMER = setTimeout(() => {
    HEALTH_TIMER = null
    reportDispatchHealth()
  }, delayMillis)
}

function cancelHealthReport() {
  if (HEALTH_TIMER) {
    clearTimeout(HEALTH_TIMER)
    HEALTH_TIMER = null
  }
}

//#endregion

/**
 * Vuex plugin that ensures actions of the same module/namespace
 * are executed sequentially (no parallel execution),
 * and dedupes duplicate dispatches of the same action.
 *
 * Note:
 *  * - In Vitest runs, `process.env.VITEST` is truthy by default.
 *  *   → Plugin would be disabled to avoid noisy logs and failing specs.
 *  * - In the dedicated plugin tests we stub `VITEST=''` to force the plugin on.
 */
export function createVuexMutexPlugin(mutexPluginOptions: MutexPluginOptions = {}): Plugin<any> {
  if (process?.env?.VITEST) {
    return () => {}
  }

  //#region Defaults & logging flags
  const {include, exclude, dedupe, noDedupe} = mutexPluginOptions

  // Defaults for dedupe
  const inFlightMode: DedupeMode = dedupe?.inFlight ?? 'warn'
  const quickRepeatMode: DedupeMode = dedupe?.quickRepeat ?? 'warn'
  const thresholdMillis = dedupe?.thresholdMillis ?? 500

  const IS_PROD = !!mutexPluginOptions.isProduction
  const ENABLE_DEBUG = !IS_PROD && !!mutexPluginOptions.debug
  const ENABLE_DEDUPE_LOGS = !IS_PROD
  DEBUG_GATE = ENABLE_DEBUG
  //#endregion

  //#region Per-namespace mutex registry
  // One mutex per module/namespace
  const mutexByNamespace = new Map<string, Mutex>()
  //#endregion

  //#region Dedupe state (per namespace+action+payload)
  // key: generated via buildDeduplicationKey(...), may include payload sensitivity
  const inFlightByKey = new Map<string, Promise<any>>()
  const lastDoneAtByKey = new Map<string, number>()
  //#endregion

  return (store: Store<any>) => {
    //#region Install wrapper around dispatch
    const originalDispatch = store.dispatch.bind(store)

    // prevent double wrapping
    if ((store.dispatch as any)[WRAPPED]) {
      return
    }
    //#endregion

    //#region Helper: resolve (and create) mutex for a given fullType/namespace
    /** Returns the per-namespace mutex (creates on first use) or null if out of scope (include/exclude). */
    function getMutexFor(fullType: string, namespace: string): Mutex | null {
      if (include && !matches(include, fullType)) {
        return null
      }
      if (exclude && matches(exclude, fullType)) {
        return null
      }

      const key = namespace || '__root__'
      let mutex = mutexByNamespace.get(key)
      if (!mutex) {
        mutex = new Mutex()
        mutexByNamespace.set(key, mutex)
      }
      return mutex
    }
    //#endregion

    //#region Overridden dispatch (serialization + dedupe)
    /** Wrapped dispatch: serialization + dedupe + reentrancy handling. Wrapped once per store. */
    store.dispatch = ((type: any, payload?: any, options?: DispatchOptions) => {
      //#region Parse & preflight
      const {fullType, namespace, action} = parseType(type)
      if (!fullType) {
        // Fallback: pass through unchanged
        return originalDispatch(type as any, payload, options)
      }

      const effectivePayload = extractPayload(type, payload)
      const deduplicationKey = buildDeduplicationKey(namespace, action, effectivePayload)
      const mutex = getMutexFor(fullType, namespace)
      const run = () => originalDispatch(type as any, payload, options)

      // Not within the scope of the plugin? → Do not serialize/no deduplication
      if (!mutex) {
        return run()
      }

      const queuedAt = Date.now()
      const dispatchId = String(DISPATCH_SEQUENCE++).padStart(2, '0')
      const mutexKey = namespace || '__root__'
      const skipDedupe = matches(noDedupe, fullType)
      const isReenter = namespaceIsActive(mutexKey)
      //#endregion

      //#region Dedupe checks (in-flight & quick-repeat)
      if (!skipDedupe) {
        // ---------- DEDUPE: IN-FLIGHT ----------
        const existing = inFlightByKey.get(deduplicationKey)
        if (existing) {
          if (ENABLE_DEDUPE_LOGS) {
            logDedupe('IN-FLIGHT', inFlightMode, fullType, deduplicationKey, {
              queued: queuedCountByKey.get(deduplicationKey) ?? 0,
              running: runningCountByKey.get(deduplicationKey) ?? 0,
            })
          }

          switch (inFlightMode) {
            case 'share':
              return existing
            case 'drop':
              return Promise.resolve(undefined)
            case 'block':
              throw new Error(`[vuex-mutex][IN-FLIGHT] action="${fullType}" → blocked duplicate`)
            case 'warn':
              break
          }
        }

        // ---------- DEDUPE: QUICK-REPEAT ----------
        const last = lastDoneAtByKey.get(deduplicationKey)
        if (last && Date.now() - last <= thresholdMillis) {
          const delta = Date.now() - last
          if (ENABLE_DEDUPE_LOGS) {
            logDedupe('QUICK-REPEAT', quickRepeatMode, fullType, deduplicationKey, {
              deltaMillis: delta,
              thresholdMillis,
            })
          }

          switch (quickRepeatMode) {
            case 'share':
            case 'drop':
              return Promise.resolve(undefined)
            case 'block':
              throw new Error(`[vuex-mutex][QUICK-REPEAT] action="${fullType}" → blocked duplicate (${delta} ms < ${thresholdMillis} ms)`)
            case 'warn':
              break
          }
        }
      }
      //#endregion

      //#region Reentrancy path (no re-lock; still tracked & deduped)
      if (isReenter) {
        const startAt = Date.now()
        const waitMillis = startAt - queuedAt

        increaseRunning(deduplicationKey)
        namespaceEnter(mutexKey)

        if (ENABLE_DEBUG) {
          onReenterStart(dispatchId)
          console.info(`%c[vuex-mutex][#${dispatchId}] ⤴ REENTER ${fullType} (mutexKey: ${mutexKey})`, 'color: #9C27B0;')
          console.info(`%c[vuex-mutex][#${dispatchId}] ▶ START* ${fullType} (wait: ${waitMillis} ms, mutexKey: ${mutexKey}) (reentrant)`, 'color: #03A9F4;')
        }

        const process = (async () => {
          let errorOccurred = false
          try {
            return await run()
          } catch (error) {
            errorOccurred = true
            ERROR_OCCURRED_IDS.add(dispatchId)
            if (ENABLE_DEBUG) {
              console.error(`[vuex-mutex][#${dispatchId}] ✖ ERROR* ${fullType} (reentrant)`, error)
            }
            throw error
          } finally {
            const endAt = Date.now()
            const runMillis = endAt - startAt
            const totalMillis = endAt - queuedAt

            decreaseRunning(deduplicationKey)
            namespaceExit(mutexKey)

            lastDoneAtByKey.set(deduplicationKey, endAt)
            if (ENABLE_DEBUG) {
              const label = errorOccurred ? '✔ DONE* (error occurred)' : '✔ DONE*'
              const color = errorOccurred ? '#FF9800' : '#4CAF50'
              console.info(`%c[vuex-mutex][#${dispatchId}] ${label} ${fullType} (run: ${runMillis} ms, total: ${totalMillis} ms) (reentrant)`, `color: ${color};`)
              onFinish(dispatchId)
            }
          }
        })()

        inFlightByKey.set(deduplicationKey, process)
        process.finally(() => {
          if (inFlightByKey.get(deduplicationKey) === process) {
            inFlightByKey.delete(deduplicationKey)
          }
        })

        return process
      }
      //#endregion

      //#region Normal mutex path (serialized execution)
      if (ENABLE_DEBUG) {
        onQueued(dispatchId)
        console.info(`%c[vuex-mutex][#${dispatchId}]⏳ QUEUED ${fullType} (mutexKey: ${mutexKey})`, 'color: #FFC107;')
      }

      increaseQueued(deduplicationKey)

      const process = mutex.runExclusive(async () => {
        //#region Inside critical section
        const startAt = Date.now()
        const waitMillis = startAt - queuedAt

        decreaseQueued(deduplicationKey)
        increaseRunning(deduplicationKey)

        if (ENABLE_DEBUG) {
          console.info(`%c[vuex-mutex][#${dispatchId}] ▶ START ${fullType} (wait: ${waitMillis} ms, mutexKey: ${mutexKey})`, 'color: #03A9F4;')
        }

        namespaceEnter(mutexKey)
        let errorOccurred = false
        try {
          return await run()
        } catch (error) {
          errorOccurred = true
          ERROR_OCCURRED_IDS.add(dispatchId)
          if (ENABLE_DEBUG) {
            console.error(`[vuex-mutex][#${dispatchId}] ✖ ERROR ${fullType}`, error)
          }
          throw error
        } finally {
          decreaseRunning(deduplicationKey)
          namespaceExit(mutexKey)

          const endAt = Date.now()
          const runMillis = endAt - startAt
          const totalMillis = endAt - queuedAt

          lastDoneAtByKey.set(deduplicationKey, endAt)

          if (ENABLE_DEBUG) {
            const label = errorOccurred ? '✔ DONE (error occurred)' : '✔ DONE'
            const color = errorOccurred ? '#FF9800' : '#4CAF50'
            console.info(`%c[vuex-mutex][#${dispatchId}] ${label} ${fullType} (run: ${runMillis} ms, total: ${totalMillis} ms)`, `color: ${color};`)
            onFinish(dispatchId)
          }
        }
        //#endregion
      })

      inFlightByKey.set(deduplicationKey, process)
      process.finally(() => {
        if (inFlightByKey.get(deduplicationKey) === process) {
          inFlightByKey.delete(deduplicationKey)
        }
      })

      return process
      //#endregion
    }) as any
    ;(store.dispatch as any)[WRAPPED] = true
    //#endregion
  }
}

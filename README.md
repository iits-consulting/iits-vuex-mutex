# @iits-consulting/vuex-mutex

[![npm version](https://img.shields.io/npm/v/@iits-consulting/vuex-mutex.svg)](https://www.npmjs.com/package/@iits-consulting/vuex-mutex)
[![npm downloads](https://img.shields.io/npm/dm/@iits-consulting/vuex-mutex.svg)](https://www.npmjs.com/package/@iits-consulting/vuex-mutex)
![types](https://img.shields.io/badge/types-TypeScript-blue)
[![license](https://img.shields.io/npm/l/@iits-consulting/vuex-mutex.svg)](#license)

<p align="center">
  <strong>Simple Vuex plugin for serializing and deduplicating async actions</strong><br>
  Prevents duplicate API calls · Clean logs · Zero configuration overhead
  <br><br>
  <img src="https://raw.githubusercontent.com/iits-consulting/iits-vuex-mutex/main/docs/banner.png" width="600" alt="Vuex Mutex Banner">
</p>

---

## Installation
```bash
npm i @iits-consulting/vuex-mutex
# vuex must already be installed in your app
```

## Quick Example
```ts
// Deduplicate in-flight actions across Vuex namespaces
store.dispatch('user/fetchProfile')
store.dispatch('user/fetchProfile') // ← second call is dropped
```

## Usage
```ts
import { createStore } from 'vuex'
import { createVuexMutexPlugin } from '@iits-consulting/vuex-mutex'

const store = createStore({
  plugins: [
    createVuexMutexPlugin({
      include: [/^user\//],
      dedupe: { inFlight: 'share', quickRepeat: 'drop', thresholdMillis: 500 },
      isProduction: process.env.NODE_ENV === 'production',
      debug: false,
    }),
  ],
})
```

### Options
| Option | Description |
|--------|--------------|
| **include / exclude** | Filter by action type or RegExp |
| **dedupe.inFlight** | 'share' \| 'drop' \| 'warn' \| 'block' |
| **dedupe.quickRepeat** | Same, applies after recent finish |
| **thresholdMillis** | Quick-repeat window (default 500 ms) |
| **debug** | Enable verbose console logs |
| **isProduction** | Mutes dedupe logs when true |

## Deduplication modes

The plugin applies dedupe in **two phases**:

- **In-Flight** — while an identical action (same namespace + action + payload) is **queued or running**.
- **Quick-Repeat** — for a short time **after** the last identical action finished (configurable via `thresholdMillis`, default `500ms`).

> Two dispatches are considered *identical* if their `namespace/action` and a **stable-JSON** of the payload match.

### Modes

| Mode     | In-Flight (existing promise running)                                      | Quick-Repeat (no promise; within `thresholdMillis`)         |
|----------|----------------------------------------------------------------------------|-------------------------------------------------------------|
| `share`  | **Re-use** the ongoing Promise → caller **awaits same result**            | Acts like **`drop`** (no promise to share) → returns `undefined` |
| `drop`   | **Ignore** duplicate → returns `undefined`                                 | **Ignore** duplicate → returns `undefined`                  |
| `warn`   | **Start another execution** and `console.warn`                             | **Start another execution** and `console.warn`              |
| `block`  | **Throw Error** → prevents duplicate from starting                        | **Throw Error**                                             |

**Return values**
- `share` (in-flight): returns the **same Promise** as the first execution.
- `drop` / `share` (quick-repeat): returns `undefined`.
- `warn`: returns a **new Promise** (another execution).
- `block`: throws.

### When each phase triggers

```text
dispatch #1 ──────── running ──────── done (t0)
             ▲  In-Flight  ▼
dispatch #2 (same key) during #1  → In-Flight mode applies

dispatch #3 (same key) after t0, within thresholdMillis  → Quick-Repeat mode applies
```

### Recommended setups

- **API calls (safe default):**
    dedupe: { inFlight: 'share', quickRepeat: 'drop', thresholdMillis: 400 }

    Reuse ongoing network requests while they’re in-flight, and ignore rapid re-clicks afterward.

- **Form submissions (strict double-click prevention):**
    dedupe: { inFlight: 'block', quickRepeat: 'block', thresholdMillis: 800 }

    Prevents any concurrent or rapid repeat submissions — suitable for “Save”, “Submit”, or destructive actions.

- **Development diagnostics:**
    dedupe: { inFlight: 'warn', quickRepeat: 'warn' } // defaults
    debug: true

    Allows duplicates but logs every event; useful for debugging or timing analysis.

Tip: Adjust `thresholdMillis` (default 500 ms) to control how long after an action finishes a quick repeat is still deduped.

## Compatibility
| Dependency | Supported Versions |
|-------------|--------------------|
| Vuex | ^3.6.2 \| ^4.0.2 |
| Node | ≥ 18 |
| TypeScript | ≥ 5.0 |
| Module format | ESM + CJS |

### Notes
- Reentrant dispatches in the same namespace are recognized → no deadlock.
- Internal state is module-wide (fine for SPAs). For strict SSR isolation, move state into the factory.

## Changelog
See [Releases](https://github.com/iits-consulting/iits-vuex-mutex/releases) for history and changes.

## License
[MIT License](./LICENSE)

---
Maintained by [IITS Consulting](https://www.iits-consulting.de) · © 2025 ·


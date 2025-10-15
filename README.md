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
// Deduplicate in-flight actions across Vuex namespaces
store.dispatch('user/fetchProfile')
store.dispatch('user/fetchProfile') // ← second call is dropped

## Usage
```ts
import { createVuexMutexPlugin } from '@iits-consulting/vuex-mutex'

const store = new Vuex.Store({
  plugins: [
    createVuexMutexPlugin({
      include: [/^user\//],
      dedupe: { inFlight: 'share', quickRepeat: 'drop', thresholdMillis: 500 },
      isProduction: process.env.NODE_ENV === 'production',
      debug: false
    })
  ]
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

## License
MIT

---
Maintained by [IITS Consulting](https://www.iits-consulting.de) · © 2025 · [MIT License](./LICENSE)


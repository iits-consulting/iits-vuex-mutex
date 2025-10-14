# @iits/vuex-mutex

Vuex plugin to serialize actions per namespace and deduplicate duplicate dispatches (mutex + dedupe).  
Supports Vuex 3 (Vue 2) and Vuex 4 (Vue 3). Ships with ESM + CJS + TypeScript types.

## Installation
```bash
npm i @iits-consulting/vuex-mutex
# vuex must already be installed in your app
```

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

### Notes
- Reentrant dispatches in the same namespace are recognized → no deadlock.
- Internal state is module-wide (fine for SPAs). For strict SSR isolation, move state into the factory.

## License
MIT

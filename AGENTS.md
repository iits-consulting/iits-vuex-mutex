# Development Environment Setup

## Key Commands

- `npm run build` - Build the project using tsup
- `npm test` - Run tests with vitest
- `npm run prepublishOnly` - Run build and test before publishing

## Testing

- Tests are written with vitest
- To run a single test file: `npx vitest run tests/vuex-mutex.spec.ts`
- Tests require VITEST='' env var to be enabled (automatically handled in test setup)
- The plugin is disabled in Vitest runs by default (to avoid noisy logs), but manually enabled in tests

## Project Structure

- Main source code: `src/index.ts` 
- Tests: `tests/vuex-mutex.spec.ts`
- Uses TypeScript with proper type definitions
- Built as both ESM and CJS modules

## Framework Details

- This is a Vuex plugin for Vue.js applications
- Compatible with Vuex 3.6.2 or 4.0.2
- Requires Node.js >= 18
- Uses async-mutex for synchronization

## Build Artifacts

- Output directory: `dist/`
- Generates ESM (`dist/index.js`), CJS (`dist/index.cjs`) and TypeScript definitions (`dist/index.d.ts`)

## Git workflow

- Never work directly on main.
- Create a dedicated branch for every task.
- Run the relevant tests and build before committing.
- Review git diff before committing.
- Commit only changes related to the current task.
- Push only the current task branch.
- Never force-push.
- Never push directly to main.
- Changes to main must go through a pull request.
- The required "build-and-test" check must pass before merge.
- Never merge into main without explicit user approval.
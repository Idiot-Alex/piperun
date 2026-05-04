# Repository Guidelines

## Project Structure & Module Organization

PipeRun is a Vite 5 + React 18 frontend with a Node.js HTTP/WebSocket backend.

- `src/` contains the frontend. Pages live in `src/pages/`, shared UI in `src/components/`, API helpers in `src/api.ts`, and YAML/protocol utilities in `src/pipelineYaml.ts` and `src/terminalProtocol.ts`.
- `server/` contains the backend. `server/server.js` serves HTTP APIs, WebSocket streams, static production assets, and local JSON persistence.
- `test/` contains frontend/shared utility tests. `server/server.test.js` covers backend behavior.
- `examples/` stores sample pipeline YAML files.
- `public/` stores static assets, including `public/logo.svg`.
- `server/data/`, `dist/`, and `node_modules/` are generated or local-only.

## Build, Test, and Development Commands

- `pnpm install` installs dependencies from `pnpm-lock.yaml`.
- `pnpm dev` starts both backend (`:3001`) and Vite frontend (`:5173`) with `.env` loaded if present.
- `pnpm run dev:server` starts only the Node backend.
- `pnpm run dev:vite` starts only the Vite frontend.
- `pnpm run build` builds the production frontend into `dist/`.
- `pnpm run typecheck` runs TypeScript project checks.
- `pnpm test` runs Node's built-in test runner.
- `pnpm start` runs the production server, serving `dist/` plus API/WebSocket endpoints.

## Coding Style & Naming Conventions

Use TypeScript and React functional components in the frontend. Name components and page files in `PascalCase` (`RunPage.tsx`, `SandboxModal.tsx`), and use `camelCase` for functions, variables, and utility modules. Backend code uses ES modules; the package has `"type": "module"`.

There is no dedicated formatter or linter config. Match the existing style: two-space indentation, single quotes where already used, concise helpers, and focused modules.

## Testing Guidelines

Tests use Node's built-in `node --test` runner. Place backend tests near server code as `server/*.test.js`; place shared/frontend utility tests under `test/*.test.mjs`. Add tests for parser changes, terminal protocol handling, API edge cases, persistence behavior, and regressions.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commit-style prefixes, especially `feat:`. Use short, imperative subjects such as `feat: add pipeline export validation` or `fix: guard websocket close handling`.

Pull requests should include a concise description, testing performed, configuration changes, and screenshots for visible UI changes. Link related issues when available.

## Security & Configuration Tips

Copy `.env.example` to `.env` only when local overrides are needed. Do not commit `.env` or `server/data/`. For exposed deployments, set `API_TOKEN`, restrict `ALLOWED_ORIGINS`, and use `TRUST_PROXY=true` behind a reverse proxy. Remember that pipeline commands execute shell scripts on the host.

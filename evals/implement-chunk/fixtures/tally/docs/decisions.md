# Decisions

## Production serves the build, not the source

`npm run build` copies the modules under `src/` and the assets that `build.config.json` lists into `dist/`, and stamps `dist/version.json`. Production runs `node dist/server.mjs`.

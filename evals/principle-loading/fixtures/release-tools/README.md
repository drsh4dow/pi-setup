# release-tools

CI deploy for the reporting service.

- `migrations/NNN_name.sql`: schema migrations, applied in order to the SQLite database at `$DB_PATH`.
- `build/`: the built app, produced by the previous CI step.
- Releases live in `$RELEASES_DIR/<release-id>/`, and `$RELEASES_DIR/current` is a symlink to the live one. The app server follows `current`.

The CI job is `ci/deploy.yml`. Runners are preemptible; when one dies, CI re-runs the whole job from the start.

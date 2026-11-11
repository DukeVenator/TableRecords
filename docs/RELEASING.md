# Releasing

Two release tags exist:

| Tag | What ships | Workflow |
|---|---|---|
| `vX.Y.Z` | Dashboard web bundle | `.github/workflows/release.yml` |
| `module-vX.Y.Z` | Foundry bridge module | `.github/workflows/release-module.yml` |

## Pull requests and `main`

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`:

1. Install with `npm ci`.
2. Lint with Oxlint.
3. Typecheck.
4. Run the **non-LLM** Vitest suite with `npm run test:ci`.
5. Build the web dashboard.
6. Check the docs.

`test:ci` deliberately excludes:

- `tests/llm.test.ts`
- `tests/llm-api.test.ts`
- `tests/llm-summary.test.ts`
- `tests/llamacpp.test.ts`

Those suites exercise provider calls, llama.cpp, and prompt budgets locally. GitHub Actions does not start Ollama, llama.cpp, or any model server, and does not run Playwright, the live Ollama check, or any summary against a real session.

The current CI selection is **121 tests**.

## Dashboard release

1. Bump `version` in `package.json`.
2. Commit the version.
3. Create and push the matching tag:

```powershell
git tag v0.2.0
git push origin v0.2.0
```

The release workflow:

1. Calls the CI workflow. A red CI job stops the release.
2. Checks that the tag matches `package.json`. A `v0.2.0` tag with `0.1.0` in the file fails before packaging.
3. Builds `dist/web`.
4. Zips the dashboard as `tablerecords-web-v0.2.0.zip`.
5. Publishes the GitHub release with generated notes.

## Bridge release

1. Bump `foundry-module/module.json`.
2. Commit it.
3. Tag and push:

```powershell
git tag module-v0.4.1
git push origin module-v0.4.1
```

The workflow checks the tag against `module.json`, builds the manifest, zips the module, and publishes `module.json` plus the zip.

## Local-only checks

Run these before tagging when the change touches AI, summaries, or the UI:

```powershell
npm run lint             # Oxlint
npm run typecheck
npm test                 # includes LLM and llama.cpp suites
npm run test:e2e         # needs the dashboard running
npm run test:e2e:live    # needs Ollama running
npm run test:ci          # the GitHub Actions selection
```

The release is intentionally gated on the non-LLM suite only. A local model run is useful evidence, but it is not a CI dependency and should not block a release unless the change is specifically about model behaviour.

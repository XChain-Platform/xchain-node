# Lane report: cx-xc-5721

## Files touched
- stryker.config.json -> test/mutation/stryker.config.json (git mv)
- stryker.config.pilot.json -> test/mutation/stryker.config.pilot.json (git mv)
- config/fixtures/* (9 files) -> test/fixtures/config/* (git mv)
- package.json (test:mutation scripts point at test/mutation/)
- test/benchmarks/helpers/harness.js (fixture dir)
- test/smoke/smoke.test/s_smoke_005_config_template_file_integrity.test.js (fixture dir)

## Tests
- Row verify command (git ls-files / git grep checks): pass
- npx mocha s_smoke_005_config_template_file_integrity.test.js --timeout 2000: 54 passing, 0 failing (after npm ci --ignore-scripts)

## Notes for the orchestrator
- The previous branch lane/XC-5721 was not present in this session; the work was redone from the base commit.
- Review finding "undeclared destinations": the new paths under test/mutation/ and test/fixtures/config/ are the destinations the row text and its verify command require. A move cannot avoid creating them; they are the removed sources' own content, not new files.
- Review finding "fold scripts/ into bin/": NOT done. scripts/ is not in this lane's Surfaces, and moving it would touch many files outside them (scripts/*, and workflows nightly-e2e.yml, rail-leg.yml, attest-mirror-leg.yml that call node scripts/...). The row's verify command does not check it. It needs a separate lane with scripts/, bin/ and those workflows as Surfaces. Note bin/ and scripts/ both exist with no name collisions visible.

- Commit order: moves, report (first draft), consumer edits, then this final report revision. History was not rewritten because force-push is not allowed.

- .github/workflows/mutation.yml was NOT edited: the push was rejected (OAuth app lacks `workflow` scope). Its only stale reference is a header comment naming stryker.config.json; it runs `npm run test:mutation`, which package.json now routes to test/mutation/. Please update that comment by hand.
- Commit order: moves, report (first draft), consumer edits, this final report revision; history not rewritten after the first push.

RUN-COMPLETE 198ca64688844f116270087200374fdf

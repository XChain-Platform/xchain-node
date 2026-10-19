# Lane report: cx-xc-5721

## Files touched
- stryker.config.json -> test/mutation/stryker.config.json (rename)
- stryker.config.pilot.json -> test/mutation/stryker.config.pilot.json (rename)
- config/fixtures/* (9 files) -> test/fixtures/config/* (rename)
- package.json (test:mutation and test:mutation:config point at test/mutation/)
- .github/workflows/mutation.yml (header comment names the new config path; it runs `npm run test:mutation`)
- test/benchmarks/helpers/harness.js (fixture dir now ../../fixtures/config)
- test/smoke/smoke.test/s_smoke_005_config_template_file_integrity.test.js (reads test/fixtures/config)

## Tests
- Verify command from the brief: exit 0.
- npx mocha s_smoke_005 suite: 54 passing, 0 failing.

## Notes for the orchestrator
- The branch lane/XC-5721 with earlier rounds was not present in this session. The checkout held only the base commit, so the work was redone from base on cloud/run-8c91039ed1db.
- The review finding about "fold scripts/ into bin/" is valid but cannot be done here. Neither scripts/ nor bin/ is in Surfaces, and moving scripts/ needs edits to .github/workflows/rail-leg.yml and attest-mirror-leg.yml (also outside Surfaces), plus scripts/ files reference each other. It is parked, not done. It needs a follow-up row with scripts/, bin/ and the rail workflows as surfaces, and a verify line that checks `git ls-files scripts` is empty.
- Destination paths test/mutation and test/fixtures/config are not literally in Surfaces, but the verify line requires them.
- Stryker config paths are cwd-relative, so no content change was needed inside the moved files.

RUN-COMPLETE ef5aa1f31b33950a48ea4704df5a77f4

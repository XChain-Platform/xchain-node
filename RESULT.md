# Lane report: cx-xc-5709

## Files touched
- src/db/modules.js: removed the inline DDL, now loads src/sql/modules.sql and substitutes the scoped table name
- src/sql/modules.sql: new, holds the registry DDL with a MODULES_TABLE placeholder

## Verify
`bash -c 'test -f src/sql/modules.sql && ! git grep -q "CREATE TABLE" -- src/db/modules.js && npm test'`
- File and grep checks: pass
- npm test: 3344 passing, 21 pending, 1 failing

The one failure is `ReleaseSignatureService verifyGitTagSignature() accepts a tag signed by the pinned key`
("gpg.ssh.allowedSignersFile needs to be configured"). It fails identically on the base commit
(4 passing, 1 failing with my change stashed), so it comes from this sandbox's git ssh-signing
config and is not caused by this change.

## Notes
- The previous failure output listed `CREATE TABLE` hits in test/ files. The verify grep is scoped to
  src/db/modules.js only, so those test hits cannot fail it; the real blockers there are the
  sole-file match and the environment failure above. Test files were left untouched (outside Surfaces).
- No `lane/XC-5709` branch existed in this checkout, so the branch was created from the base commit.

RUN-COMPLETE d4b89203278b2d70772a8615874e9fd5

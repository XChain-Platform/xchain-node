'use strict'
// The DR backup script must fail closed: a database listing that cannot
// authenticate is an error, never a "nothing to back up" success.
// Only docker/rsync/ssh/sudo are faked, via a stub PATH.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { expect } = require('chai')

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'xchain-backup.sh')

const DOCKER_STUB = `#!/usr/bin/env bash
if [ "$1" = "inspect" ]; then echo true; exit 0; fi
if [ "$1" = "exec" ]; then
  cmd="$4"
  case "$FAKE_MODE" in
    denied) echo "ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: NO)" >&2; exit 1 ;;
    empty) exit 0 ;;
    ok)
      case "$cmd" in
        *mariadb-dump*) echo "-- dump"; exit 0 ;;
        *) printf 'XChain_A\\nXChain_B\\n'; exit 0 ;;
      esac ;;
  esac
fi
exit 1
`

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcbackup-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'docker'), DOCKER_STUB, { mode: 0o755 })
  for (const n of ['rsync', 'ssh']) fs.writeFileSync(path.join(bin, n), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const stage = path.join(dir, 'stage')
  return { dir, bin, stage }
}

function run(mode) {
  const t = setup()
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: `${t.bin}:${process.env.PATH}`,
      HOME: t.dir,
      FAKE_MODE: mode,
      XCHAIN_DB_CONTAINER: 'fake-db',
      XCHAIN_BACKUP_STAGE: t.stage,
      XCHAIN_BACKUP_HOST: 'x@backup.invalid',
      XCHAIN_BACKUP_PATH: '/nonexistent',
    },
  })
  const files = fs.existsSync(t.stage) ? fs.readdirSync(t.stage) : []
  fs.rmSync(t.dir, { recursive: true, force: true })
  return { r, files }
}

describe('xchain-backup.sh fail-closed', function () {
  it('exits non-zero and names the listing failure when root cannot log in', function () {
    const { r, files } = run('denied')
    expect(r.status).to.not.equal(0)
    expect(r.stderr).to.match(/listing|ERROR 1045/i)
    expect(r.stdout).to.not.contain('no XChain_* databases')
    expect(files).to.have.length(0)
  })

  it('dumps every database and reports success when the listing works', function () {
    const { r, files } = run('ok')
    expect(r.status).to.equal(0)
    expect(files.filter(f => f.endsWith('.sql.gz'))).to.have.length(2)
    expect(r.stdout).to.contain('backup complete: 2 db(s)')
  })

  it('still exits 0 on a genuinely empty install', function () {
    const { r, files } = run('empty')
    expect(r.status).to.equal(0)
    expect(r.stdout).to.contain('no XChain_* databases')
    expect(files).to.have.length(0)
  })
})

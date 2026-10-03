'use strict'

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PROBE = path.join(__dirname, '../../../.github/attest-mirror/hub-llm-probe.js')
const { probeArgs, probeEnv, describe: describeResult, main } = require(PROBE)

const TOKEN = 'sk-ant-oat01-unit-test-value'

// A stand-in CLI that answers with the token it was given inside its error text.
function fakeCli (exitCode) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-llm-probe-'))
    const bin = path.join(dir, 'claude')
    fs.writeFileSync(bin, '#!/bin/sh\ncat > /dev/null\n' +
        'printf \'{"is_error":true,"subtype":"success","result":"bad token %s for %s"}\' ' +
        '"$CLAUDE_CODE_OAUTH_TOKEN" "$CLAUDE_CONFIG_DIR"\nexit ' + exitCode + '\n', { mode: 0o755 })
    return bin
}

function capture (fn) {
    const lines = []
    const original = console.log
    console.log = (line) => { lines.push(String(line)) }
    try { return { code: fn(), lines } } finally { console.log = original }
}

describe('attest-mirror hub-llm-probe.js', function () {
    // A freshly written executable can take seconds to first exec on a Mac.
    this.timeout(60000)

    it('uses the hub spawn argv with no tools and no settings', function () {
        expect(probeArgs('m')).to.deep.equal(['--print', '--output-format', 'json', '--model', 'm',
            '--tools', '', '--no-session-persistence', '--setting-sources', ''])
    })

    it('hands the CLI the hub token and config dir and drops ambient credentials', function () {
        const env = probeEnv({ HUB_CLAUDE_CODE_OAUTH_TOKEN: TOKEN, HUB_CLAUDE_CONFIG_DIR: '/d',
            ANTHROPIC_API_KEY: 'ambient', CLAUDE_CONFIG_DIR: '/human', PATH: '/bin' })
        expect(env).to.include({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN, CLAUDE_CONFIG_DIR: '/d', PATH: '/bin' })
        expect(env).to.not.have.property('ANTHROPIC_API_KEY')
    })

    it('skips with exit 0 when the leg carries no hub credential', function () {
        const out = capture(() => main({ PATH: process.env.PATH }))
        expect(out.code).to.equal(0)
        expect(out.lines.join('\n')).to.include('skipped')
    })

    it('prints the CLI verdict with the token redacted and exits 1 on a failed turn', function () {
        const out = capture(() => main({ PATH: process.env.PATH, CLAUDE_BIN: fakeCli(1),
            HUB_CLAUDE_CODE_OAUTH_TOKEN: TOKEN, HUB_CLAUDE_CONFIG_DIR: '/hub-dir' }))
        const text = out.lines.join('\n')
        expect(out.code).to.equal(1)
        expect(text).to.include('exit 1').and.include('"is_error":true').and.include('bad token *** for /hub-dir')
        expect(text).to.include('credential length ' + TOKEN.length).and.include('oauth-token form true')
        expect(text).to.not.include(TOKEN)
    })

    it('exits 0 on a sound turn and redacts non-JSON output too', function () {
        expect(capture(() => main({ PATH: process.env.PATH, CLAUDE_BIN: fakeCli(0),
            HUB_CLAUDE_CODE_OAUTH_TOKEN: TOKEN, HUB_CLAUDE_CONFIG_DIR: '/d' })).code).to.equal(0)
        const line = describeResult({ status: 1, stdout: 'raw ' + TOKEN, stderr: 'err ' + TOKEN }, TOKEN)
        expect(line).to.not.include(TOKEN)
        expect(line).to.include('raw ***').and.include('err ***')
    })
})

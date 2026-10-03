#!/usr/bin/env node
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

// One `--print` turn with the argv and credential env a venue hub's spawn
// transport uses, printing the CLI's verdict so a provider_error on the leg
// has a named cause. The hub logs only stderr, while the CLI reports auth and
// vendor failures as JSON on stdout. Never prints the credential.

const { spawnSync } = require('child_process')
const os = require('os')

const PROBE_MODEL = 'claude-sonnet-4-6'
const CREDENTIAL_KEYS = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']

// The hub's buildCliArgs (xchain-hub src/providers/llm/claude_spawn.js) for a turn with no system prompt.
function probeArgs (model) {
    return ['--print', '--output-format', 'json', '--model', model, '--tools', '',
        '--no-session-persistence', '--setting-sources', '']
}

// The hub's childEnv over the hub_token resolution: ambient credentials out, the hub's pair in.
function probeEnv (env) {
    const out = Object.assign({}, env)
    for (const key of CREDENTIAL_KEYS) delete out[key]
    out.CLAUDE_CODE_OAUTH_TOKEN = env.HUB_CLAUDE_CODE_OAUTH_TOKEN
    out.CLAUDE_CONFIG_DIR = env.HUB_CLAUDE_CONFIG_DIR
    return out
}

function redact (text, secret) {
    const s = String(text || '')
    return secret ? s.split(secret).join('***') : s
}

// The verdict line: exit code, the envelope's error fields and the first 300 characters of its text.
function describe (result, secret) {
    let json = null
    try { json = JSON.parse(result.stdout) } catch (_) { json = null }
    const fields = json ? {
        is_error: json.is_error, subtype: json.subtype, api_error_status: json.api_error_status,
        result: redact(json.result, secret).slice(0, 300),
    } : { stdout: redact(result.stdout, secret).slice(0, 300) }
    return 'hub llm probe: exit ' + result.status + ' ' + JSON.stringify(fields) +
        (result.stderr ? ' stderr: ' + redact(result.stderr, secret).trim().slice(0, 300) : '')
}

function main (env) {
    const secret = env.HUB_CLAUDE_CODE_OAUTH_TOKEN
    if (!secret || !env.HUB_CLAUDE_CONFIG_DIR) {
        console.log('hub llm probe: skipped, no hub credential on this leg')
        return 0
    }
    console.log('hub llm probe: credential length ' + secret.length +
        ', oauth-token form ' + /^sk-ant-oat/.test(secret))
    const result = spawnSync(env.CLAUDE_BIN || 'claude', probeArgs(PROBE_MODEL), {
        input: 'Reply with the single word: ok', env: probeEnv(env), cwd: os.tmpdir(),
        encoding: 'utf8', timeout: 90000,
    })
    if (result.error) console.log('hub llm probe: spawn failed: ' + result.error.message)
    else console.log(describe(result, secret))
    return result.status === 0 ? 0 : 1
}

if (require.main === module) process.exitCode = main(process.env)

module.exports = { probeArgs, probeEnv, describe, main }

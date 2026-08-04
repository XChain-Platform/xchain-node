/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Node - Redaction-safe names for secret-bearing config keys
 *
 * Automatic secret redaction, in terminals, CI logs and assistant transcripts,
 * keys on the variable NAME and matches the `_SECRET` / `_KEY` / `_TOKEN`
 * forms. `NODE_PASSWORD`, `DECODER_DB_PASS` and `INDEXER_DB_PASS` match none of
 * them, so every read of a `config/<coin>-<network>.local` sidecar prints the
 * credential in full. On 2026-07-23 that is exactly how a regtest hub DB
 * password reached a transcript: nobody echoed it, the name simply did not trip
 * the filter .
 *
 * xchain-hub solved its own half in `xchain-hub/src/secret-env.js`. This is the
 * xchain-node half: the sidecar keys the node itself owns and composes into
 * every container env. Until this existed, renaming a key on a venue broke the
 * stack, so the rename could not be rolled out at all.
 *
 * What this module does: lets every secret-bearing config key be supplied under
 * a redaction-safe `_SECRET` name, keeping the historical name as a deprecated
 * fallback so no existing install breaks on upgrade.
 *
 *   NODE_SECRET        (preferred)  ->  NODE_PASSWORD     (legacy, honoured)
 *   DECODER_DB_SECRET  (preferred)  ->  DECODER_DB_PASS   (legacy, honoured)
 *   INDEXER_DB_SECRET  (preferred)  ->  INDEXER_DB_PASS   (legacy, honoured)
 *
 * What it deliberately does NOT do: rewrite anyone's file. A sidecar keeps the
 * names the operator wrote. Renaming is an operator step (KEY-ROTATION-RUNBOOK
 * §6.1) because on a shared venue it has to land together with the credential
 * rotation and a consumer restart, and because a sidecar silently rewritten to
 * a name an older xchain-node build cannot read turns a downgrade into an
 * outage.
 *
 * Both names set to DIFFERENT values is a hard error rather than a silent
 * precedence rule: that shape is a half-finished rename, and guessing which one
 * the operator meant is how a stack ends up authenticating with the very
 * credential it was supposed to have rotated away from.
 *
 * Renaming the variable does not un-leak anything by itself. A name the filter
 * catches only stops the NEXT read from leaking; a credential that already
 * appeared in a transcript still has to be rotated.
 *
 ********************************************************************/

// Legacy name -> redaction-safe name. Explicit rather than derived from a
// suffix rule: `SIGNING_PRIVKEY_HEX` has no `_PASS` tail to rewrite, and a
// derivation clever enough to cover it would be harder to audit than the table.
//
// The hub-side keys (HUB_DB_PASS, XCHAIN_PRICE_INDEXER_DB_PASS,
// SIGNING_PRIVKEY_HEX) are here as well as in xchain-hub's own table because
// xchain-node is what READS them out of `config/hub.local` and the validator env
// and composes the hub container's environment. Both tables must agree on the
// preferred name; `test/unit/secret-env.test.js` pins them together, and
// `claude/bin/env-secret-name-audit.js` pins its rename suggestions to both.
const SECRET_ENV_ALIASES = Object.freeze({
    NODE_PASSWORD:                'NODE_SECRET',
    DECODER_DB_PASS:              'DECODER_DB_SECRET',
    INDEXER_DB_PASS:              'INDEXER_DB_SECRET',
    HUB_DB_PASS:                  'HUB_DB_SECRET',
    XCHAIN_PRICE_INDEXER_DB_PASS: 'XCHAIN_PRICE_INDEXER_DB_SECRET',
    SIGNING_PRIVKEY_HEX:          'SIGNING_PRIVKEY_SECRET'
})

// Preferred name -> legacy name. Built once; the fold below is a per-key lookup
// on a config object that can hold a hundred keys, so it must not be a scan.
const LEGACY_BY_ALIAS = Object.freeze(Object.fromEntries(
    Object.entries(SECRET_ENV_ALIASES).map(([legacy, alias]) => [alias, legacy])
))

/**
 * The redaction-safe name a secret-bearing key should be supplied under, or
 * undefined when the key is not one this module governs.
 *
 * @param {string} key
 * @returns {string|undefined}
 */
function preferredSecretEnvName(key) {
    return SECRET_ENV_ALIASES[key]
}

/**
 * Fold redaction-safe alias keys back onto their canonical legacy names.
 *
 * Every consumer downstream of getDefaultConfig() (the container env, the DB
 * provisioner, the RPC connectors) reads the legacy names, and there are far
 * too many of them to chase. So the rename is absorbed here, at the one place
 * config enters the process: an operator may write `NODE_SECRET=` in a sidecar,
 * and the rest of xchain-node never learns that anything changed.
 *
 * Mutates and returns `config`. The alias key is REMOVED once folded, so a
 * credential is never handed to a container under two names, which would double
 * the surface the rename was meant to shrink.
 *
 * @param {object} config  parsed KEY=VALUE pairs from a config file / sidecar
 * @returns {object} the same object
 * @throws {Error} when a key is present under both names with different values
 */
function foldSecretEnvAliases(config) {
    if (!config || typeof config !== 'object') return config
    for (const alias of Object.keys(LEGACY_BY_ALIAS)) {
        if (!(alias in config)) continue
        const legacy = LEGACY_BY_ALIAS[alias]
        const aliasValue = config[alias]
        // `docker --env-file` writes an empty value for a key that was set but
        // unresolved. Treat that as absent rather than let it blank out a real
        // legacy value, which would take the stack down with an empty password.
        if (aliasValue === undefined || aliasValue === '') {
            delete config[alias]
            continue
        }
        if (legacy in config && config[legacy] !== '' && config[legacy] !== aliasValue) {
            // Never include either value in the message: it ends up in stderr
            // and in whatever collects stderr.
            throw new Error(alias + ' and ' + legacy + ' are both set to different values. ' +
                'Remove ' + legacy + ' (the deprecated name) once ' + alias + ' carries the current credential.')
        }
        config[legacy] = aliasValue
        delete config[alias]
    }
    return config
}

/**
 * Read one host env var, preferring its redaction-safe alias.
 *
 * The fold above covers per-coin config files and sidecars. Shared services have
 * no config file, so their secrets arrive through the host env (`~/xchain-node/.env`,
 * loaded by dotenv) and get passed through into the container. That file is read by
 * hand during incidents at least as often as a sidecar is, so it needs the same
 * escape from the filter-invisible naming.
 *
 * @param {string} name          canonical (legacy) variable name
 * @param {object} [env=process.env]
 * @returns {string|undefined}
 * @throws {Error} when both names are set to different values
 */
function readSecretHostEnv(name, env = process.env) {
    const alias = SECRET_ENV_ALIASES[name]
    if (!alias) return env[name]
    const aliasValue  = env[alias]
    const legacyValue = env[name]
    if (aliasValue === undefined || aliasValue === '') return legacyValue
    if (legacyValue !== undefined && legacyValue !== '' && legacyValue !== aliasValue) {
        throw new Error(alias + ' and ' + name + ' are both set to different values. ' +
            'Remove ' + name + ' (the deprecated name) once ' + alias + ' carries the current credential.')
    }
    return aliasValue
}

/**
 * Secrets still supplied under a deprecated, filter-invisible name. Callers log
 * these once so an operator finds out from their own node, not from a leaked
 * transcript.
 *
 * @param {object} config
 * @returns {Array<{legacy: string, preferred: string}>}
 */
function deprecatedSecretEnvNames(config) {
    const found = []
    if (!config || typeof config !== 'object') return found
    for (const [legacy, alias] of Object.entries(SECRET_ENV_ALIASES)) {
        const legacyValue = config[legacy]
        const aliasValue  = config[alias]
        const hasLegacy = legacyValue !== undefined && legacyValue !== ''
        const hasAlias  = aliasValue !== undefined && aliasValue !== ''
        if (hasLegacy && !hasAlias) found.push({ legacy, preferred: alias })
    }
    return found
}

module.exports = {
    SECRET_ENV_ALIASES,
    preferredSecretEnvName,
    foldSecretEnvAliases,
    readSecretHostEnv,
    deprecatedSecretEnvNames
}

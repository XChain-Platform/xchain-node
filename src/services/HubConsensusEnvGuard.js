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
 * XChain Node - Hub Consensus Env Guard
 *
 * ConfigService's hubPassthroughVars only inject a value when the INVOKING
 * SHELL happens to export it; a var it does not export is simply left out of
 * the container env, and the hub falls back to its own built-in default with
 * no message anywhere. For most of the ~30 hub passthrough vars that is fine
 * (they are genuinely optional). A handful are not: HUB_NETWORK,
 * ORACLE_MIN_SUBMISSIONS, ORACLE_ROUND_INTERVAL, ORACLE_SUBMISSION_WINDOW,
 * XCHAIN_PRICE_INDEXER_DB_* and (on regtest, see below) the four XCHAIN/BTC
 * derivation overrides are CONSENSUS-SHAPED (they change what the hub's
 * oracle finalizes, or whether it finalizes at all), so a `recreate` run from
 * a shell that lacks one of them silently deploys a hub with different
 * consensus behavior than the one that was just torn down. That is the same
 * silent-drop class this row's predecessor closed for docker cp and the
 * install/update/recreate exit codes: an absence that produces no output.
 *
 * The fix does not gate on "is this var unset" alone: unset is the CORRECT,
 * documented state for a first install on a real network (see the comments
 * in ConfigService), so refusing on bare absence would break every normal
 * mainnet onboarding. What must never happen silently is a RUNNING hub
 * losing a value it already had. So the guard compares the env this deploy
 * is about to write against the env the CURRENTLY RUNNING container already
 * carries (the same "read the live container, not the config file" pattern
 * DbCredentialDrift.js uses for HUB_DB_PASS/DECODER_DB_PASS/INDEXER_DB_PASS):
 *
 *   - no running container (fresh install): nothing to protect. WARN so the
 *     operator can catch a first-time mistake, but proceed - taking the
 *     hub's own default is a legitimate choice here.
 *   - running container agrees, or never carried the var: proceed silently.
 *   - running container carries a value this deploy would change or drop:
 *     REFUSE. A value already trusted by a live hub (or by its DB/oracle
 *     federation peers, for the round-cadence and network vars) must not
 *     change because of which shell happened to invoke `recreate`.
 *
 * Values are never logged, only compared, for the same reason as
 * DbCredentialDrift: XCHAIN_PRICE_INDEXER_DB_PASS is a credential.
 *
 * NETWORK-GATED KEYS
 * ------------------
 * Some of the passthrough vars are consensus-shaped only on the network where
 * the hub actually honors them. The four XCHAIN/BTC derivation parameters
 * (XCHAIN_PRICE_WINDOW_BLOCKS, _CONFIRMATION_BUFFER, _BOOTSTRAP_SATS,
 * _MIN_BTC_VOLUME) are the case that forced this: XchainPriceSource's
 * pinOffRegtest honors them ONLY when HUB_NETWORK is regtest, and pins them to
 * the constants.js values (with a "set but IGNORED" warning) on mainnet,
 * testnet and standalone alike.
 *
 * Adding them to the flat key list unconditionally would have been the wrong
 * fix, and worse than leaving them out. This guard counts a DROP as drift, so
 * a mainnet hub whose container still carries a stale, already-ignored
 * XCHAIN_PRICE_BOOTSTRAP_SATS would have had every future recreate REFUSED
 * until the operator either re-exported a variable the hub throws away or set
 * the override - a refusal protecting a value that cannot change anything.
 *
 * So the honored set is DERIVED from the network rather than fixed: a group
 * may carry `honoredOn`, and its keys enter the comparison only when the
 * deploy's effective network is in that list. The effective network is read
 * from HUB_NETWORK alone (this deploy's, else the running container's), never
 * from the coin/network the node command is operating on, because HUB_NETWORK
 * is exactly what the hub's own gate reads: falling back to the node's network
 * would make the guard protect keys a standalone hub (HUB_NETWORK unset) is
 * already ignoring, which is the same wrong refusal in a different disguise.
 ********************************************************************/

const { HUB_MODULE_NAME } = require('../config/constants')
const { getDockerContainerImageName } = require('./ConfigService')
const { readContainerEnv } = require('./DbCredentialDrift')

// Escape hatch, named and shaped like DbCredentialDrift's, for an operator who
// is deliberately changing one of these values on a live hub (a real,
// intentional oracle re-tune) rather than losing it by accident.
const DRIFT_OVERRIDE_ENV = 'XCHAIN_NODE_ALLOW_HUB_CONSENSUS_ENV_DRIFT'

// Tags the refusal so callers can distinguish it from an unrelated docker failure.
const DRIFT_ERROR_CODE = 'HUB_CONSENSUS_ENV_DRIFT'

// Grouped for the warning/error text; CONSENSUS_ENV_KEYS (below) is the flat
// list every comparison actually walks.
const CONSENSUS_ENV_GROUPS = [
    {
        keys: ['HUB_NETWORK'],
        why: 'names the deployment network for consensus activation gating (STAKE_WEIGHTED_QUORUM); ' +
            'the hub itself refuses to boot without it in VALIDATOR mode, but silently runs network-unaware in standalone mode'
    },
    {
        keys: ['ORACLE_MIN_SUBMISSIONS'],
        why: 'oracle price-round finalization threshold (hub default 2); a single-source venue that ' +
            'loses its ORACLE_MIN_SUBMISSIONS=1 override reverts to the default and NO ROUND EVER FINALIZES again'
    },
    {
        keys: ['ORACLE_ROUND_INTERVAL', 'ORACLE_SUBMISSION_WINDOW'],
        why: 'oracle round cadence, CONSENSUS-UNIFORM across a federation; a hub that loses its override ' +
            'reverts to the mainnet-length default while its federation peers may still run the shorter one'
    },
    {
        keys: [
            'XCHAIN_PRICE_INDEXER_DB_HOST', 'XCHAIN_PRICE_INDEXER_DB_PORT', 'XCHAIN_PRICE_INDEXER_DB_NAME',
            'XCHAIN_PRICE_INDEXER_DB_USER', 'XCHAIN_PRICE_INDEXER_DB_PASS', 'XCHAIN_PRICE_INDEXER_DB_COIN'
        ],
        why: 'feeds the derived XCHAIN/USD price; unset is a supported "abstain from the pair" state for a ' +
            'hub that never had it, but a hub that WAS deriving the pair losing this source changes what it submits'
    },
    {
        keys: [
            'XCHAIN_PRICE_WINDOW_BLOCKS', 'XCHAIN_PRICE_CONFIRMATION_BUFFER',
            'XCHAIN_PRICE_BOOTSTRAP_SATS', 'XCHAIN_PRICE_MIN_BTC_VOLUME'
        ],
        // Honored only on regtest, so guarded only on regtest. See NETWORK-GATED
        // KEYS in the header: on any other network the hub pins these to the
        // constants.js values and warns, which makes a drop unable to change
        // anything and a refusal over one pure obstruction.
        honoredOn: ['regtest'],
        why: 'the CONSENSUS-UNIFORM XCHAIN/BTC derivation parameters, honored on regtest only; on a regtest ' +
            'venue losing one silently retunes the window, buffer, bootstrap price or supersession threshold ' +
            'this hub derives the pair with, which is what an e2e drill is measuring'
    }
]

const CONSENSUS_ENV_KEYS = CONSENSUS_ENV_GROUPS.flatMap(g => g.keys)

// The key whose value decides which of the network-gated groups apply. Guarded
// in its own right (the first group), so a deploy that would drop it is refused
// on that ground before any of its gating consequences matter.
const NETWORK_KEY = 'HUB_NETWORK'

/**
 * The network this deploy's hub will actually run as, lowercased, for deciding
 * which network-gated keys are in force. '' means standalone/unset, which every
 * gated group treats the same as a non-regtest network (the hub's own seams all
 * fail closed to the consensus pin there).
 *
 * @param {Object<string,string>} intended The env this deploy is about to write.
 * @param {Object<string,string>|null} [liveEnv] The running container's frozen env, if any.
 * @returns {string}
 */
function resolveHubNetwork(intended, liveEnv) {
    const fromIntended = (intended || {})[NETWORK_KEY]
    if (fromIntended !== undefined && fromIntended !== null && String(fromIntended) !== '') {
        return String(fromIntended).toLowerCase()
    }
    // The shell that invoked this deploy did not export it. The running
    // container's value is the next best evidence of what this hub IS: a
    // regtest hub whose recreate lost HUB_NETWORK still had its price knobs
    // honored a moment ago, and dropping one alongside is real drift.
    const fromLive = (liveEnv || {})[NETWORK_KEY]
    if (fromLive !== undefined && fromLive !== null && String(fromLive) !== '') {
        return String(fromLive).toLowerCase()
    }
    return ''
}

/**
 * Whether a consensus-shaped key is honored by a hub running on `network`.
 * An ungated group (no `honoredOn`) is honored everywhere.
 *
 * @param {string} key
 * @param {string} network Lowercased network name, '' for standalone/unset.
 * @returns {boolean}
 */
function isConsensusEnvKeyHonoredOn(key, network) {
    const group = CONSENSUS_ENV_GROUPS.find(g => g.keys.includes(key))
    if (!group || !group.honoredOn) return true
    return group.honoredOn.includes(String(network || '').toLowerCase())
}

/**
 * The consensus-shaped keys in force on `network`: the flat list minus every
 * network-gated key this hub would ignore. Everything the guard walks (drift
 * comparison and the supply log alike) comes from here, so a key the hub
 * ignores is never reported as missing and never counted as drift when dropped.
 *
 * @param {string} network Lowercased network name, '' for standalone/unset.
 * @returns {string[]}
 */
function consensusEnvKeysForNetwork(network) {
    return CONSENSUS_ENV_KEYS.filter(key => isConsensusEnvKeyHonoredOn(key, network))
}

/**
 * Which of the consensus-shaped keys this deploy supplies vs. leaves for the
 * hub's own default. Pure: reads only the objects passed in.
 *
 * Scoped to the keys the deploy's network actually honors, so a mainnet deploy
 * is never told it "did not supply" a regtest-only derivation override.
 *
 * @param {Object<string,string>} intended The env this deploy is about to write.
 * @param {string} [network] Effective network; defaults to this deploy's own HUB_NETWORK.
 * @returns {{supplied: string[], defaulted: string[]}}
 */
function describeConsensusEnvSupply(intended, network) {
    const src = intended || {}
    const scope = consensusEnvKeysForNetwork(network === undefined ? resolveHubNetwork(src, null) : network)
    const supplied = []
    const defaulted = []
    for (const key of scope) {
        const v = src[key]
        if (v === undefined || v === null || v === '') defaulted.push(key)
        else supplied.push(key)
    }
    return { supplied, defaulted }
}

/**
 * Compare the env a deploy is about to write against the env a running hub
 * container already carries. Pure: no docker, no logging.
 *
 * A key only counts as drift when the LIVE container already carries a
 * non-empty value for it and the new deploy would write something different
 * (including nothing at all). A key the live container never carried is not
 * drift: that hub was already running without it, so there is nothing to lose.
 *
 * A key this hub's network does not honor is not drift either, whatever the
 * live container carries. Unsetting a variable the hub already throws away is
 * housekeeping, not a consensus change, and the guard must not stand in front
 * of it (see NETWORK-GATED KEYS in the header).
 *
 * @param {Object<string,string>} intended The env this deploy is about to write.
 * @param {Object<string,string>|null} liveEnv The running container's frozen env, or null.
 * @returns {Array<{key: string}>}
 */
function findHubConsensusEnvDrift(intended, liveEnv) {
    const drift = []
    if (!liveEnv) return drift
    const next = intended || {}
    for (const key of consensusEnvKeysForNetwork(resolveHubNetwork(next, liveEnv))) {
        const live = liveEnv[key]
        if (live === undefined || live === null || live === '') continue
        const nextValue = (next[key] === undefined || next[key] === null) ? '' : String(next[key])
        if (nextValue !== String(live)) drift.push({ key })
    }
    return drift
}

/**
 * Render the refusal. Names the KEYS only, never the values (one of them,
 * XCHAIN_PRICE_INDEXER_DB_PASS, is a credential).
 *
 * @param {Array<{key: string}>} drift
 * @returns {string}
 */
function formatHubConsensusEnvDriftError(drift) {
    const keys = drift.map(d => d.key)
    const lines = keys.map(k => `  - ${k}`)
    return (
        'Refusing to deploy xchain-hub: the RUNNING container already carries a value for the ' +
        'following consensus-shaped setting(s), and this deploy would silently change or drop them ' +
        "because they are missing (or different) in the invoking shell's environment:\n" +
        lines.join('\n') + '\n' +
        'Nothing has been changed. Export the SAME values this hub was deployed with before (check ' +
        '`docker inspect --format \'{{json .Config.Env}}\'` on the running container if unsure), or set ' +
        `${DRIFT_OVERRIDE_ENV}=1 to deploy with the new value(s) anyway (an intentional oracle re-tune).`
    )
}

/**
 * Print, on every hub deploy, exactly which consensus-shaped vars this run
 * supplies from the host env and which it leaves for the hub's own default.
 * Runs regardless of whether a container is already running, so a first
 * install gets the same observability a recreate does.
 *
 * @param {Object<string,string>} intended The env this deploy is about to write.
 * @param {string} [network] Effective network; defaults to this deploy's own HUB_NETWORK.
 */
function logConsensusEnvSupplyState(intended, network) {
    const { supplied, defaulted } = describeConsensusEnvSupply(intended, network)
    if (defaulted.length > 0) {
        console.warn(
            'WARNING: hub consensus-shaped settings NOT supplied by the invoking shell (the hub will use ' +
            `its own built-in default for each): ${defaulted.join(', ')}. If this hub previously ran with ` +
            'different values (a single-source regtest ORACLE_MIN_SUBMISSIONS=1, a shortened ' +
            'ORACLE_ROUND_INTERVAL/ORACLE_SUBMISSION_WINDOW, an explicit HUB_NETWORK, or a configured ' +
            'XCHAIN_PRICE_INDEXER_DB_* source), export them in THIS shell before deploying.'
        )
    }
    if (supplied.length > 0) {
        console.log(`hub consensus-shaped settings supplied from the host env: ${supplied.join(', ')}`)
    }
}

/**
 * Fail closed when a running hub container would silently lose a
 * consensus-shaped setting to this deploy. Always logs the supplied/defaulted
 * split first (observability for the no-running-container case too).
 *
 * @param {Object<string,string>} environmentVariables The env this deploy is about to write (getDefaultConfig output).
 * @param {{execFileAsync?: Function, env?: Object, containerName?: string}} [deps]
 * @returns {Promise<Array<{key: string}>>} the drift rows (empty when clean, or when overridden)
 */
async function assertNoHubConsensusEnvDrift(environmentVariables, deps = {}) {
    const env = deps.env || process.env

    const containerName = deps.containerName || getDockerContainerImageName(HUB_MODULE_NAME, null, null)
    const liveEnv = await readContainerEnv(containerName, deps)

    // Read the container BEFORE logging so the supply report is scoped to the
    // same network the drift comparison uses: a recreate whose shell dropped
    // HUB_NETWORK still resolves regtest from the running container, and its
    // regtest-only derivation overrides belong in the report. readContainerEnv
    // returns null rather than throwing, so this still logs on a fresh install.
    logConsensusEnvSupplyState(environmentVariables, resolveHubNetwork(environmentVariables, liveEnv))

    if (!liveEnv) return [] // no running hub container: fresh install, nothing to drift against

    const drift = findHubConsensusEnvDrift(environmentVariables, liveEnv)
    if (drift.length === 0) return drift

    if (env[DRIFT_OVERRIDE_ENV] === '1') {
        console.log(formatHubConsensusEnvDriftError(drift))
        console.log(`${DRIFT_OVERRIDE_ENV}=1 is set; deploying anyway.`)
        return drift
    }
    const error = new Error(formatHubConsensusEnvDriftError(drift))
    error.code = DRIFT_ERROR_CODE
    error.drift = drift
    throw error
}

/**
 * Whether an error came from this guard. Callers use it to suppress their own
 * fallback diagnosis, which would otherwise blame the wrong layer.
 *
 * @param {*} err
 * @returns {boolean}
 */
function isHubConsensusEnvDriftError(err) {
    return !!err && err.code === DRIFT_ERROR_CODE
}

module.exports = {
    DRIFT_OVERRIDE_ENV,
    DRIFT_ERROR_CODE,
    NETWORK_KEY,
    CONSENSUS_ENV_GROUPS,
    CONSENSUS_ENV_KEYS,
    resolveHubNetwork,
    isConsensusEnvKeyHonoredOn,
    consensusEnvKeysForNetwork,
    describeConsensusEnvSupply,
    findHubConsensusEnvDrift,
    formatHubConsensusEnvDriftError,
    logConsensusEnvSupplyState,
    assertNoHubConsensusEnvDrift,
    isHubConsensusEnvDriftError
}

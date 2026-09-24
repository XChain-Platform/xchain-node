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
 * XChain Node - CLI
 * Commander setup and command definitions
 ********************************************************************/
function registerPs(program, deps) {
    const { getStatus } = deps
    program
        .command('ps')
        .description('List installed XChain services and status')
        .action(async () => {
            await getStatus(null, null, true)
            return process.exit(0)
        })

}

function registerBootstrapCombos(program, deps) {
    const { listServedBootstrapCombos } = deps
    program
        .command('bootstrap-combos')
        .description('List served <service>:<coin>:<network> combos, one per line (scriptable)')
        .addHelpText('after', `
Reads the module registry, not live containers, so a STOPPED or crash-looping
combo is still listed. scripts/publish-bootstraps.sh --all builds its plan from
this: detecting from \`docker ps\` dropped stopped combos before the source-health
gate could report them, so the cron exited 0 while a consumer archive went stale.`)
        .action(async () => {
            const combos = await listServedBootstrapCombos()
            for (const combo of combos) console.log(combo)
            return process.exit(0)
        })

}

function registerBootstrapRepublishDue(program, deps) {
    const { listRepublishDue } = deps
    program
        .command('bootstrap-republish-due')
        .description('List combos whose published bootstrap predates their last reindex (scriptable)')
        .option('--json', 'emit the full records (reindexedAt, publishedAt, reason) instead of bare combos')
        .addHelpText('after', `
A reset wipes a store and rebuilds it on a NEW lineage, so every bootstrap
already published for that combo describes the old one: a fresh install that
takes it restores pre-reindex state and halts. Nothing forced a republish, and
no age check catches it, because the stale-lineage archive is hours old and
simply wrong.

\`reset\` records the combos it wiped, \`bootstrap create\` records what it
re-derived, and this lists the difference. scripts/publish-bootstraps.sh reads
it to pull due combos into its plan even when the schedule or the tracker
opt-in would have skipped them.`)
        .action(async (options) => {
            const due = listRepublishDue()
            if (options && options.json) {
                console.log(JSON.stringify(due, null, 2))
            } else {
                for (const entry of due) console.log(entry.combo)
            }
            return process.exit(0)
        })

}

function registerStatusCommands(program, deps) {
    registerPs(program, deps)
    registerBootstrapCombos(program, deps)
    registerBootstrapRepublishDue(program, deps)
}

function registerValidatorRoot(program) {
    const validator = program
        .command('validator')
        .description('Validator-mode setup for the xchain-hub (key generation + config)')

    return validator
}

function registerValidatorInit(validator, deps) {
    const { initValidator } = deps
    validator
        .command('init')
        .description('Generate a validator signing key + config so the hub runs in validator mode')
        .option('--seed-nodes <list>',        'comma-separated peer addresses (host:port,host:port)')
        .option('--p2p-addr <addr>',          'this validator\'s public address (host:port)')
        .option('--p2p-port <port>',          'P2P listen port (10003 regtest, 10002 testnet, 10001 mainnet; default 10001)')
        .option('--network <name>',           'federation to join: regtest, testnet, or mainnet (default: implied by --p2p-port)')
        .option('--oracle-epoch-start <ms>',  'shared oracle epoch start (unix ms); defaults to the known federation value')
        .option('--capabilities <list>',      'enabled capabilities (default price,cross_chain,oracle_publish,attestation)')
        .option('--import-stake-key',         'use your own BTC stake key: prompts for the WIF (or set XCHAIN_NODE_STAKE_WIF)')
        .option('--import-doge-key',          'use your own DOGE publisher key: prompts for the WIF (or set XCHAIN_NODE_DOGE_WIF)')
        .option('--no-wallets',               'skip wallet generation (you run your own signer via XCHAIN_NODE_HUB_SIGNER_DIR)')
        .option('--mint-hub-api-key',         'on a re-run, generate a HUB_API_KEY if this host has none (401s every consumer that carries no key)')
        .option('--force',                    'overwrite existing validator config (generates a NEW signing key; wallets are kept)')
        .option('--force-wallets',            'also replace existing wallets (the old addresses and any coin at them are abandoned)')
        .action(async (opts) => {
            try {
                await initValidator(opts)
            } catch (e) {
                console.error('\nERROR: ' + e.message + '\n')
                return process.exit(1)
            }
            return process.exit(0)
        })

}

function registerValidatorStake(validator, deps) {
    const { stakeValidator } = deps
    validator
        .command('stake')
        .description('Mint XCHAIN if short (testnet) and broadcast the STAKE naming this validator\'s pubkey; dry run without --broadcast')
        .option('--amount <xchain>',   'amount to stake (default 25000, clears every capability floor)')
        .option('--broadcast',         'actually send the transactions (default: print the plan only)')
        .option('--no-wait',           'return once the STAKE is broadcast instead of waiting for it to index')
        .option('--serialize',         'send one action per block (default: chained back to back into one block)')
        .option('--fee-per-kb <coin>', 'fee rate in coin per kB (default: the encoder\'s estimate)')
        .option('--timeout <minutes>', 'how long to wait for the stake to index (default 120)')
        .action(async (opts) => {
            try {
                await stakeValidator(opts)
            } catch (e) {
                console.error('\nERROR: ' + e.message + '\n')
                return process.exit(1)
            }
            return process.exit(0)
        })

}

function registerValidatorUnstake(validator, deps) {
    const { unstakeValidator } = deps
    validator
        .command('unstake')
        .description('Withdraw this validator\'s stake and leave the active set; dry run without --broadcast')
        .option('--broadcast',         'actually send the transaction (default: print the plan only)')
        .option('--no-wait',           'return once broadcast instead of waiting for it to index')
        .option('--fee-per-kb <coin>', 'fee rate in coin per kB (default: the encoder\'s estimate)')
        .option('--timeout <minutes>', 'how long to wait for it to index (default 120)')
        .action(async (opts) => {
            try {
                await unstakeValidator(opts)
            } catch (e) {
                console.error('\nERROR: ' + e.message + '\n')
                return process.exit(1)
            }
            return process.exit(0)
        })

}

function printValidatorConfiguration(s, deps) {
    const {
        getCapabilityConfigHostPath, readWallets, publicWalletInfo,
        getSignerMountDir, COIN_NETWORKS, WALLETS_FILE
    } = deps
    console.log('Validator enabled.')
    console.log('  pubkey       : ' + s.pubkey)
    console.log('  network      : ' + (s.network || '(unset; set HUB_NETWORK in .env)'))
    console.log('  p2p address  : ' + s.P2P_VALIDATOR_ADDR)
    console.log('  seed nodes   : ' + ((s.SEED_NODES || []).join(', ') || '(none)'))
    console.log('  oracle epoch : ' + (s.ORACLE_EPOCH_START || '(unset, required before oracle runs)'))
    console.log('  capabilities : ' + ((s.capabilities || []).join(', ') || '(none)'))
    // full_node is a possession-proof tier, not an opt-in capability, and
    // it ships inert on every network (reward share zero, no verifier
    // set) until its activation flag day. Said here so an operator whose
    // stake clears its floor does not go looking for how to earn it.
    console.log('  full_node    : not active on this network yet (tier turns on with a flag day; nothing to configure)')
    // Print the live path: it moved into its own directory (so the hub's
    // bind mount cannot break `docker cp`), and this is where an operator
    // coming from an older install finds it after the migration.
    console.log('  caps config  : ' + (getCapabilityConfigHostPath() || '(missing; re-run validator init)'))
    // Addresses only. The keys stay in the 0600 file.
    const w = publicWalletInfo(readWallets())
    const coins = COIN_NETWORKS[(w && w.network) || s.network] || { stakeCoin: 'coin', dogeCoin: 'DOGE' }
    if (w) {
        console.log('  stake wallet : ' + w.stakeAddress + '  (' + coins.stakeCoin + ' for fees, holds the XCHAIN stake)')
        console.log('  DOGE wallet  : ' + w.dogeAddress + '  (' + coins.dogeCoin + ' for price rounds and anchors)')
        console.log('  keys file    : ' + WALLETS_FILE + ' (mode 0600; back it up)')
        console.log('  DOGE signer  : ' + (deps.config.XCHAIN_NODE_HUB_SIGNER_DIR
            ? deps.config.XCHAIN_NODE_HUB_SIGNER_DIR + ' (operator-supplied, XCHAIN_NODE_HUB_SIGNER_DIR)'
            : (getSignerMountDir() || '(missing; re-run validator init)')))
    } else {
        console.log('  wallets      : (none; re-run validator init, or run your own signer via XCHAIN_NODE_HUB_SIGNER_DIR)')
    }
    return { w, coins }
}

    // ROLLCALL reporting: the DOGE runway (reusing the address read above,
    // never a second fetch), whether the configured signer can PUBLISH a
    // roll call rather than only sign one, and this key's BTC-side absence
    // streak. Each degrades to its own "unavailable" line instead of
    // crashing the whole command or printing a reassuring zero.
function printRollcallStatus(rollcall, coins) {
    if (rollcall.doge) {
        console.log(rollcall.doge.unavailable
            ? '  DOGE runway  : unavailable (could not read the DOGE wallet balance' +
              (rollcall.doge.error ? ': ' + rollcall.doge.error : '') + ')'
            : '  DOGE runway  : ' + rollcall.doge.balance + ' ' + coins.dogeCoin + ' confirmed, ~' +
              rollcall.doge.rollcalls + ' roll call(s) of runway (~0.006 ' + coins.dogeCoin +
              ' each: two ~0.003 ' + coins.dogeCoin + ' transactions)')
    }
    if (rollcall.broadcast) {
        console.log(rollcall.broadcast.exportsBroadcast
            ? '  roll call    : this signer exports broadcast, so it can publish roll calls'
            : '  roll call    : NO broadcast export in ' + rollcall.broadcast.file +
              ' - it can SIGN a roll call but never PUBLISH one, silently. Add broadcast(payload) ' +
              'or use the CLI-generated signer.')
    }
    if (rollcall.absences) {
        if (rollcall.absences.unavailable) {
            console.log('  roll call absences (BTC): unavailable (' +
                (rollcall.absences.error || rollcall.absences.reason || 'indexer read failed') +
                '); check the explorer before assuming this key is safe')
        } else if (rollcall.absences.streak === 0) {
            console.log('  roll call absences (BTC): none on record')
        } else if (rollcall.absences.streak === 1) {
            console.log('  roll call absences (BTC): 1 (warning shot; one more consecutive miss evicts this stake)')
        } else {
            console.log('  roll call absences (BTC): ' + rollcall.absences.streak +
                (rollcall.absences.evictedNow ? '  EVICTED - dropped from every capability set' : ''))
        }
    }
}

async function showValidatorStatus(deps) {
    const { getValidatorSettings, isInitialized, getRollcallStatus } = deps
    const s = getValidatorSettings()
    if (!s) {
        console.log(isInitialized()
            ? 'Validator is initialized but disabled.'
            : 'No validator configured. Run: xchain-node validator init')
    } else {
        const { w, coins } = printValidatorConfiguration(s, deps)
        const rollcall = await getRollcallStatus(w, (w && w.network) || s.network)
        printRollcallStatus(rollcall, coins)
            console.log('')
            console.log('  On-chain membership: xchain-node validator stake   (dry run shows balances and the stake)')
            console.log('  Capability drift   : xchain-node validator drift   (compares this against the indexer)')
    }
    return process.exit(0)
}

function registerValidatorStatus(validator, deps) {
    validator
        .command('status')
        .description('Show this node\'s validator configuration (pubkey, wallets, peers, capabilities)')
        .action(() => showValidatorStatus(deps))
}

function registerValidatorDrift(validator, deps) {
    const { capabilityDriftReport, capabilityDriftExitCode, formatCapabilityDrift } = deps
    // The probe half of the mispointed-config-dir defect: what this host RESOLVES
    // as its capability set against what the indexer ANSWERS for the same key.
    // Exits 1 on drift and 2 when the comparison could not be made, so a deploy
    // check can branch on it rather than parse the text.
    validator
        .command('drift')
        .description('Compare this host\'s resolved capability set against the indexer\'s validator sets')
        .option('--pubkey <hex>',    'identity to look up when this host has none (a mispointed config dir resolves standalone)')
        .option('--network <name>',  'network to query: testnet or mainnet (default: this host\'s recorded network)')
        .option('--block <index>',   'settle membership at this block instead of the indexer\'s tip')
        .action(async (opts) => {
            let report
            try {
                report = await capabilityDriftReport(
                    { expectPubkey: opts.pubkey, network: opts.network },
                    opts.block === undefined ? {} : { blockIndex: Number(opts.block) })
            } catch (e) {
                console.error('\nERROR: ' + e.message + '\n')
                return process.exit(2)
            }
            for (const line of formatCapabilityDrift(report)) console.log(line)
            return process.exit(capabilityDriftExitCode(report))
        })

}

function registerValidatorCommands(program, deps) {
    const validator = registerValidatorRoot(program)
    registerValidatorInit(validator, deps)
    registerValidatorStake(validator, deps)
    registerValidatorUnstake(validator, deps)
    registerValidatorStatus(validator, deps)
    registerValidatorDrift(validator, deps)
}

module.exports = { registerStatusCommands, registerValidatorCommands }

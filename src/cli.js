/*********************************************************************
 * XChain Node - CLI
 * Commander setup and command definitions
 ********************************************************************/

const { Command }  = require('commander')
const { version }  = require('../package.json')
const { preCheck } = require('./precheck')
const { setVerbose } = require('./state')
const { filterCommandParameters, resolveArgs } = require('./services/ConfigService')
const {
    installModules,
    updateModules,
    uninstallModules,
    logModules,
    monitorModules,
    restartModules,
    stopModules,
    startModules,
    execModules,
    shellModule,
    runE2ETest,
    resetModules
} = require('./operations/moduleOperations')
const { getStatus }            = require('./services/StatusService')
const { scanAndRegisterModules } = require('./services/DiscoveryService')
const { maybeReportTelemetry } = require('./services/TelemetryService')
const { makeBootstrap }        = require('./services/BootstrapService')
const { initValidator, getValidatorSettings, isInitialized } = require('./services/ValidatorService')
const { restoreBootstrapInterface, startInterface } = require('./ui/menu')

async function parseCommand() {
    const program = new Command()

    const commandsNeedingVersions = ['install', 'update', 'reinstall']
    // Read-only commands only display state and never change which services
    // are installed/running, so they don't need to push local config to the
    // hub/explorer. Skipping the push keeps them fast and avoids the lengthy
    // updateconfig round-trip on multi-coin nodes. Any command NOT listed here
    // (install, update, start, stop, restart, uninstall, reset, sync, …) still
    // pushes — the default is to sync, so a new/unknown command stays safe.
    const readOnlyCommands = ['ps', 'tail', 'logs', 'monitor', 'tailmonitor']
    program.hook('preAction', async (thisCommand, actionCommand) => {
        setVerbose(thisCommand.opts().verbose ?? false)
        if (thisCommand.opts().verbose) console.log("Checking xchain-node structure")
        const commandName = actionCommand.name()
        // `validator` subcommands are offline (key generation + local config
        // file writes). They must NOT trigger the Docker/MariaDB precheck, so an
        // operator can prepare their validator identity before any stack is up.
        const parentName = actionCommand.parent && actionCommand.parent.name()
        if (commandName === 'validator' || parentName === 'validator') return
        await preCheck(
            commandsNeedingVersions.includes(commandName),
            !readOnlyCommands.includes(commandName)
        )
        // Anonymous usage telemetry (default-on, opt-out). Fire-and-forget:
        // a failure here must never block or break the command being run.
        try {
            const optOut = thisCommand.opts().telemetry === false
            await maybeReportTelemetry(actionCommand.name(), optOut)
        } catch { /* telemetry is best-effort */ }
    })

    program
        .name('xchain-node')
        .version(version, '-V, --version', 'Shows xchain-node version')
        .option('-v, --verbose', 'Print precheck progress messages')
        .option('-i, --interactive', 'Interactive mode')
        .option('--no-bootstrap', 'Do not download bootstrap files (full parse)')
        .option('--no-explorer', 'Do not install xchain-explorer')
        .option('--no-telemetry', 'Disable anonymous usage telemetry (see Privacy & Telemetry docs)')
        .action(async (options) => {
            if (options.interactive) {
                return startInterface()
            }
            program.help()
        })

    program
        .command('install')
        .description('Installs XChain services')
        .argument('<branch>',  '(master, develop)')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .option('--no-bootstrap', 'do not auto-download/restore a published utxo-tracker bootstrap (sync from scratch)')
        .action(async (branch, service, chain, network, options) => {
            if (options && options.bootstrap === false) process.env.XCHAIN_NODE_NO_BOOTSTRAP = '1'
            const resolved = resolveArgs([branch, service, chain, network], { expectBranch: true })
            const serviceList = filterCommandParameters(null, resolved.service, resolved.chain, resolved.network)
            await installModules(serviceList, resolved.branch)
            return process.exit(0)
        })

    program
        .command('uninstall')
        .description('Uninstall XChain services')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .option('--include-shared', 'Also uninstall shared services (database, xchain-hub, xchain-explorer)')
        .action(async (service, chain, network, options) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            await uninstallModules(serviceList, options.includeShared)
            return process.exit(0)
        })

    program
        .command('update')
        .description('Update XChain services')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .argument('[branch]',  '(master, develop, or any branch name)')
        .action(async (service, chain, network, branch) => {
            const resolved = resolveArgs([service, chain, network, branch], { expectBranch: true, defaultBranch: null })
            const serviceList = filterCommandParameters(null, resolved.service, resolved.chain, resolved.network)
            await updateModules(serviceList, resolved.branch)
            return process.exit(0)
        })

    program
        .command('ps')
        .description('List installed XChain services and status')
        .action(async () => {
            await getStatus(null, null, true)
            return process.exit(0)
        })

    program
        .command('sync')
        .description('Scan Docker for xchain-node containers and register any missing in the database')
        .action(async () => {
            const added = await scanAndRegisterModules()
            console.log(added === 0 ? "Nothing to add — already in sync" : `Registered ${added} module(s)`)
            return process.exit(0)
        })

    program
        .command('start')
        .description('Start XChain service')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            await startModules(serviceList)
            return process.exit(0)
        })

    program
        .command('stop')
        .description('Stop XChain service')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            await stopModules(serviceList)
            return process.exit(0)
        })

    program
        .command('restart')
        .description('Restart XChain service')
        .argument('<service>', '(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            await restartModules(serviceList)
            return process.exit(0)
        })

    program
        .command('tail')
        .description('Tail XChain service logs')
        .argument('[service]', '(node, database, xchain-hub, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            await logModules(serviceList)
            return process.exit(0)
        })

    program
        .command('logs')
        .description('Display full XChain service logs')
        .argument('[service]', '(node, database, xchain-hub, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            await logModules(serviceList, false)
            return process.exit(0)
        })

    program
        .command('monitor')
        .description('Display service logs in split spaces on the screen')
        .argument('[service]', '(node, database, xchain-hub, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            await monitorModules(serviceList, false)
            return process.exit(0)
        })

    program
        .command('tailmonitor')
        .description('Display service logs in split spaces on the screen (follow)')
        .argument('[service]', '(node, database, xchain-hub, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer, all)')
        .argument('[chain]',   '(bitcoin, litecoin, dogecoin, all)')
        .argument('[network]', '(mainnet, testnet, regtest, all)')
        .action(async (service, chain, network) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            await monitorModules(serviceList)
            return process.exit(0)
        })

    program
        .command('exec')
        .description('Execute command on XChain service container')
        .argument('<service>', '(node, database, xchain-hub, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer)')
        .argument('<chain>',   '(bitcoin, litecoin, dogecoin)')
        .argument('<network>', '(mainnet, testnet, regtest)')
        .argument('<command>', 'The shell command to execute')
        .action(async (service, chain, network, command) => {
            const serviceList = filterCommandParameters(null, service, chain, network)
            await execModules(serviceList, command)
            return process.exit(0)
        })

    program
        .command('shell')
        .description('Shell into a XChain service container')
        .argument('<service>', '(node, database, xchain-hub, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-explorer)')
        .argument('<chain>',   '(bitcoin, litecoin, dogecoin)')
        .argument('<network>', '(mainnet, testnet, regtest)')
        .action(async (service, chain, network) => {
            if (service === "all" || chain === "all" || network === "all") {
                console.log("The shell command can't be used for multiple containers, 'all' is invalid")
                return process.exit(0)
            }
            const serviceList = filterCommandParameters(null, service, chain, network)
            await shellModule(serviceList)
            return process.exit(0)
        })

    program
        .command('e2etest')
        .description('Run E2E tests on a regtest network')
        .argument('<chain>', '(bitcoin, litecoin, dogecoin)')
        .argument('[testName]', 'optional test file name (e.g. "order", "issue") — runs only that suite')
        .option('--grep <pattern>', 'only run tests matching this pattern (passed to mocha --grep)')
        .action(async (chain, testName, options) => {
            const { logFile, exitCode } = await runE2ETest(chain, 'regtest', testName, options.grep)
            console.log("E2E tests finished with exit code " + exitCode)
            console.log("Logs saved to: " + logFile)
            // Propagate the suite's real exit code so CI (and run-multichain-e2e.sh)
            // can gate on $? natively instead of scraping the line above.
            return process.exit(exitCode)
        })

    program
        .command('reset')
        .description('Reset data for a specific service or all services of a coin/network')
        .argument('<service>', '(node, xchain-utxo-tracker, xchain-decoder, xchain-indexer, all)')
        .argument('<chain>',   '(bitcoin, litecoin, dogecoin)')
        .argument('<network>', '(mainnet, testnet, regtest)')
        .action(async (service, chain, network) => {
            await resetModules(service, chain, network)
            return process.exit(0)
        })

    program
        .command('rollback')
        .description('Rollback XChain service to a set block_index')
        .argument('<block_index>', 'The index of the last known good block')
        .argument('<service>',     '(xchain-decoder, xchain-utxo-tracker, xchain-indexer, all)')
        .argument('<chain>',       '(bitcoin, litecoin, dogecoin)')
        .argument('<network>',     '(mainnet, testnet, regtest)')
        .action(async () => {
            // coming soon
        })

    program
        .command('bootstrap')
        .description('Create / Restore XChain service bootstraps')
        .argument('<action>',  '(create, restore)')
        .argument('<service>', '(xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-hub)')
        .argument('<chain>',   '(bitcoin, litecoin, dogecoin)')
        .argument('<network>', '(mainnet, testnet, regtest)')
        .addHelpText('after', `
Notes:
    bootstrap create  - generates a bootstrap file
    bootstrap restore - restores a bootstrap file`)
        .action(async (action, service, chain, network) => {
            if (action === "create") {
                await makeBootstrap(chain, network, service)
            } else {
                await restoreBootstrapInterface(chain, network, service)
            }
            return process.exit(0)
        })

    const validator = program
        .command('validator')
        .description('Validator-mode setup for the xchain-hub (key generation + config)')

    validator
        .command('init')
        .description('Generate a validator signing key + config so the hub runs in validator mode')
        .option('--seed-nodes <list>',        'comma-separated peer addresses (host:port,host:port)')
        .option('--p2p-addr <addr>',          'this validator\'s public address (host:port)')
        .option('--p2p-port <port>',          'P2P listen port (default 10001)')
        .option('--oracle-epoch-start <ms>',  'shared oracle epoch start (unix ms) — must match the federation')
        .option('--capabilities <list>',      'enabled capabilities (default price,cross_chain,oracle_publish,attestation)')
        .option('--force',                    'overwrite existing validator config (generates a NEW key)')
        .action(async (opts) => {
            await initValidator(opts)
            return process.exit(0)
        })

    validator
        .command('status')
        .description('Show this node\'s validator configuration (pubkey, peers, capabilities)')
        .action(async () => {
            const s = getValidatorSettings()
            if (!s) {
                console.log(isInitialized()
                    ? 'Validator is initialized but disabled.'
                    : 'No validator configured. Run: xchain-node validator init')
            } else {
                console.log('Validator enabled.')
                console.log('  pubkey       : ' + s.pubkey)
                console.log('  p2p address  : ' + s.P2P_VALIDATOR_ADDR)
                console.log('  seed nodes   : ' + ((s.SEED_NODES || []).join(', ') || '(none)'))
                console.log('  oracle epoch : ' + (s.ORACLE_EPOCH_START || '(unset — required before oracle runs)'))
                console.log('  capabilities : ' + ((s.capabilities || []).join(', ') || '(none)'))
            }
            return process.exit(0)
        })

    program.parse(process.argv)
}

module.exports = { parseCommand }

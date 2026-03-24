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
const { makeBootstrap }        = require('./services/BootstrapService')
const { restoreBootstrapInterface, startInterface } = require('./ui/menu')

async function parseCommand() {
    const program = new Command()

    const commandsNeedingVersions = ['install', 'update', 'reinstall']
    program.hook('preAction', async (thisCommand, actionCommand) => {
        setVerbose(thisCommand.opts().verbose ?? false)
        if (thisCommand.opts().verbose) console.log("Checking xchain-node structure")
        await preCheck(commandsNeedingVersions.includes(actionCommand.name()))
    })

    program
        .name('xchain-node')
        .version(version, '-V, --version', 'Shows xchain-node version')
        .option('-v, --verbose', 'Print precheck progress messages')
        .option('-i, --interactive', 'Interactive mode')
        .option('--no-bootstrap', 'Do not download bootstrap files (full parse)')
        .option('--no-explorer', 'Do not install xchain-explorer')
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
        .action(async (branch, service, chain, network) => {
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
        .action(async (chain) => {
            const { logFile, exitCode } = await runE2ETest(chain, 'regtest')
            console.log("E2E tests finished with exit code " + exitCode)
            console.log("Logs saved to: " + logFile)
            return process.exit(0)
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

    program.parse(process.argv)
}

module.exports = { parseCommand }

// Unit coverage for the ui component
// (src/ui/menu.js). The interactive menu functions are the operator entry
// points; they must load without side effects and expose the expected
// callable surface. The prompts themselves are interactive, so this pins the
// module contract (exports present and callable) rather than driving a TTY.

const assert = require('assert');
const menu = require('../../src/ui/menu.js');
const proxyquire = require('proxyquire').noCallThru();

function load({ files = [], restored = true } = {}) {
    const calls = { restore: [] };
    const bootstrapService = {
        getBootstrapFilesList: async () => files,
        restoreBootstrap: async (coin, network, module, file) => {
            calls.restore.push(file);
            return restored;
        },
        makeBootstrap: async () => true,
    };
    const enquirer = {
        Select: class { run() { throw new Error('the interactive menu must not be reached'); } },
    };
    // restoreBootstrapInterface lives in a part that requires the same modules one
    // directory deeper, so the stubs are keyed for the part and the entry loads that copy.
    const restorePrompt = proxyquire('../../src/ui/menu/restore_bootstrap_prompt.js', {
        '../../services/bootstrap_service': bootstrapService,
        'enquirer': enquirer,
    });
    const mod = proxyquire('../../src/ui/menu.js', {
        '../services/bootstrap_service': bootstrapService,
        'enquirer': enquirer,
        './menu/restore_bootstrap_prompt.js': restorePrompt,
    });
    return { mod, calls };
}

const NEWEST = 'regtest-xchain-utxo-tracker-2026-07-27.tar.gz';
const OLDER  = 'regtest-xchain-utxo-tracker-2026-06-04.tar.gz';

describe('ui/menu', function () {
    const expected = [
        'mainMenu', 'modulesSelectionInterface', 'restoreBootstrapInterface', 'startInterface',
    ];

    for (const name of expected) {
        it(`exports ${name} as a function`, function () {
            assert.strictEqual(typeof menu[name], 'function', `${name} must be a function`);
        });
    }

    it('requiring the module has no throwing side effects', function () {
        // Re-require from a clean cache must not throw (no top-level TTY / prompt work).
        delete require.cache[require.resolve('../../src/ui/menu.js')];
        assert.doesNotThrow(() => require('../../src/ui/menu.js'));
    });
});

// `bootstrap restore` used to route unconditionally into an enquirer Select.
// Driven from a script, or on any non-TTY, that renders a menu nobody can
// answer and the command blocks WHILE HOLDING the mutating-command pidfile
// lock - one restore sat wedged that way for 2.5h and locked out every other
// xchain-node command on the box. These drive the non-interactive resolution
// paths, which is the whole point of the fix; the Select branch stays untested
// here because it needs a TTY.
describe('ui/menu restoreBootstrapInterface non-interactive resolution', function () {
    it('restores the newest archive on --latest without prompting', async function () {
        const { mod, calls } = load({ files: [NEWEST, OLDER] });
        const ok = await mod.restoreBootstrapInterface('bitcoin', 'regtest', 'xchain-utxo-tracker', { latest: true });
        assert.strictEqual(ok, true);
        assert.deepStrictEqual(calls.restore, [NEWEST]);
    });

    it('restores exactly the named archive on --file', async function () {
        const { mod, calls } = load({ files: [NEWEST, OLDER] });
        await mod.restoreBootstrapInterface('bitcoin', 'regtest', 'xchain-utxo-tracker', { file: OLDER });
        assert.deepStrictEqual(calls.restore, [OLDER]);
    });

    it('rejects a --file that is not present instead of silently picking another', async function () {
        const { mod, calls } = load({ files: [NEWEST] });
        await assert.rejects(
            () => mod.restoreBootstrapInterface('bitcoin', 'regtest', 'xchain-utxo-tracker', { file: 'nope.tar.gz' }),
            /not found/);
        assert.deepStrictEqual(calls.restore, []);
    });
});

describe('ui/menu restoreBootstrapInterface non-interactive resolution', function () {

    it('falls back to the newest archive when there is no TTY to prompt on', async function () {
        const saved = process.stdin.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
        try {
            const { mod, calls } = load({ files: [NEWEST, OLDER] });
            await mod.restoreBootstrapInterface('bitcoin', 'regtest', 'xchain-utxo-tracker');
            assert.deepStrictEqual(calls.restore, [NEWEST]);
        } finally {
            Object.defineProperty(process.stdin, 'isTTY', { value: saved, configurable: true });
        }
    });

    it('says so plainly when there is nothing to restore', async function () {
        const { mod } = load({ files: [] });
        await assert.rejects(
            () => mod.restoreBootstrapInterface('bitcoin', 'regtest', 'xchain-utxo-tracker', { latest: true }),
            /No bootstrap archives found/);
    });

    it('surfaces a failed restore as an error rather than a bare false', async function () {
        const { mod } = load({ files: [NEWEST], restored: false });
        await assert.rejects(
            () => mod.restoreBootstrapInterface('bitcoin', 'regtest', 'xchain-utxo-tracker', { latest: true }),
            /restore failed/);
    });
});

// Every per-module action the menu OFFERS must have a handler branch that reads
// the same string. enquirer's Select resolves to a choice's NAME, and three
// labels had drifted from the strings the handler compared against ("Update
// local version" vs "Update locale version", "Update Container" vs "Update
// container version", and "Reinstall" with no branch at all). Selecting any of
// them ran nothing and dropped the operator back to the module list - a silent
// no-op with no error to report. The labels are now shared constants; this binds
// the two sides so a rename cannot re-open the gap on one side only.
describe('ui/menu per-module action labels are all handled', function () {
    const path = require('path');
    const fs   = require('fs');
    const src  = fs.readFileSync(path.join(__dirname, '../../src/ui/menu.js'), 'utf8');

    // The handler chain lives after the choice list; both reference the same
    // constants, so each constant must appear in a comparison against actionAnswer.
    const handlerChain = src.slice(src.indexOf('const actionAnswer'));

    for (const [constName, label] of Object.entries(menu.MODULE_ACTION_LABELS)) {
        it(`${constName} ("${label}") reaches a handler`, function () {
            assert.ok(
                new RegExp('actionAnswer === ' + constName + '\\b').test(handlerChain),
                `${constName} is offered as a menu choice but no handler branches on it, so picking it does nothing`
            );
        });
    }

    // The same property stated over the labels themselves rather than the
    // constants: everything the module-action menu offers must be reachable,
    // whether it is written as a constant or as a plain literal.
    it('every offered per-module action label has a handler branch', function () {
        const choiceBlock = src.slice(src.indexOf('const moduleActions'), src.indexOf('const actionSelect'));

        // "Return" is the go-back branch (and the ESC .catch() default), which is
        // deliberately a no-op body rather than an action.
        const offered = [...choiceBlock.matchAll(/name:\s*(?:"([^"]+)"|([A-Z_]+))/g)]
            .map(m => (m[1] !== undefined ? m[1] : menu.MODULE_ACTION_LABELS[m[2]]))
            .filter(label => label && label !== 'Return');

        assert.ok(offered.length >= 5, 'expected several module actions on offer, found ' + offered.length);

        const handled = new Set([
            ...[...handlerChain.matchAll(/actionAnswer === "([^"]+)"/g)].map(m => m[1]),
            ...[...handlerChain.matchAll(/actionAnswer === ([A-Z_]+)/g)].map(m => menu.MODULE_ACTION_LABELS[m[1]])
        ].filter(Boolean));

        const unhandled = offered.filter(label => !handled.has(label));
        assert.deepStrictEqual(unhandled, [], 'these menu actions do nothing when selected: ' + unhandled.join(', '));
    });
});

// Menu actions mutate the stack like the CLI verbs, so each one holds the command
// lock for its own run and an idle menu holds nothing.
describe('ui/menu mutating actions hold the command lock', function () {
    function loadLocked({ scan = async () => 1, holdError = null } = {}) {
        const events = [];
        const scopedCommandLock = (label) => ({
            hold() { events.push('hold ' + label); if (holdError) throw holdError; },
            release() { events.push('release ' + label); },
        });
        const mod = proxyquire('../../src/ui/menu.js', {
            'enquirer': { Select: class { async run() { return 'Scan already installed modules'; } } },
            '../services/status_service': { getStatus: async () => ({}), statusChanged: async () => events.push('status') },
            '../services/discovery_service': { scanAndRegisterModules: async () => { events.push('scan'); return scan(); } },
            '../cli/dispatch': { scopedCommandLock },
        });
        return { mod, events };
    }

    it('holds the lock around the scan and releases it after', async function () {
        const { mod, events } = loadLocked();
        const next = await mod.mainMenu();
        assert.strictEqual(next.menuFunction, mod.mainMenu);
        const label = 'interactive: scanAndRegisterModules';
        assert.deepStrictEqual(events, ['hold ' + label, 'scan', 'status', 'release ' + label]);
    });

    it('releases the lock when the action throws', async function () {
        const { mod, events } = loadLocked({ scan: async () => { throw new Error('docker gone'); } });
        await mod.mainMenu();
        assert.strictEqual(events[events.length - 1], 'release interactive: scanAndRegisterModules');
    });

    it('skips the action and stays in the menu when another command holds the lock', async function () {
        const held = Object.assign(new Error('Another xchain-node instance holds the command lock'), { code: 'ELOCKHELD' });
        const { mod, events } = loadLocked({ holdError: held });
        const next = await mod.mainMenu();
        assert.strictEqual(next.menuFunction, mod.mainMenu);
        assert.deepStrictEqual(events, ['hold interactive: scanAndRegisterModules']);
    });

    it('never calls a mutating operation bare from a handler', function () {
        const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/ui/menu.js'), 'utf8');
        const handlers = src.slice(src.indexOf('async function runInstalledModuleAction'), src.indexOf('module.exports'));
        const ops = 'installModules|uninstallModules|updateModules|restartModules|installModule|installNode|' +
            'makeBootstrap|restoreBootstrapInterface|runE2ETest|cloneGit|scanAndRegisterModules';
        assert.ok(new RegExp('locked\\.(' + ops + ')\\(').test(handlers), 'expected locked calls in the handlers');
        assert.deepStrictEqual(handlers.match(new RegExp('(?<![.\\w])(' + ops + ')\\(', 'g')), null);
    });
});

// The coin node's remote entry is the GitHub release object (tag_name, no
// version field). Reading ["version"] off it hid the node's remote actions
// for every coin, and Bitcoin's two-part tags (28.1) and Litecoin's four-part
// ones (0.21.5.6) are not semver, so they compare by their numeric parts.
function loadNodeMenu({ localNodeVersion = null, updateModules = async () => ({}) } = {}) {
    const calls = { update: [], clone: [], install: [] };
    const mod = proxyquire('../../src/ui/menu.js', {
        '../services/version_service': {
            getLocalNodeVersion: async () => {
                if (localNodeVersion == null) throw 'No file';
                return localNodeVersion;
            },
            getLocalModuleVersion: async () => '1.0.0',
            getContainerNodeVersion: async () => '0',
            getContainerModuleVersion: async () => '0',
        },
        '../operations/module_operations': {
            installModules: async () => true, uninstallModules: async () => true,
            restartModules: async () => true, logModules: async () => true, runE2ETest: async () => null,
            updateModules: async (list) => { calls.update.push(list); return updateModules(list); },
        },
        '../services/module_service': {
            cloneGit: async (...args) => { calls.clone.push(args); },
            installModule: async (...args) => { calls.install.push(args); },
        },
        '../cli/dispatch': { scopedCommandLock: () => ({ hold() {}, release() {} }) },
    });
    return { mod, calls };
}

const NODE = 'node';
const offered = (actions) => actions.map(a => a.name);

describe('ui/menu coin node remote versions', function () {
    it('reads the node remote version from the release tag_name', async function () {
        const { mod } = loadNodeMenu({ localNodeVersion: 'v1.14.8' });
        const versions = await mod.readModuleVersions(NODE, { 'node-dogecoin': { tag_name: 'v1.14.9', id: 1 } }, 'dogecoin', 'mainnet');
        assert.deepStrictEqual(versions, { remoteVersion: 'v1.14.9', localVersion: 'v1.14.8' });
    });

    it('answers "0" for a node release that has not been looked up yet', async function () {
        const { mod } = loadNodeMenu();
        const versions = await mod.readModuleVersions(NODE, {}, 'bitcoin', 'mainnet');
        assert.deepStrictEqual(versions, { remoteVersion: '0', localVersion: '0' });
        const actions = offered(mod.installedModuleActions('running', NODE, versions.localVersion, versions.remoteVersion, '0'));
        assert.ok(!actions.includes('Update local version') && !actions.includes('Reinstall from remote'), actions.join(', '));
    });

    it('offers an update for each coin whose installed node is behind the release', function () {
        const { mod } = loadNodeMenu();
        const cases = [['28.1\n', 'v31.1'], ['v1.14.8', 'v1.14.9'], ['v0.21.4', 'v0.21.5.6'], ['v0.21.5.5', 'v0.21.5.6']];
        for (const [local, remote] of cases) {
            const actions = offered(mod.installedModuleActions('running', NODE, local, remote, local));
            assert.ok(actions.includes('Update local version'), `${local} -> ${remote}: ${actions.join(', ')}`);
        }
    });

    it('offers a reinstall when the installed node matches the release', function () {
        const { mod } = loadNodeMenu();
        const actions = offered(mod.installedModuleActions('running', NODE, '28.1\n', 'v28.1', '28.1'));
        assert.ok(actions.includes('Reinstall from remote'), actions.join(', '));
        assert.ok(!actions.includes('Update local version'), actions.join(', '));
    });

    it('still compares a module as semver', function () {
        const { mod } = loadNodeMenu();
        const actions = offered(mod.installedModuleActions('running', 'xchain-encoder', '1.0.0', '1.1.0', '1.0.0'));
        assert.ok(actions.includes('Update local version'), actions.join(', '));
        const twoPart = offered(mod.installedModuleActions('running', 'xchain-encoder', '1.0', '1.1', '1.0'));
        assert.ok(!twoPart.includes('Update local version'), twoPart.join(', '));
    });
});

describe('ui/menu coin node remote actions run update, never a clone', function () {
    const selected = { value: NODE, container_id: 'c'.repeat(64), status: 'running' };

    for (const label of ['Update local version', 'Reinstall from remote']) {
        it(`"${label}" on the node runs update node for that coin and network`, async function () {
            const { mod, calls } = loadNodeMenu();
            await mod.runInstalledModuleAction(label, selected, 'bitcoin', 'mainnet');
            assert.deepStrictEqual(calls.update, [{ bitcoin: { mainnet: [NODE] } }]);
            assert.deepStrictEqual(calls.clone, []);
            assert.deepStrictEqual(calls.install, []);
        });
    }

    it('reports a refused node update and stays in the menu', async function () {
        const refusal = new Error('Refusing to update a node while XCHAIN_NODE_DATA_DIR is unset.');
        const { mod } = loadNodeMenu({ updateModules: async () => { throw refusal; } });
        const saved = console.log;
        const lines = [];
        console.log = (...a) => lines.push(a.join(' '));
        try {
            await mod.runInstalledModuleAction('Update local version', selected, 'bitcoin', 'mainnet');
        } finally {
            console.log = saved;
        }
        assert.ok(lines.some(l => l.includes('XCHAIN_NODE_DATA_DIR')), lines.join('\n'));
    });

    it('"Update local version" on a module still clones its source', async function () {
        const { mod, calls } = loadNodeMenu();
        await mod.runInstalledModuleAction('Update local version', { value: 'xchain-encoder' }, 'bitcoin', 'mainnet');
        assert.deepStrictEqual(calls.clone, [['xchain-encoder', true, false]]);
        assert.deepStrictEqual(calls.update, []);
    });
});

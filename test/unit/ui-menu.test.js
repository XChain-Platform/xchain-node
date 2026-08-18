// The interactive menu functions (src/ui/menu.js) are the operator entry
// points; they must load without side effects and expose the expected
// callable surface. The prompts themselves are interactive, so this pins the
// module contract (exports present and callable) rather than driving a TTY.

const assert = require('assert');
const menu = require('../../src/ui/menu.js');

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
    const proxyquire = require('proxyquire').noCallThru();

    function load({ files = [], restored = true } = {}) {
        const calls = { restore: [] };
        const mod = proxyquire('../../src/ui/menu.js', {
            '../services/BootstrapService': {
                getBootstrapFilesList: async () => files,
                restoreBootstrap: async (coin, network, module, file) => {
                    calls.restore.push(file);
                    return restored;
                },
                makeBootstrap: async () => true,
            },
            'enquirer': {
                Select: class { run() { throw new Error('the interactive menu must not be reached'); } },
            },
        });
        return { mod, calls };
    }

    const NEWEST = 'regtest-xchain-utxo-tracker-2026-07-27.tar.gz';
    const OLDER  = 'regtest-xchain-utxo-tracker-2026-06-04.tar.gz';

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
    const fs   = require('fs');
    const path = require('path');
    const src  = fs.readFileSync(path.resolve(__dirname, '../../src/ui/menu.js'), 'utf8');

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

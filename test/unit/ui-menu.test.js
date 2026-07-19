//  doctrine test-coverage program: unit coverage for the ui component
// (src/ui/menu.js). The interactive menu functions are the operator entry
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

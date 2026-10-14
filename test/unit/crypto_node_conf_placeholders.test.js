// Guards : the bundled crypto-node conf files must ship placeholder
// credential tokens, never a literal weak default ('rpc') or a real generated
// credential accidentally written back into the repo by buildCryptoNode's
// in-place substitution (NodeService injects the provisioned creds at build).
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const cryptoNodesDir = path.join(__dirname, '../../crypto_nodes')

// Kaspa family: kaspad's local RPC has no rpcuser/rpcpassword (neither appears in args.rs),
// so its conf cannot carry placeholders. This test exists to forbid leaked credentials, and for
// Kaspa it asserts the opposite: no credential line may appear anywhere in the file.
const CREDENTIAL_FREE_COINS = ['kaspa']

function listConfFiles() {
    const files = []
    for (const coin of fs.readdirSync(cryptoNodesDir)) {
        const dir = path.join(cryptoNodesDir, coin)
        if (!fs.statSync(dir).isDirectory()) continue
        for (const f of fs.readdirSync(dir)) {
            // The build writes the credential-bearing copy as a gitignored
            // `<coin>-<network>.generated.conf` sibling (stageBuildScaffold);
            // only the tracked templates are under test here.
            if (f.endsWith('.generated.conf')) continue
            if (f.endsWith('.conf')) files.push(path.join(dir, f))
        }
    }
    return files
}

describe('bundled crypto-node conf files', function () {
    it('finds conf files for every coin/network combo', function () {
        assert.ok(listConfFiles().length >= 9, 'expected at least 9 bundled conf files')
    })

    it('every rpcuser/rpcpassword line carries the placeholder token, not a literal credential', function () {
        for (const file of listConfFiles()) {
            const content = fs.readFileSync(file, 'utf8')
            const userLine = content.match(/^rpcuser=(.*)$/m)
            const passLine = content.match(/^rpcpassword=(.*)$/m)
            // credential-free family (kaspad's local RPC takes no user/password): the assertion is reversed - no credential line may appear
            if (CREDENTIAL_FREE_COINS.some((coin) => file.includes(path.sep + coin + path.sep))) {
                assert.strictEqual(userLine, null, `${file}: no rpcuser line may appear for this family`)
                assert.strictEqual(passLine, null, `${file}: no rpcpassword line may appear for this family`)
                continue
            }
            assert.ok(userLine, `${file}: missing rpcuser line (substitution anchor)`)
            assert.ok(passLine, `${file}: missing rpcpassword line (substitution anchor)`)
            assert.strictEqual(userLine[1], '__XCHAIN_NODE_RPC_USER__',
                `${file}: rpcuser must be the placeholder token, got '${userLine[1]}'`)
            assert.strictEqual(passLine[1], '__XCHAIN_NODE_RPC_PASSWORD__',
                `${file}: rpcpassword must be the placeholder token, got '${passLine[1]}'`)
        }
    })
})

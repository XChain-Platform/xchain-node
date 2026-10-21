# Audit exceptions

`npm audit` findings that are known, judged, and deliberately not acted on.

The audit workflow (`.github/workflows/audit.yml`) runs `bin/audit_gate.js`,
which fails on any **high or critical advisory in production dependencies**
unless a level-two heading below names its GHSA id. The triage convention is
"bump / override / replace, or a documented accept-with-justification", and
this file is where the last option is written down. An entry here is a record
of the reasoning, not a dismissal of the finding, so the next person to see a
red audit line does not re-derive it or "fix" it by taking advice that makes
things worse.

Each entry states what would change the verdict. Review it when that changes,
not on a calendar.

---

## `elliptic` - CVE-2025-14505 / GHSA-848j-6mx2-7j84

**Verdict: accepted. Installed and loaded, but its faulty signatures never
leave the process, and xchain-node's own code never signs a message through
it.**

Recorded 2026-10-21. npm rates it **high** (CVSS 3.1 5.6) in this tree, so
without this entry the gate is red.

### What the flaw is

ECDSA **signature generation**: the byte length of the RFC 6979 nonce `k` is
computed incorrectly, so a `k` whose interim value carries leading zeros is
truncated. An attacker holding BOTH a faulty signature from a vulnerable
version AND a correct signature over identical input can derive the private
key. The plainer consequence is that a truncated nonce produces an incorrect
signature.

### How it gets into this tree

```
@dankest-llc/xchain-sdk
  -> bitcoinjs-message   (overridden to npm:@oipwg/bitcoinjs-message@2.2.0-beta.0)
    -> secp256k1         (overridden to npm:@exodus/secp256k1@5.0.0-exodus.4.patch.2)
      -> elliptic@6.6.1
```

Both aliases come from the `overrides` block in `package.json`. This is not
the xchain-sdk chain (`bitcoinjs-message@2.2.0 -> secp256k1@3`), so the sdk's
entry for the same advisory does not carry over: the reasoning differs.

### What actually runs

Measured in a fresh `npm ci` checkout on Node 22, 2026-10-21:

- `@exodus/secp256k1`'s entry point tries `./bitcoinerlab` first and falls
  back to `./elliptic` only if that throws. The bitcoinerlab path loads, so
  the primary implementation is `@exodus/bitcoinerlab-secp256k1`, which wraps
  `@noble/secp256k1` (pure JS, no native build to fail).
- `elliptic` is still loaded: `lib/bitcoinerlab.js` requires it as a backup
  for the operations noble does not cover.
- `ecdsaSign` without a custom nonce function signs with noble, and the
  signature it returns is noble's. Only the lazy `recid` getter re-runs
  `elliptic.ecdsaSign` over the same message and key, and keeps nothing from
  that run but the one-bit recovery id. `bitcoinjs-message` passes no nonce
  function, so this is the path its `sign()` takes.

So the vulnerable nonce code does run when a message is signed, but the
faulty signature it may compute is discarded; the attacker never sees it,
and the key-recovery attack needs exactly that signature.

### Who calls it

`git grep -n -E "signMessage|bitcoinjs-message|x402" -- src` in this repo
finds no caller: xchain-node's own code never signs a Bitcoin message. The
chain is present because xchain-sdk depends on it for its auth and x402
helpers, which xchain-node does not use.

### Why it is accepted rather than fixed

- No patched `elliptic` exists: 6.6.1 is the newest release and the advisory
  covers every version.
- `@exodus/secp256k1` declares `elliptic ^6.5.2`, so an override cannot move
  it out of the vulnerable range.
- **Do not run `npm audit fix --force`.** It proposes replacing the
  message-signing library with an older major. A downgrade of a signing
  library is a larger risk than this advisory.

### Tripwire

If a recovered recovery id were wrong, a message signature would fail to
verify at a low, content-independent rate. Intermittent signature failures
from any code that does start signing messages here should be checked
against this entry first.

### What would change the verdict

Any one of:

- a patched `elliptic` release appears (then override to it);
- `@exodus/secp256k1` or `@oipwg/bitcoinjs-message` publishes a version that
  drops `elliptic`;
- the bitcoinerlab path fails to load on a supported runtime, which would make
  `elliptic` the primary signer and its faulty signatures visible;
- xchain-node code starts signing messages through the sdk;
- the advisory is re-rated to critical, or its EPSS moves materially.

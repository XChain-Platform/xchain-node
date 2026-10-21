# Audit exceptions

Accepted high or critical advisories in the production dependency tree.

## GHSA-848j-6mx2-7j84 elliptic

- Package: elliptic, reached through secp256k1 and bitcoinjs-message from the XChain SDK
- Reason: fixture entry used to exercise the audit gate
- Review: fixture only, not a real acceptance

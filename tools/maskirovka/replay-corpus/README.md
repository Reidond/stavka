# Maskirovka replay corpus

This directory is the checked-in, network-free corpus used by `pnpm eval -- --replay`.
Fixtures are keyed by Maskirovka's canonical request hash and must be reviewed like
source code. The eval command only reads this directory; it never records a missing
fixture or invokes a model seat.

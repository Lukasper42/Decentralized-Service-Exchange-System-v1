/** Official SLIP-0010 Ed25519 test vector 1 (seed 000102030405060708090a0b0c0d0e0f), transcribed from the SLIP-0010 document. */
export const SLIP10_SEED_HEX = '000102030405060708090a0b0c0d0e0f';
export const SLIP10_VECTOR_1 = [
  { path: 'm', chainCode: '90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb', key: '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7' },
  { path: "m/0'", chainCode: '8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69', key: '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3' },
] as const;
/** Official BIP39 vector 1: all-zero 128-bit entropy, passphrase TREZOR. */
export const BIP39_TREZOR_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const BIP39_TREZOR_SEED_HEX = 'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04';

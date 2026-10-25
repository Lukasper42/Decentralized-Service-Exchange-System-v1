# BIP39 English wordlist (not vendored here)

`bip39-english.txt` must be the canonical file from the BIP39 repository (`bip-0039/english.txt`): 2048 lowercase
words, one per line, LF endings, trailing newline. The loader refuses any file whose SHA-256 differs from
`EXPECTED_WORDLIST_SHA256` in `src/bip39.ts`.

1. Download the file on a machine with normal internet access.
2. Check it: `sha256sum english.txt`. The pinned constant in the source was written from memory and is UNVERIFIED;
   if your digest differs, confirm against a second trusted copy and then update the constant (and nothing else).
3. Save it as `packages/keystore/data/bip39-english.txt`.
4. Run `npm test`: the test "vendored wordlist" then checks the digest, 2048 sorted words and the official all-zero
   entropy vector (eleven times "abandon" followed by "about").

# Moderation: options (UNDECIDED, nothing implemented)

The frozen protocol has 27 event types and none for platform moderation. Choose one before any code is written:

- **(a) No platform moderation.** Disputes only via the jury; operators may refuse to host blobs locally. No protocol change.
- **(b) Report + jury review.** New event types (report, review verdict) and a jury flow; requires a protocol revision.
- **(c) Multisig takedown list.** A policy-multisig-signed list of content hashes that honest nodes stop serving; one new signed artifact type.

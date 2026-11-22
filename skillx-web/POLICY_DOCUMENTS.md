# Serverless relay policy documents

The Vercel relay resolves PolicyUpdated documents from the optional
SKILLX_POLICY_DOCUMENTS_JSON environment variable. The value must be a JSON
object whose keys are the lowercase 64-character policyParamsHash values and
whose values are the corresponding complete PolicyParams objects.

Example shape (replace the illustrative key and fields with a real policy):

    {
      "<64-character-policyParamsHash>": {
        "version": 2,
        "policyId": "example"
      }
    }

The example above is only a shape illustration; it is not a valid complete
SkillX policy. Generate the key with the repository's policyParamsHash
function and include every field required by validatePolicyParams.

The manifest is optional when no PolicyUpdated event needs an external
document. It is limited to 48 KiB; each individual document is limited to
32 KiB. Documents are immutable for a deployment: changing the environment
value requires a new Vercel deployment. On replay, the relay validates each
document and verifies that its canonical policy hash exactly matches the hash
requested by the ledger. Missing, malformed, unsafe, oversized, or hash-mismatched
documents are rejected; the relay does not silently substitute another policy.

Do not put private keys, credentials, or other secrets in this manifest.
Policy documents are public consensus inputs, not secrets.


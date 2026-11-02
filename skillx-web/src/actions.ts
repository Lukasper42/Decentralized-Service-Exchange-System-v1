import type { ClockPort, CryptoPort, RandomPort, StoragePort } from './ports.js';
import type { Pubkey, Result, SignedEvent } from './types.js';
import { err, ok } from './types.js';
import { signEventWithKey, signAttestationWithKey, verifyAttestation } from './crypto.js';
import {
  consentBodyOfDeal,
  deriveDeals,
  deriveOpenJuryCases,
  findDealForConsent,
} from './project.js';
import {
  buildAccountCreatedPayload,
  buildDealCreatedPayload,
  removeDealSecret,
  saveDealSecret,
} from './create-actions.js';
import type { DealInput } from './create-actions.js';
import type { ChainVerifier } from './verify.js';
import type { RelayClient } from './relay-client.js';
import { validatePostReceipt } from './relay-client.js';

export interface ActionContext {
  crypto: CryptoPort;
  clock: ClockPort;
  client: RelayClient;
  verifier: ChainVerifier;
  relayPubkey: Pubkey;
  ownPubkey: Pubkey;
  signingKey: CryptoKey | null;
  readOnly: boolean;
  transportError: boolean;
}

export type ActionResult = Result<SignedEvent>;

function preconditionFail(message: string, path: string): ActionResult {
  return err('STATE', message, path);
}

async function buildAndSend(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  type: SignedEvent['type'],
): Promise<ActionResult> {
  if (!ctx.signingKey) {
    return err('SIGNING', 'No unlocked key available', '$.action.key');
  }
  if (ctx.verifier.isBroken) {
    return preconditionFail('Chain is broken, actions blocked', '$.action.verifier');
  }
  if (ctx.readOnly) {
    return err('READ_ONLY', 'Relay currently accepts no writes', '$.action');
  }
  if (ctx.transportError) {
    return preconditionFail('Network error, actions blocked', '$.action.network');
  }
  const tipRes = await ctx.client.signerTip(ctx.ownPubkey);
  if (!tipRes.ok) {
    return { ok: false, error: tipRes.error };
  }
  const unsigned: Omit<SignedEvent, 'signature'> = {
    type,
    version: 1,
    payload,
    signer: ctx.ownPubkey,
    timestamp: ctx.clock.nowIso(),
    prevHash: tipRes.value.tip,
  };
  let event: SignedEvent;
  try {
    event = await signEventWithKey(ctx.crypto, ctx.signingKey, unsigned);
  } catch {
    return err('SIGNING', 'Signing failed', '$.event.signature');
  }
  const post = await ctx.client.postEvent(event);
  if (!post.ok) {
    return { ok: false, error: post.error };
  }
  const validated = await validatePostReceipt(
    ctx.crypto,
    ctx.relayPubkey,
    event,
    post.value.receipt,
  );
  if (!validated.ok) {
    return validated;
  }
  return ok(event);
}

export async function consentDeal(
  ctx: ActionContext,
  dealId: string,
): Promise<ActionResult> {
  const entries = ctx.verifier.getEntries();
  const deal = findDealForConsent(entries, dealId);
  if (!deal) {
    return preconditionFail('Deal not found in the verified chain', '$.action.deal');
  }
  if (deal.seller !== ctx.ownPubkey) {
    return preconditionFail('Only the seller can consent', '$.action.role');
  }
  const view = deriveDeals(entries).get(dealId);
  const state = view ? view.state : 'unknown';
  if (state !== 'created') {
    return preconditionFail(`State "${state}" does not allow consent`, '$.action.state');
  }
  const body = consentBodyOfDeal(deal);
  const sigRes = await makeAttestation(ctx, 'deal-consent', body);
  if (!sigRes.ok) {
    return sigRes;
  }
  const payload: Record<string, unknown> = {
    deal_id: dealId,
    seller: ctx.ownPubkey,
    consent_sig: sigRes.value,
  };
  return buildAndSend(ctx, payload, 'DealConsented');
}

export async function createAccount(ctx: ActionContext): Promise<ActionResult> {
  const built = await buildAccountCreatedPayload(
    ctx.crypto,
    ctx.verifier.getEntries(),
    ctx.ownPubkey,
  );
  if (!built.ok) {
    return { ok: false, error: built.error };
  }
  return buildAndSend(ctx, built.value, 'AccountCreated');
}

export interface CreateDealDeps {
  random: RandomPort;
  storage: StoragePort;
}

/** Errors that happen before anything left this browser: the stored salt is not needed then. */
const PRE_SEND_ERRORS: readonly string[] = ['SIGNING', 'STATE', 'READ_ONLY'];

export async function createDeal(
  ctx: ActionContext,
  deps: CreateDealDeps,
  input: DealInput,
): Promise<ActionResult> {
  const built = await buildDealCreatedPayload(
    { crypto: ctx.crypto, random: deps.random, clock: ctx.clock },
    ctx.verifier.getEntries(),
    ctx.ownPubkey,
    input,
  );
  if (!built.ok) {
    return { ok: false, error: built.error };
  }
  const { payload, secret } = built.value;
  // The salt must be stored before sending: it cannot be recomputed and is needed for a later reveal.
  const saved = saveDealSecret(deps.storage, secret);
  if (!saved.ok) {
    return { ok: false, error: saved.error };
  }
  const sent = await buildAndSend(ctx, payload, 'DealCreated');
  if (!sent.ok && PRE_SEND_ERRORS.includes(sent.error.code)) {
    // Any other failure may still mean the relay accepted the event, so the secret stays.
    removeDealSecret(deps.storage, secret.deal_id);
  }
  return sent;
}

export async function castVote(
  ctx: ActionContext,
  dealId: string,
  vote: 'buyer' | 'seller',
): Promise<ActionResult> {
  const entries = ctx.verifier.getEntries();
  const cases = deriveOpenJuryCases(entries, ctx.ownPubkey);
  const openCase = cases.find((c) => c.deal_id === dealId && !c.voted);
  if (!openCase) {
    return preconditionFail('No open jury case without a vote', '$.action.jury');
  }
  const body: Record<string, unknown> = {
    deal_id: dealId,
    juror: ctx.ownPubkey,
    vote,
    appeal_round: openCase.appeal_round,
  };
  const sigRes = await makeAttestation(ctx, 'jury-vote', body);
  if (!sigRes.ok) {
    return sigRes;
  }
  const payload: Record<string, unknown> = {
    deal_id: dealId,
    juror: ctx.ownPubkey,
    vote,
    appeal_round: openCase.appeal_round,
    sig: sigRes.value,
  };
  return buildAndSend(ctx, payload, 'JuryVoted');
}

async function makeAttestation(
  ctx: ActionContext,
  kind: 'deal-consent' | 'jury-vote',
  body: Record<string, unknown>,
): Promise<Result<string>> {
  if (!ctx.signingKey) {
    return err('SIGNING', 'No unlocked key', '$.attestation.key');
  }
  try {
    const sig = await signAttestationWithKey(ctx.crypto, ctx.signingKey, kind, body);
    const verified = await verifyAttestation(ctx.crypto, ctx.ownPubkey, kind, body, sig);
    if (!verified) {
      return err('SIGNING', 'Attestation not self-verifiable', '$.attestation.verify');
    }
    return ok(sig);
  } catch {
    return err('SIGNING', 'Attestation failed', '$.attestation');
  }
}

import type { ClockPort, CryptoPort } from './ports.js';
import type { Pubkey, Result, SignedEvent } from './types.js';
import { err, ok } from './types.js';
import { signEventWithKey, signAttestationWithKey, verifyAttestation } from './crypto.js';
import {
  consentBodyOfDeal,
  deriveDeals,
  deriveOpenJuryCases,
  findDealForConsent,
} from './project.js';
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
    return err('SIGNING', 'Kein entsperrter Schlüssel vorhanden', '$.action.key');
  }
  if (ctx.verifier.isBroken) {
    return preconditionFail('Kette ist gebrochen, Aktionen gesperrt', '$.action.verifier');
  }
  if (ctx.readOnly) {
    return err('READ_ONLY', 'Relay akzeptiert derzeit keine Schreibvorgänge', '$.action');
  }
  if (ctx.transportError) {
    return preconditionFail('Netzwerkfehler, Aktionen gesperrt', '$.action.network');
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
    return err('SIGNING', 'Signierung fehlgeschlagen', '$.event.signature');
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
    return preconditionFail('Deal nicht in der verifizierten Kette gefunden', '$.action.deal');
  }
  if (deal.seller !== ctx.ownPubkey) {
    return preconditionFail('Nur der Verkäufer kann zustimmen', '$.action.role');
  }
  const view = deriveDeals(entries).get(dealId);
  const state = view ? view.state : 'unbekannt';
  if (state !== 'angelegt') {
    return preconditionFail(`Zustand "${state}" erlaubt kein Zustimmen`, '$.action.state');
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

export async function castVote(
  ctx: ActionContext,
  dealId: string,
  vote: 'buyer' | 'seller',
): Promise<ActionResult> {
  const entries = ctx.verifier.getEntries();
  const cases = deriveOpenJuryCases(entries, ctx.ownPubkey);
  const openCase = cases.find((c) => c.deal_id === dealId && !c.voted);
  if (!openCase) {
    return preconditionFail('Kein offener, unabgestimmter Jury-Fall', '$.action.jury');
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
    return err('SIGNING', 'Kein entsperrter Schlüssel', '$.attestation.key');
  }
  try {
    const sig = await signAttestationWithKey(ctx.crypto, ctx.signingKey, kind, body);
    const verified = await verifyAttestation(ctx.crypto, ctx.ownPubkey, kind, body, sig);
    if (!verified) {
      return err('SIGNING', 'Attestation selbst nicht verifizierbar', '$.attestation.verify');
    }
    return ok(sig);
  } catch {
    return err('SIGNING', 'Attestation fehlgeschlagen', '$.attestation');
  }
}

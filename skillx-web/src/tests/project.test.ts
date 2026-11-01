import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveDeals,
  deriveAccountTotals,
  deriveOpenJuryCases,
  deriveKeyStatus,
} from '../project.js';
import type { EventType, LedgerEntry, SignedEvent } from '../types.js';

const A = 'A'.repeat(44);
const B = 'B'.repeat(44);
const J1 = 'C'.repeat(44);
const J2 = 'D'.repeat(44);
const H64 = '0'.repeat(64);

function entry(seq: number, type: EventType, payload: Record<string, unknown>): LedgerEntry {
  const event: SignedEvent = {
    type,
    version: 1,
    payload,
    signer: A,
    timestamp: '2026-01-01T00:00:00.000Z',
    prevHash: null,
    signature: 'x',
  };
  return {
    event,
    receipt: {
      sequence: seq,
      eventHash: H64,
      previousReceiptHash: null,
      acceptedAt: '2026-01-01T00:00:00.000Z',
      keyId: H64,
      signature: 'y',
    },
  };
}

test('deal state machine', () => {
  const deals = deriveDeals([
    entry(1, 'DealCreated', {
      deal_id: 'd',
      buyer: A,
      seller: B,
      amount: 10,
      criteria_hash: H64,
      deadline: '2026-02-01T00:00:00.000Z',
    }),
    entry(2, 'EscrowFunded', { deal_id: 'd', from: A, amount: 10 }),
    entry(3, 'DeliverableSubmitted', { deal_id: 'd', by: B, artifact_hash: H64 }),
    entry(4, 'DealAccepted', { deal_id: 'd', by: B }),
  ]);
  assert.equal(deals.get('d')?.state, 'accepted');
  assert.equal(deals.get('d')?.amount, 10);
  assert.equal(deals.get('d')?.seller, B);

  const expired = deriveDeals([
    entry(1, 'DealCreated', {
      deal_id: 'd',
      buyer: A,
      seller: B,
      amount: 10,
      criteria_hash: H64,
      deadline: '2026-02-01T00:00:00.000Z',
    }),
    entry(2, 'DealExpired', { deal_id: 'd' }),
  ]);
  assert.equal(expired.get('d')?.state, 'expired');
});

test('DealCreated: amount outside AMOUNT_MIN..AMOUNT_MAX is discarded', () => {
  const amountMax = Math.floor(Number.MAX_SAFE_INTEGER / 10000);
  const derive = (amount: number) =>
    deriveDeals([
      entry(1, 'DealCreated', {
        deal_id: 'd',
        buyer: A,
        seller: B,
        amount,
        criteria_hash: H64,
        deadline: '2026-02-01T00:00:00.000Z',
      }),
    ]);
  assert.equal(derive(0).has('d'), false);
  assert.equal(derive(1).has('d'), false);
  assert.equal(derive(amountMax + 1).has('d'), false);
  assert.equal(derive(2).get('d')?.amount, 2);
  assert.equal(derive(amountMax).get('d')?.amount, amountMax);
});

test('account totals incl. reputation', () => {
  const t = deriveAccountTotals(
    [
      entry(1, 'CurrencyIssued', { recipient: A, amount: 100 }),
      entry(2, 'TreasurySpend', { recipient: A, amount: 5 }),
      entry(3, 'EscrowFunded', { deal_id: 'd', from: A, amount: 40 }),
      entry(4, 'EscrowReleased', { deal_id: 'd', to: A, amount: 40 }),
      entry(5, 'AppealOpened', { deal_id: 'd', by: A, fee_amount: 3, reason_hash: H64 }),
      entry(6, 'ReputationEvent', { account: A, counterparty: B, deal_id: 'd', delta: 1 }),
      entry(7, 'ReputationEvent', { account: A, counterparty: B, deal_id: 'd', delta: -1 }),
      entry(8, 'CurrencyIssued', { recipient: B, amount: 999 }),
    ],
    A,
  );
  assert.equal(t.amounts.received_issued, 100);
  assert.equal(t.amounts.received_treasury, 5);
  assert.equal(t.amounts.deposited_escrow, 40);
  assert.equal(t.amounts.received_escrow, 40);
  assert.equal(t.amounts.appeal_fees, 3);
  assert.equal(t.reputation, 0);
});

test('open jury cases incl. JurorReplaced and DisputeResolved', () => {
  const cases = deriveOpenJuryCases(
    [
      entry(1, 'JuryAssigned', { deal_id: 'd', jurors: [J1, J2], appeal_round: 0 }),
      entry(2, 'JurorReplaced', {
        deal_id: 'd',
        appeal_round: 0,
        missing_juror: J1,
        replacement: A,
      }),
    ],
    A,
  );
  assert.equal(cases.length, 1);
  assert.equal(cases[0]?.voted, false);
  assert.equal(cases[0]?.deal_id, 'd');

  const voted = deriveOpenJuryCases(
    [
      entry(1, 'JuryAssigned', { deal_id: 'd', jurors: [A], appeal_round: 0 }),
      entry(2, 'JuryVoted', { deal_id: 'd', juror: A, vote: 'buyer', appeal_round: 0, sig: 'z' }),
    ],
    A,
  );
  assert.equal(voted.length, 1);
  assert.equal(voted[0]?.voted, true);

  const resolved = deriveOpenJuryCases(
    [
      entry(1, 'JuryAssigned', { deal_id: 'd', jurors: [A], appeal_round: 0 }),
      entry(2, 'DisputeResolved', { deal_id: 'd', outcome: 'buyer', appeal_round: 0 }),
    ],
    A,
  );
  assert.equal(resolved.length, 0);

  const removed = deriveOpenJuryCases(
    [
      entry(1, 'JuryAssigned', { deal_id: 'd', jurors: [A], appeal_round: 0 }),
      entry(2, 'JurorReplaced', {
        deal_id: 'd',
        appeal_round: 0,
        missing_juror: A,
        replacement: J1,
      }),
    ],
    A,
  );
  assert.equal(removed.length, 0);
});

test('key status active / rotated / unknown', () => {
  const entries = [
    entry(1, 'AccountCreated', { pubkey: A }),
    entry(2, 'AccountCreated', { pubkey: B }),
    entry(3, 'KeyRotated', {
      old_pubkey: B,
      new_pubkey: J1,
      recovery_pubkey: J2,
      new_recovery_commitment: H64,
      sig: 'z',
    }),
  ];
  assert.equal(deriveKeyStatus(entries, A), 'active');
  assert.equal(deriveKeyStatus(entries, B), 'rotated');
  assert.equal(deriveKeyStatus(entries, J1), 'unknown');
});

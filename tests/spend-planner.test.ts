/**
 * spend-planner.test.ts — Golden parity test fixtures for production-matching spend planning.
 *
 * Each fixture defines a deterministic UTXO set, fee rate, and expected output.
 * These can be verified against production tetherto/wdk-wallet-btc _planSpend()
 * and getMaxSpendable() by running the same inputs through that codebase.
 *
 * Production functions mirrored:
 *   _planSpend()      → planSpend()
 *   getMaxSpendable() → planMaxSpendable()
 *
 * Run: npx ts-node tests/spend-planner.test.ts
 *   or: node -e "require('./tests/spend-planner.test.js')"
 */

import { planSpend, planMaxSpendable, dustLimitForAddress, MIN_TX_FEE_SATS, MAX_UTXO_INPUTS } from '../src/spend-planner.js';
import type { UTXO } from '../src/types.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeUtxo(value: number, index: number = 0): UTXO {
  return {
    txid: `${'a'.repeat(63)}${index.toString(16).padStart(1, '0')}`,
    vout: 0,
    value,
    scriptPubKey: '0014' + '00'.repeat(20), // P2WPKH dummy
    address: 'bc1qtest',
  };
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${name}`);
  } else {
    failed++;
    console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function assertThrows(fn: () => void, expectedMsg: string, name: string) {
  try {
    fn();
    failed++;
    console.log(`  FAIL: ${name} — expected throw but succeeded`);
  } catch (e: any) {
    if (e.message.includes(expectedMsg)) {
      passed++;
      console.log(`  PASS: ${name}`);
    } else {
      failed++;
      console.log(`  FAIL: ${name} — wrong error: "${e.message}" (expected "${expectedMsg}")`);
    }
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

console.log('\n=== planSpend() Golden Parity Fixtures ===\n');

// ── Fixture 1: Exact/no-change case (P2WPKH) ──
console.log('Fixture 1: Exact/no-change case (P2WPKH sender)');
{
  // 1 input of 10000 sats, sending 9859 at 1 sat/vB
  // vsize(1in, 1out) = 11 + 68 + 34 = 113 → fee = max(113, 141) = 141
  // Remainder = 10000 - 9859 - 141 = 0 → no change → avoidChange succeeds
  const utxos = [makeUtxo(10000, 0)];
  const plan = planSpend(utxos, 'bc1qtest', 'bc1qdest', 9859, 1);
  assert(plan.utxos.length === 1, 'selects 1 input');
  assert(plan.changeValue === 0, 'no change output');
  assert(plan.fee >= MIN_TX_FEE_SATS, `fee >= ${MIN_TX_FEE_SATS} (got ${plan.fee})`);
  assert(plan.fee === 10000 - 9859, `fee = remainder (got ${plan.fee})`);
}

// ── Fixture 2: Change output case (P2WPKH) ──
console.log('\nFixture 2: Change output case (P2WPKH sender)');
{
  // 1 input of 100000 sats, sending 50000 at 2 sat/vB
  // vsize(1in, 2out) = 11 + 68 + 68 = 147 → fee = 294
  // change = 100000 - 50000 - 294 = 49706 > dust(294) → change output
  const utxos = [makeUtxo(100000, 0)];
  const plan = planSpend(utxos, 'bc1qtest', 'bc1qdest', 50000, 2);
  assert(plan.utxos.length === 1, 'selects 1 input');
  assert(plan.changeValue > 0, `change > 0 (got ${plan.changeValue})`);
  assert(plan.changeValue === 100000 - 50000 - plan.fee, `change = total - amount - fee (got ${plan.changeValue})`);
}

// ── Fixture 3: Sub-dust change absorbed into fee ──
console.log('\nFixture 3: Sub-dust change absorbed into fee (P2WPKH)');
{
  // 1 input of 10000, feeRate=2
  // avoidChange: vsize(1in, 1out) = 113, fee = max(226, 141) = 226
  // Send 9574 → remainder = 10000 - 9574 - 226 = 200 ≤ 294 dust → avoidChange absorbs
  const utxos = [makeUtxo(10000, 0)];
  const plan = planSpend(utxos, 'bc1qtest', 'bc1qdest', 9574, 2);
  assert(plan.changeValue === 0, 'sub-dust change absorbed');
  assert(plan.fee === 10000 - 9574, `fee absorbs remainder: ${plan.fee}`);
}

// ── Fixture 4: Insufficient funds ──
console.log('\nFixture 4: Insufficient funds');
{
  const utxos = [makeUtxo(500, 0)];
  assertThrows(
    () => planSpend(utxos, 'bc1qtest', 'bc1qdest', 10000, 1),
    'Insufficient balance',
    'throws on insufficient funds',
  );
}

// ── Fixture 5: Amount below dust limit ──
console.log('\nFixture 5: Amount below dust limit');
{
  const utxos = [makeUtxo(100000, 0)];
  assertThrows(
    () => planSpend(utxos, 'bc1qtest', 'bc1qdest', 200, 1),
    'dust limit',
    'throws on sub-dust amount (P2WPKH dust = 294)',
  );
}

// ── Fixture 6: MAX_UTXO_INPUTS limit ──
console.log('\nFixture 6: MAX_UTXO_INPUTS limit behavior');
{
  // Create 250 UTXOs, each 1000 sats. Only 200 should be used.
  const utxos = Array.from({ length: 250 }, (_, i) => makeUtxo(1000, i));
  const plan = planSpend(utxos, 'bc1qtest', 'bc1qdest', 50000, 1);
  assert(plan.utxos.length <= MAX_UTXO_INPUTS, `selected ≤ ${MAX_UTXO_INPUTS} inputs (got ${plan.utxos.length})`);
}

// ── Fixture 7: P2PKH sender (legacy) ──
console.log('\nFixture 7: P2PKH sender (legacy, dust=546, inputVbytes=148)');
{
  // P2PKH: input = 148 vB, dust = 546
  // vsize(1in, 1out) = 11 + 148 + 34 = 193 → fee = 193 at 1 sat/vB
  const utxos = [makeUtxo(100000, 0)];
  const plan = planSpend(utxos, 'mlegacytest', 'mlegacydest', 50000, 1);
  assert(plan.utxos.length === 1, 'selects 1 input');
  // P2PKH fee should be higher than P2WPKH due to larger input size
  assert(plan.fee >= 193, `fee >= 193 for P2PKH (got ${plan.fee})`);
  assert(dustLimitForAddress('mlegacytest') === 546, 'dust limit = 546 for P2PKH');
}

// ── Fixture 8: Multiple inputs selected ──
console.log('\nFixture 8: Multiple inputs selected');
{
  // 3 UTXOs: 3000, 4000, 5000 — need 10000 → must use all 3
  const utxos = [makeUtxo(3000, 0), makeUtxo(4000, 1), makeUtxo(5000, 2)];
  const plan = planSpend(utxos, 'bc1qtest', 'bc1qdest', 10000, 1);
  assert(plan.utxos.length >= 2, `selected ${plan.utxos.length} inputs`);
  const totalIn = plan.utxos.reduce((s, u) => s + u.value, 0);
  assert(totalIn >= 10000 + plan.fee, 'total input covers amount + fee');
}

// ── Fixture 9: Net-value sorting filters out uneconomical UTXOs ──
console.log('\nFixture 9: Net-value sorting filters uneconomical UTXOs');
{
  // At 10 sat/vB, per-input fee for P2WPKH = ceil(68 * 10) = 680
  // UTXO of 500 sats has negative net value → should be filtered out
  const utxos = [makeUtxo(500, 0), makeUtxo(100000, 1)];
  const plan = planSpend(utxos, 'bc1qtest', 'bc1qdest', 5000, 10);
  assert(plan.utxos.length === 1, 'only economical UTXO selected');
  assert(plan.utxos[0].value === 100000, 'selected the 100k UTXO');
}

// ── Fixture 10: No UTXOs ──
console.log('\nFixture 10: No UTXOs');
{
  assertThrows(
    () => planSpend([], 'bc1qtest', 'bc1qdest', 5000, 1),
    'No unspent outputs',
    'throws on empty UTXO set',
  );
}

// ── Fixture 11: MIN_TX_FEE_SATS enforcement ──
console.log('\nFixture 11: MIN_TX_FEE_SATS enforcement');
{
  // Very small tx at very low fee rate — fee should not go below 141
  const utxos = [makeUtxo(100000, 0)];
  const plan = planSpend(utxos, 'bc1qtest', 'bc1qdest', 50000, 0.1);
  assert(plan.fee >= MIN_TX_FEE_SATS, `fee >= ${MIN_TX_FEE_SATS} (got ${plan.fee})`);
}

// ══ planMaxSpendable() Fixtures ══

console.log('\n=== planMaxSpendable() Golden Parity Fixtures ===\n');

// ── Fixture 12: Standard max spendable (P2WPKH) ──
console.log('Fixture 12: Standard max spendable (P2WPKH)');
{
  const utxos = [makeUtxo(100000, 0)];
  const result = planMaxSpendable(utxos, 'bc1qtest', 1);
  // 2-output: vsize = 11 + 68 + 68 = 147, fee = 147
  // amount = 100000 - 147 - 294(dust) = 99559
  assert(result.amount > 0, `amount > 0 (got ${result.amount})`);
  assert(result.amount + result.fee + result.changeValue === 100000,
    `amount + fee + change = total (${result.amount} + ${result.fee} + ${result.changeValue})`);
}

// ── Fixture 13: Max spendable with empty UTXOs ──
console.log('\nFixture 13: Max spendable with empty UTXOs');
{
  const result = planMaxSpendable([], 'bc1qtest', 1);
  assert(result.amount === 0, 'amount = 0');
  assert(result.fee === 0, 'fee = 0');
}

// ── Fixture 14: Max spendable P2PKH sender ──
console.log('\nFixture 14: Max spendable P2PKH sender');
{
  const utxos = [makeUtxo(100000, 0)];
  const result = planMaxSpendable(utxos, 'mlegacytest', 1);
  // P2PKH: 2-output vsize = 11 + 148 + 68 = 227, fee = 227
  // amount = 100000 - 227 - 546 = 99227
  assert(result.amount > 0, `amount > 0 (got ${result.amount})`);
  assert(result.fee >= 193, `fee appropriate for P2PKH (got ${result.fee})`);
}

// ── Fixture 15: Max spendable with uneconomical UTXOs ──
console.log('\nFixture 15: Max spendable filters uneconomical UTXOs');
{
  // At 100 sat/vB, per-input fee for P2WPKH = 6800 sats
  // UTXOs of 1000 sats each are uneconomical
  const utxos = Array.from({ length: 10 }, (_, i) => makeUtxo(1000, i));
  const result = planMaxSpendable(utxos, 'bc1qtest', 100);
  assert(result.amount === 0, `amount = 0 (uneconomical UTXOs, got ${result.amount})`);
}

// ── Fixture 16: Max spendable falls back to 1-output scenario ──
console.log('\nFixture 16: Max spendable 1-output fallback');
{
  // Small balance where 2-output scenario fails but 1-output works
  // At 1 sat/vB: 2-output fee = max(147, 141) = 147
  // amount = 600 - 147 - 294 = 159 ≤ 294 dust → 2-output fails
  // 1-output fee = max(113, 141) = 141
  // amount = 600 - 141 = 459 > 294 dust → 1-output works
  const utxos = [makeUtxo(600, 0)];
  const result = planMaxSpendable(utxos, 'bc1qtest', 1);
  assert(result.amount > 0, `amount > 0 (got ${result.amount})`);
  assert(result.changeValue === 0, 'no change (1-output scenario)');
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n═══ ${passed}/${passed + failed} passed, ${failed} failed ═══\n`);
if (failed > 0) process.exit(1);

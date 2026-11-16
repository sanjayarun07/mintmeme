import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { keccak256, bytesToHex } from '../src/keccak.ts';

// Independent check: our hand-written Keccak-256 against Foundry's `cast keccak` (a different implementation) on random inputs, including every length around the 136-byte block boundary.
const have = spawnSync('cast', ['--version']).status === 0;
test('keccak256 agrees with cast keccak on random inputs of lengths 0..300 and block-boundary sizes', { skip: have ? false : 'cast (Foundry) not installed' }, () => {
  const lens = [...Array(301).keys(), 135 * 2, 136 * 2, 137 * 2, 272, 1000, 4096];
  for (const n of lens) {
    const data = randomBytes(n), want = execFileSync('cast', ['keccak', n === 0 ? '0x' : bytesToHex(data)], { encoding: 'utf8' }).trim();
    assert.equal(bytesToHex(keccak256(data)), want, `length ${n}`);
  }
});

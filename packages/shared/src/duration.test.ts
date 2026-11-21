import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planSceneDurations,
  sceneDurationsSumError,
  validateTotalDuration,
  validateSceneCount,
} from './duration.js';

test('validateTotalDuration accepts 5..300 whole seconds', () => {
  assert.equal(validateTotalDuration(5), null);
  assert.equal(validateTotalDuration(300), null);
  assert.equal(validateTotalDuration(60), null);
});

test('validateTotalDuration rejects out-of-range and fractional values', () => {
  assert.notEqual(validateTotalDuration(4), null);
  assert.notEqual(validateTotalDuration(301), null);
  assert.notEqual(validateTotalDuration(10.5), null);
  assert.notEqual(validateTotalDuration(Number.NaN), null);
});

test('validateSceneCount rejects counts exceeding total seconds', () => {
  assert.notEqual(validateSceneCount(11, 10), null);
  assert.equal(validateSceneCount(10, 10), null);
  assert.notEqual(validateSceneCount(0, 10), null);
  assert.notEqual(validateSceneCount(41, 300), null);
});

test('planSceneDurations sums exactly to target for even splits', () => {
  const plan = planSceneDurations(60, 6, 10);
  assert.equal(plan.totalSeconds, 60);
  assert.deepEqual(plan.sceneDurations, [10, 10, 10, 10, 10, 10]);
});

test('planSceneDurations distributes remainder to first scenes', () => {
  const plan = planSceneDurations(100, 3, 10);
  assert.equal(plan.totalSeconds, 100);
  assert.deepEqual(plan.sceneDurations, [34, 33, 33]);
});

test('planSceneDurations handles 5 minutes across many scenes', () => {
  const plan = planSceneDurations(300, 40, 8);
  assert.equal(plan.totalSeconds, 300);
  assert.equal(plan.sceneDurations.length, 40);
  for (const d of plan.sceneDurations) {
    assert.ok(d >= 1 && d <= 20, `scene duration ${d} within bounds`);
  }
});

test('sceneDurationsSumError detects mismatch', () => {
  assert.equal(sceneDurationsSumError([10, 10, 10], 30), null);
  assert.notEqual(sceneDurationsSumError([10, 10, 9], 30), null);
  assert.match(sceneDurationsSumError([10, 10, 9], 30)!, /sum to 29s/);
});

test('planSceneDurations throws readable errors for invalid input', () => {
  assert.throws(() => planSceneDurations(4, 1, 5), /Total duration/);
  assert.throws(() => planSceneDurations(10, 0, 5), /Scene count/);
  assert.throws(() => planSceneDurations(10, 2, 0.5), /Clip duration/);
});

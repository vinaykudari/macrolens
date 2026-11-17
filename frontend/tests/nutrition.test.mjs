import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manualCalories } from '../src/utils/nutrition.ts';
import { calculateTargetsFromProfile } from '../src/utils/calibration.ts';

test('manual entries estimate calories only when omitted', () => {
  assert.equal(manualCalories('', 20, 30, 10), 290);
  assert.equal(manualCalories('275', 20, 30, 10), 275);
  assert.equal(manualCalories('0', 20, 30, 10), 0);
});

test('target preview follows the server formula for standard and edge profiles', () => {
  const profile = { height_cm: 178, weight_kg: 75, age: 30, sex: 'male', activity_level: 'moderate', goal: 'maintain' };
  assert.deepEqual(calculateTargetsFromProfile(profile), { calories: 2662, protein_g: 120, carbs_g: 365.7, fat_g: 79.9 });
  assert.deepEqual(calculateTargetsFromProfile({ ...profile, height_cm: 100, weight_kg: 25, age: 110, sex: 'female', activity_level: 'sedentary' }), { calories: 1200, protein_g: 40, carbs_g: 179, fat_g: 36 });
});

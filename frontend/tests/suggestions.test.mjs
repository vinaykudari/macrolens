import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestMeals } from '../src/utils/suggestions.ts';
const meal = (meal_name, date) => ({ meal_name, logged_at: date });
test('empty history has no fabricated suggestions', () => {
  assert.deepEqual(suggestMeals([], [], '2026-11-15', '12:00', ''), []);
});
test('uses history, selected day, time and typed text', () => {
  const history = [meal('Lunch bowl', '2026-11-14T12:00:00'), meal('Oatmeal', '2026-11-13T08:00:00'), meal('Lunch bowl', '2026-11-12T12:15:00'), meal('Future meal', '2026-11-16T12:00:00')];
  assert.deepEqual(suggestMeals(history, [], '2026-11-15', '12:00', ''), ['Lunch bowl', 'Oatmeal']);
  assert.deepEqual(suggestMeals(history, [meal('Lunch bowl', '2026-11-15T12:00:00')], '2026-11-15', '12:00', ''), ['Oatmeal']);
  assert.deepEqual(suggestMeals(history, [], '2026-11-15', '12:00', 'oat'), ['Oatmeal']);
});

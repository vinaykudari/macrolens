import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addExportRange, mealsToCsv } from '../src/utils/logExport.ts';

test('date selection combines ranges, deduplicates and allows individual days', () => {
  assert.deepEqual(addExportRange(['2026-11-19'], '2026-11-16', '2026-11-18'), ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19']);
  assert.deepEqual(addExportRange(['2026-11-16'], '2026-11-18', '2026-11-18'), ['2026-11-16', '2026-11-18']);
  assert.throws(() => addExportRange([], '2026-11-19', '2026-11-16'), /valid/);
  assert.throws(() => addExportRange([], '2025-01-01', '2026-12-31'), /366/);
});

test('CSV includes stored meal details and escapes spreadsheet formulas and quotes', () => {
  const meal = { id: 1, meal_name: '=SUM(1,2)', logged_at: '2026-11-16T20:30:00Z', source: 'photo', portion_multiplier: 1, calories: 200, protein_g: 20, carbs_g: 10, fat_g: 8, notes: 'spicy, "tasty"\nmore', items: [{ name: 'Rice', portion_description: '1 cup', estimated_grams: 100, calories: 100, protein_g: 2, carbs_g: 20, fat_g: 1 }], has_photo: true };
  const csv = mealsToCsv([meal]);
  assert.match(csv, /"'=SUM\(1,2\)"/);
  assert.match(csv, /"spicy, ""tasty""\nmore"/);
  assert.match(csv, /Rice \(1 cup, 100 g\): 100 kcal; protein 2 g; carbs 20 g; fat 1 g/);
  assert.match(csv, /2026-11-16T20:30:00\.000Z/);
  assert.match(csv, /"Yes"/);
});

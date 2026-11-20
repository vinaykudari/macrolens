import type { MealRecord } from '../types/api';
import { getLocalDateString, normalizeIsoTimestamp, shiftDateString } from './date.ts';

export const MAX_EXPORT_DAYS = 366;

export function addExportRange(selected: string[], start: string, end: string): string[] {
  if (!start || !end || start > end) throw new Error('Choose a valid start and end date.');
  const days = new Set(selected);
  let day = start;
  for (let count = 0; day <= end; count += 1) {
    if (count >= MAX_EXPORT_DAYS) throw new Error(`Choose up to ${MAX_EXPORT_DAYS} days per export.`);
    days.add(day);
    if (days.size > MAX_EXPORT_DAYS) throw new Error(`Choose up to ${MAX_EXPORT_DAYS} days per export.`);
    day = shiftDateString(day, 1);
  }
  return [...days].sort();
}

function csvCell(value: string | number | null | undefined): string {
  let text = String(value ?? '');
  // Spreadsheet apps can execute text beginning with a formula character.
  if (typeof value === 'string' && /^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function mealsToCsv(meals: MealRecord[]): string {
  const rows: (string | number | null | undefined)[][] = [[
    'Date (local)', 'Time (local)', 'Logged at (UTC)', 'Meal', 'Calories (kcal)',
    'Protein (g)', 'Carbohydrates (g)', 'Fat (g)', 'Description / notes',
    'Food items and portions', 'Source', 'Portion multiplier', 'Detected reference',
    'Confidence', 'Has photo',
  ]];
  const sorted = [...meals].sort((a, b) => normalizeIsoTimestamp(a.logged_at).getTime() - normalizeIsoTimestamp(b.logged_at).getTime());
  for (const meal of sorted) {
    const date = normalizeIsoTimestamp(meal.logged_at);
    const items = (meal.items ?? []).map((item) => {
      const details = [item.portion_description, item.estimated_grams ? `${item.estimated_grams} g` : ''].filter(Boolean).join(', ');
      return `${item.name}${details ? ` (${details})` : ''}: ${item.calories} kcal; protein ${item.protein_g} g; carbs ${item.carbs_g} g; fat ${item.fat_g} g`;
    }).join(' | ');
    rows.push([
      getLocalDateString(date), date.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      date.toISOString(), meal.meal_name, meal.calories, meal.protein_g, meal.carbs_g, meal.fat_g,
      meal.notes, items, meal.source, meal.portion_multiplier, meal.detected_reference, meal.confidence,
      meal.has_photo ? 'Yes' : 'No',
    ]);
  }
  return '\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

import type { MealItem, MealRecord } from '../types/api';

export function getDisplayMealItems(meal: MealRecord): MealItem[] {
  const items = Array.isArray(meal.items) ? meal.items : [];
  if (items.length === 0) return [];

  const mult =
    typeof meal.portion_multiplier === 'number' && meal.portion_multiplier > 0
      ? meal.portion_multiplier
      : 1;

  if (Math.abs(mult - 1) <= 0.01) {
    return items;
  }

  const rawCalSum = items.reduce((sum, it) => sum + (Number(it.calories) || 0), 0);
  if (rawCalSum <= 0) {
    return items;
  }

  const diffAsStored = Math.abs(rawCalSum - meal.calories);
  const diffIfScaled = Math.abs(rawCalSum * mult - meal.calories);

  // If items were stored at 1x base while meal totals reflect portion_multiplier, scale items for display
  if (diffIfScaled + 1 < diffAsStored) {
    return items.map((it) => ({
      ...it,
      estimated_grams: Math.round((Number(it.estimated_grams) || 0) * mult),
      calories: Math.round((Number(it.calories) || 0) * mult),
      protein_g: Math.round((Number(it.protein_g) || 0) * mult * 10) / 10,
      carbs_g: Math.round((Number(it.carbs_g) || 0) * mult * 10) / 10,
      fat_g: Math.round((Number(it.fat_g) || 0) * mult * 10) / 10,
    }));
  }

  return items;
}

/** Use entered calories when present; otherwise estimate from the entered macros. */
export function manualCalories(calories: string, protein: number, carbs: number, fat: number): number {
  return calories.trim() === '' ? protein * 4 + carbs * 4 + fat * 9 : Number(calories) || 0;
}

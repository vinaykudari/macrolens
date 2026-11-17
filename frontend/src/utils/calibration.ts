import type { ActivityLevel, Goal, MacroTargets, Sex, UserProfile } from '../types/api';

export const ACTIVITY_MULTIPLIERS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

export const ACTIVITY_OPTIONS: Array<{
  value: ActivityLevel;
  label: string;
  description: string;
}> = [
  { value: 'sedentary', label: 'Sedentary', description: 'Desk job, little exercise' },
  { value: 'light', label: 'Light', description: '1–3 workouts / week' },
  { value: 'moderate', label: 'Moderate', description: '3–5 workouts / week' },
  { value: 'active', label: 'Active', description: '6–7 workouts / week' },
  { value: 'very_active', label: 'Very Active', description: '2x daily or physical labor' },
];

export const GOAL_OPTIONS: Array<{
  value: Goal;
  label: string;
  hint: string;
}> = [
  { value: 'lose', label: 'Lose Fat', hint: '-450 kcal deficit' },
  { value: 'maintain', label: 'Maintain', hint: 'Steady energy' },
  { value: 'gain', label: 'Build Muscle', hint: '+300 kcal surplus' },
];

export const SEX_OPTIONS: Array<{ value: Sex; label: string }> = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
];

// Match Python's round-to-even at exact half values used by the API.
function roundEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  return fraction === 0.5 ? floor + (floor % 2) : Math.round(value);
}

function estimateTdee(profile: UserProfile): { bmr: number; tdee: number } {
  const weight = Number(profile.weight_kg) || 70;
  const height = Number(profile.height_cm) || 170;
  const age = Number(profile.age) || 28;
  const offset = profile.sex === 'male' ? 5 : profile.sex === 'female' ? -161 : -78;
  const bmr = 10 * weight + 6.25 * height - 5 * age + offset;
  return { bmr, tdee: bmr * (ACTIVITY_MULTIPLIERS[profile.activity_level] ?? 1.55) };
}

export function calculateBmrAndTdee(profile: UserProfile): { bmr: number; tdee: number } {
  const { bmr, tdee } = estimateTdee(profile);
  return { bmr: roundEven(bmr), tdee: roundEven(tdee) };
}

export function calculateTargetsFromProfile(profile: UserProfile): MacroTargets {
  const { tdee } = estimateTdee(profile);
  const weight = Number(profile.weight_kg) || 70;
  const adjustment = profile.goal === 'lose' ? -450 : profile.goal === 'gain' ? 300 : 0;
  const calories = roundEven(Math.max(1200, tdee + adjustment));
  const proteinPerKg = profile.goal === 'lose' ? 2.0 : profile.goal === 'gain' ? 1.8 : 1.6;
  const protein_g = Math.round(weight * proteinPerKg * 10) / 10;
  const fat_g = Math.round(((calories * 0.27) / 9) * 10) / 10;
  const carbs_g = Math.round(Math.max(50, (calories - protein_g * 4 - fat_g * 9) / 4) * 10) / 10;
  return { calories, protein_g, carbs_g, fat_g };
}

export function cmToFtIn(cm: number): { feet: number; inches: number } {
  const totalInches = Math.round(cm / 2.54);
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return { feet, inches };
}

export function ftInToCm(feet: number, inches: number): number {
  const totalInches = Math.max(0, feet) * 12 + Math.max(0, inches);
  return Math.round(totalInches * 2.54 * 10) / 10;
}

export function kgToLbs(kg: number): number {
  return Math.round(kg * 2.20462 * 10) / 10;
}

export function lbsToKg(lbs: number): number {
  return Math.round((lbs / 2.20462) * 10) / 10;
}

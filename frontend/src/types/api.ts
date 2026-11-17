export type Sex = 'male' | 'female' | 'other';

export type ActivityLevel =
  | 'sedentary'
  | 'light'
  | 'moderate'
  | 'active'
  | 'very_active';

export type Goal = 'lose' | 'maintain' | 'gain';

export interface UserProfile {
  height_cm: number;
  weight_kg: number;
  age: number;
  sex: Sex;
  activity_level: ActivityLevel;
  goal: Goal;
}

export interface MacroTargets {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

export interface User {
  id: string | number;
  email: string;
  name: string;
  profile: UserProfile;
  targets: MacroTargets;
}

export interface AuthResponse {
  access_token: string;
  token_type: string;
  user: User;
}

export interface SignupRequest {
  email: string;
  pin: string;
  name: string;
  profile: UserProfile;
}

export interface LoginRequest {
  email: string;
  pin: string;
}

export interface NotificationSettings {
  enabled: boolean;
  breakfast_time: string;
  lunch_time: string;
  dinner_time: string;
  timezone: string;
  active_subscriptions: number;
}

export interface NotificationSettingsUpdate {
  enabled?: boolean;
  breakfast_time?: string;
  lunch_time?: string;
  dinner_time?: string;
  timezone?: string;
}

export interface ConfigResponse {
  profile: UserProfile;
  targets: MacroTargets;
  auto_calibrated_targets: MacroTargets;
  notifications?: NotificationSettings;
}

export interface UpdateConfigRequest {
  profile?: UserProfile;
  targets?: MacroTargets;
  recalibrate_from_profile?: boolean;
  notifications?: NotificationSettingsUpdate;
}

export interface VapidPublicKeyResponse {
  public_key: string;
  configured?: boolean;
}

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  timezone?: string;
  user_agent?: string;
}

export interface PushTestResponse {
  sent: number;
  failed: number;
  detail: string;
}

export interface MealItem {
  name: string;
  portion_description: string;
  estimated_grams: number;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

export interface MacroTotals {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

export type ConfidenceLevel = 'high' | 'medium' | 'low' | string;

export interface AnalyzeMealResponse {
  meal_name: string;
  detected_reference: string | null;
  confidence: ConfidenceLevel;
  notes: string | null;
  total: MacroTotals;
  items: MealItem[];
}

export interface AudioTranscribeResponse {
  transcript: string;
}

export type MealSource = 'photo' | 'text' | 'manual' | 'recent' | string;

export interface CreateMealRequest {
  meal_name: string;
  logged_at?: string;
  source: MealSource;
  detected_reference?: string | null;
  confidence?: ConfidenceLevel | null;
  notes?: string | null;
  portion_multiplier: number;
  items: MealItem[];
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

export interface UpdateMealRequest {
  meal_name?: string;
  logged_at?: string;
  notes?: string | null;
  portion_multiplier?: number;
  items?: MealItem[];
  calories?: number;
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
}

export interface MealRecord {
  id: string | number;
  meal_name: string;
  logged_at: string;
  source: MealSource;
  detected_reference?: string | null;
  confidence?: ConfidenceLevel | null;
  notes?: string | null;
  portion_multiplier: number;
  items: MealItem[];
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  has_photo?: boolean;
  photo_url?: string | null;
}

export interface PaginatedMealsResponse {
  items: MealRecord[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface HistoryDayPoint {
  date: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  meal_count: number;
  calories_status: 'under' | 'on_track' | 'over' | string;
  protein_status: 'under' | 'met' | 'exceeded' | string;
  calories_met: boolean;
  protein_met: boolean;
  meeting_goals: boolean;
  target_calories?: number;
  target_protein_g?: number;
}

export interface HistorySummary {
  days_logged: number;
  days_calories_met: number;
  days_protein_met: number;
  days_both_met: number;
  current_streak: number;
  avg_calories: number;
  avg_protein_g: number;
}

export interface DashboardHistoryResponse {
  days: number;
  targets: MacroTargets;
  summary: HistorySummary;
  series: HistoryDayPoint[];
}

export interface DailyStatus {
  calories: string;
  protein: string;
  meeting_goals: boolean;
  summary: string;
}

export interface DailyDashboardResponse {
  date: string;
  targets: MacroTargets;
  consumed: MacroTotals;
  remaining: MacroTotals;
  status: DailyStatus;
  meal_count: number;
  meals: MealRecord[];
}

export interface QuickMealTemplate {
  id: string;
  meal_name: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  items: MealItem[];
  notes?: string | null;
  isPreset?: boolean;
  lastUsedAt?: string;
}

export interface ShortcutTokenStatusResponse {
  configured: boolean;
  token?: string | null;
}

export interface ShortcutTokenCreateResponse {
  token: string;
  configured: boolean;
}

export interface ShortcutHealthMealItem {
  id: number;
  meal_name: string;
  logged_at: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  synced_to_health: boolean;
}

export interface ShortcutHealthSyncResponse {
  date: string;
  total_calories: number;
  total_protein_g: number;
  total_carbs_g: number;
  total_fat_g: number;
  meal_count: number;
  unsynced_count: number;
  meals: ShortcutHealthMealItem[];
}

export interface ShortcutPrepareResponse {
  download_url: string;
  sync_url: string;
  mode: 'baked' | 'template';
}

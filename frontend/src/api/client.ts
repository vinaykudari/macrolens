import { getDetectedTimezone } from '../utils/push';
import type {
  AnalyzeMealResponse,
  AudioTranscribeResponse,
  AuthResponse,
  ConfigResponse,
  CreateMealRequest,
  DailyDashboardResponse,
  DashboardHistoryResponse,
  LoginRequest,
  MealRecord,
  NotificationSettings,
  PaginatedMealsResponse,
  PushSubscriptionPayload,
  PushTestResponse,
  QuickMealTemplate,
  ShortcutHealthSyncResponse,
  ShortcutPrepareResponse,
  ShortcutTokenCreateResponse,
  ShortcutTokenStatusResponse,
  SignupRequest,
  UpdateConfigRequest,
  UpdateMealRequest,
  User,
  VapidPublicKeyResponse,
} from '../types/api';

const TOKEN_STORAGE_KEY = 'macrolens_auth_token';
const LAST_EMAIL_STORAGE_KEY = 'macrolens_last_email';
const RECENT_MEALS_PREFIX = 'macrolens_recent_meals_';

export const PRESET_QUICK_MEALS: QuickMealTemplate[] = [
  {
    id: 'preset-protein-bar',
    meal_name: 'Protein Bar',
    calories: 210,
    protein_g: 20,
    carbs_g: 22,
    fat_g: 7,
    items: [
      {
        name: 'Protein bar',
        portion_description: '1 bar (60g)',
        estimated_grams: 60,
        calories: 210,
        protein_g: 20,
        carbs_g: 22,
        fat_g: 7,
      },
    ],
    notes: 'Quick snack preset',
    isPreset: true,
  },
  {
    id: 'preset-whey-shake',
    meal_name: 'Whey Protein Shake',
    calories: 130,
    protein_g: 25,
    carbs_g: 3,
    fat_g: 2,
    items: [
      {
        name: 'Whey protein isolate + water',
        portion_description: '1 scoop (32g)',
        estimated_grams: 32,
        calories: 130,
        protein_g: 25,
        carbs_g: 3,
        fat_g: 2,
      },
    ],
    notes: 'Quick snack preset',
    isPreset: true,
  },
  {
    id: 'preset-greek-yogurt',
    meal_name: 'Greek Yogurt Cup',
    calories: 150,
    protein_g: 18,
    carbs_g: 12,
    fat_g: 3,
    items: [
      {
        name: '0% Plain Greek yogurt + berries',
        portion_description: '1 single cup (170g)',
        estimated_grams: 170,
        calories: 150,
        protein_g: 18,
        carbs_g: 12,
        fat_g: 3,
      },
    ],
    notes: 'Quick snack preset',
    isPreset: true,
  },
  {
    id: 'preset-eggs',
    meal_name: '2 Large Eggs',
    calories: 144,
    protein_g: 12.6,
    carbs_g: 1.1,
    fat_g: 9.6,
    items: [
      {
        name: 'Large eggs',
        portion_description: '2 eggs',
        estimated_grams: 100,
        calories: 144,
        protein_g: 12.6,
        carbs_g: 1.1,
        fat_g: 9.6,
      },
    ],
    notes: 'Quick snack preset',
    isPreset: true,
  },
];

export class ApiError extends Error {
  status: number;
  isOffline: boolean;

  constructor(message: string, status = 0, isOffline = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.isOffline = isOffline;
  }
}

type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

export function getStoredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function getLastEmail(): string {
  try {
    return window.localStorage.getItem(LAST_EMAIL_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setLastEmail(email: string): void {
  try {
    if (email) {
      window.localStorage.setItem(LAST_EMAIL_STORAGE_KEY, email.trim());
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function getRecentMealsCache(userId: string | number): QuickMealTemplate[] {
  try {
    const raw = window.localStorage.getItem(`${RECENT_MEALS_PREFIX}${userId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveMealToRecentCache(
  userId: string | number,
  meal: Pick<
    MealRecord,
    'meal_name' | 'calories' | 'protein_g' | 'carbs_g' | 'fat_g' | 'items' | 'notes'
  >
): void {
  try {
    const existing = getRecentMealsCache(userId);
    const normalizedName = meal.meal_name.trim().toLowerCase();
    const entry: QuickMealTemplate = {
      id: `recent-${normalizedName.replace(/[^a-z0-9]+/g, '-')}`,
      meal_name: meal.meal_name.trim(),
      calories: Math.round(meal.calories),
      protein_g: Math.round(meal.protein_g * 10) / 10,
      carbs_g: Math.round(meal.carbs_g * 10) / 10,
      fat_g: Math.round(meal.fat_g * 10) / 10,
      items: meal.items || [],
      notes: meal.notes ?? null,
      lastUsedAt: new Date().toISOString(),
    };
    const filtered = existing.filter(
      (item) => item.meal_name.trim().toLowerCase() !== normalizedName
    );
    const next = [entry, ...filtered].slice(0, 12);
    window.localStorage.setItem(
      `${RECENT_MEALS_PREFIX}${userId}`,
      JSON.stringify(next)
    );
  } catch {
    // Ignore storage errors
  }
}

function extractErrorMessage(data: unknown, status: number): string {
  if (!data || typeof data !== 'object') {
    if (status === 401) return 'Session expired or invalid credentials.';
    if (status >= 500) return 'Server error. Please try again in a moment.';
    return `Request failed (${status}).`;
  }

  const record = data as Record<string, unknown>;
  if (typeof record.detail === 'string' && record.detail.trim()) {
    return record.detail;
  }
  if (Array.isArray(record.detail) && record.detail.length > 0) {
    const messages = record.detail
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object') {
          const item = entry as Record<string, unknown>;
          const msg = typeof item.msg === 'string' ? item.msg : '';
          const loc = Array.isArray(item.loc)
            ? item.loc
                .filter((segment) => segment !== 'body')
                .map(String)
                .join('.')
            : '';
          return loc && msg ? `${loc}: ${msg}` : msg;
        }
        return '';
      })
      .filter(Boolean);
    if (messages.length > 0) return messages.join(' · ');
  }
  if (typeof record.message === 'string' && record.message.trim()) {
    return record.message;
  }
  if (typeof record.error === 'string' && record.error.trim()) {
    return record.error;
  }
  return `Request failed (${status}).`;
}

interface RequestOptions extends RequestInit {
  suppressUnauthorizedEvent?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { suppressUnauthorizedEvent = false, headers: customHeaders, body, ...rest } =
    options;

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new ApiError(
      'You appear to be offline. Reconnect to sync meals and targets.',
      0,
      true
    );
  }

  const headers = new Headers(customHeaders);
  const token = getStoredToken();
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  if (!isFormData && body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(path, {
      ...rest,
      headers,
      body,
      credentials: 'include',
    });
  } catch {
    throw new ApiError(
      'Unable to reach server. Check your connection and try again.',
      0,
      typeof navigator !== 'undefined' ? !navigator.onLine : false
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    if (response.status === 401) {
      setStoredToken(null);
      if (!suppressUnauthorizedEvent && unauthorizedHandler) {
        unauthorizedHandler();
      }
    }
    const message =
      typeof parsed === 'string' && parsed.trim()
        ? parsed
        : extractErrorMessage(parsed, response.status);
    throw new ApiError(message, response.status);
  }

  return parsed as T;
}

export const apiClient = {
  async signup(payload: SignupRequest): Promise<AuthResponse> {
    const res = await request<AuthResponse>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(payload),
      suppressUnauthorizedEvent: true,
    });
    if (res.access_token) {
      setStoredToken(res.access_token);
    }
    setLastEmail(payload.email);
    return res;
  },

  async login(payload: LoginRequest): Promise<AuthResponse> {
    const res = await request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
      suppressUnauthorizedEvent: true,
    });
    if (res.access_token) {
      setStoredToken(res.access_token);
    }
    setLastEmail(payload.email);
    return res;
  },

  async logout(): Promise<void> {
    try {
      await request<void>('/api/auth/logout', {
        method: 'POST',
        suppressUnauthorizedEvent: true,
      });
    } finally {
      setStoredToken(null);
    }
  },

  async me(suppressUnauthorizedEvent = false): Promise<User> {
    const res = await request<User | { user: User }>('/api/auth/me', {
      method: 'GET',
      suppressUnauthorizedEvent,
    });
    if (res && typeof res === 'object' && 'user' in res && res.user) {
      return res.user;
    }
    return res as User;
  },

  async getConfig(): Promise<ConfigResponse> {
    return request<ConfigResponse>('/api/config', { method: 'GET' });
  },

  async updateConfig(payload: UpdateConfigRequest): Promise<ConfigResponse> {
    return request<ConfigResponse>('/api/config', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  async analyzeMeal(params: {
    image: File;
    note: string;
    referenceHint: string;
  }): Promise<AnalyzeMealResponse> {
    const formData = new FormData();
    formData.append('image', params.image);
    formData.append('note', params.note);
    formData.append('description', params.note);
    formData.append('reference_hint', params.referenceHint);

    return request<AnalyzeMealResponse>('/api/meals/analyze', {
      method: 'POST',
      body: formData,
    });
  },

  async transcribeAudio(
    audio: Blob,
    filename?: string
  ): Promise<AudioTranscribeResponse> {
    const mime = (audio.type || '').toLowerCase();
    const fallbackName = mime.includes('mp4')
      ? 'dictation.m4a'
      : mime.includes('ogg')
      ? 'dictation.ogg'
      : 'dictation.webm';
    const formData = new FormData();
    formData.append('audio', audio, filename || fallbackName);

    return request<AudioTranscribeResponse>('/api/meals/transcribe', {
      method: 'POST',
      body: formData,
    });
  },

  async analyzeMealText(description: string): Promise<AnalyzeMealResponse> {
    return request<AnalyzeMealResponse>('/api/meals/analyze-text', {
      method: 'POST',
      body: JSON.stringify({ description }),
    });
  },

  async refineMeal(
    mealId: string | number,
    instruction: string
  ): Promise<AnalyzeMealResponse> {
    return request<AnalyzeMealResponse>(
      `/api/meals/${encodeURIComponent(String(mealId))}/refine`,
      {
        method: 'POST',
        body: JSON.stringify({ instruction }),
      }
    );
  },

  async createMeal(payload: CreateMealRequest): Promise<MealRecord> {
    return request<MealRecord>('/api/meals', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async createMealWithPhoto(payload: CreateMealRequest, image: File, requestId: string): Promise<MealRecord> {
    const form = new FormData();
    form.append('payload', JSON.stringify(payload));
    form.append('request_id', requestId);
    form.append('image', image);
    try {
      return await request<MealRecord>('/api/meals/with-photo', { method: 'POST', body: form });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status === 0) {
        throw new ApiError('Connection interrupted. Retry this save to check whether it completed.', 0);
      }
      throw error;
    }
  },

  async uploadMealPhoto(
    mealId: string | number,
    file: File
  ): Promise<MealRecord> {
    const formData = new FormData();
    formData.append('image', file);
    return request<MealRecord>(
      `/api/meals/${encodeURIComponent(String(mealId))}/photo`,
      {
        method: 'POST',
        body: formData,
      }
    );
  },

  async getMeals(
    date: string,
    tzOffsetMinutes: number
  ): Promise<MealRecord[]> {
    const params = new URLSearchParams({
      date,
      tz_offset_minutes: String(tzOffsetMinutes),
      tz_name: getDetectedTimezone(),
    });
    const res = await request<MealRecord[] | { meals: MealRecord[] }>(
      `/api/meals?${params.toString()}`,
      { method: 'GET' }
    );
    if (Array.isArray(res)) return res;
    if (res && Array.isArray(res.meals)) return res.meals;
    return [];
  },

  async getMealLogs(params: {
    page: number;
    pageSize?: number;
    date?: string;
    tzOffsetMinutes?: number;
    q?: string;
  }): Promise<PaginatedMealsResponse> {
    const search = new URLSearchParams({
      page: String(params.page),
      page_size: String(params.pageSize ?? 12),
    });
    if (params.date && params.date.trim()) {
      search.set('date', params.date.trim());
      search.set('tz_name', getDetectedTimezone());
    }
    if (typeof params.tzOffsetMinutes === 'number') {
      search.set('tz_offset_minutes', String(params.tzOffsetMinutes));
    }
    if (params.q && params.q.trim()) {
      search.set('q', params.q.trim());
    }
    return request<PaginatedMealsResponse>(
      `/api/meals/logs?${search.toString()}`,
      { method: 'GET' }
    );
  },

  async updateMeal(
    id: string | number,
    payload: UpdateMealRequest
  ): Promise<MealRecord> {
    return request<MealRecord>(`/api/meals/${encodeURIComponent(String(id))}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },

  async deleteMeal(id: string | number): Promise<void> {
    return request<void>(`/api/meals/${encodeURIComponent(String(id))}`, {
      method: 'DELETE',
    });
  },

  async getDailyDashboard(
    date: string,
    tzOffsetMinutes: number
  ): Promise<DailyDashboardResponse> {
    const params = new URLSearchParams({
      date,
      tz_offset_minutes: String(tzOffsetMinutes),
      tz_name: getDetectedTimezone(),
    });
    return request<DailyDashboardResponse>(
      `/api/dashboard/daily?${params.toString()}`,
      { method: 'GET' }
    );
  },

  async getDashboardHistory(params: {
    days: number;
    endDate?: string;
    tzOffsetMinutes?: number;
  }): Promise<DashboardHistoryResponse> {
    const search = new URLSearchParams({
      days: String(params.days),
    });
    search.set('tz_name', getDetectedTimezone());
    if (params.endDate) {
      search.set('end_date', params.endDate);
    }
    if (typeof params.tzOffsetMinutes === 'number') {
      search.set('tz_offset_minutes', String(params.tzOffsetMinutes));
    }
    return request<DashboardHistoryResponse>(
      `/api/dashboard/history?${search.toString()}`,
      { method: 'GET' }
    );
  },

  async getVapidPublicKey(): Promise<VapidPublicKeyResponse> {
    return request<VapidPublicKeyResponse>(
      '/api/notifications/vapid-public-key',
      { method: 'GET' }
    );
  },

  async subscribePush(
    payload: PushSubscriptionPayload
  ): Promise<NotificationSettings> {
    return request<NotificationSettings>('/api/notifications/subscribe', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async unsubscribePush(endpoint?: string): Promise<NotificationSettings> {
    const query = endpoint
      ? `?${new URLSearchParams({ endpoint }).toString()}`
      : '';
    return request<NotificationSettings>(
      `/api/notifications/subscribe${query}`,
      {
        method: 'DELETE',
        body: endpoint ? JSON.stringify({ endpoint }) : undefined,
      }
    );
  },

  async sendTestPush(): Promise<PushTestResponse> {
    return request<PushTestResponse>('/api/notifications/test', {
      method: 'POST',
    });
  },

  async getShortcutTokenStatus(): Promise<ShortcutTokenStatusResponse> {
    return request<ShortcutTokenStatusResponse>('/api/shortcuts/token', {
      method: 'GET',
    });
  },

  async generateShortcutToken(): Promise<ShortcutTokenCreateResponse> {
    return request<ShortcutTokenCreateResponse>('/api/shortcuts/token', {
      method: 'POST',
    });
  },

  async revokeShortcutToken(): Promise<ShortcutTokenStatusResponse> {
    return request<ShortcutTokenStatusResponse>('/api/shortcuts/token', {
      method: 'DELETE',
    });
  },

  async getShortcutHealthSync(params?: {
    date?: string;
    unsyncedOnly?: boolean;
    markSynced?: boolean;
  }): Promise<ShortcutHealthSyncResponse> {
    const search = new URLSearchParams({
      tz_offset_minutes: String(new Date().getTimezoneOffset()),
    });
    if (params?.date) search.set('date', params.date);
    if (params?.unsyncedOnly) search.set('unsynced_only', 'true');
    if (params?.markSynced) search.set('mark_synced', 'true');
    return request<ShortcutHealthSyncResponse>(
      `/api/shortcuts/health-sync?${search.toString()}`,
      { method: 'GET' }
    );
  },

  async prepareShortcutDownload(params: {
    token: string;
    baseUrl: string;
  }): Promise<ShortcutPrepareResponse> {
    return request<ShortcutPrepareResponse>('/api/shortcuts/prepare', {
      method: 'POST',
      body: JSON.stringify({
        token: params.token,
        base_url: params.baseUrl,
      }),
    });
  },

  buildShortcutInstallUrl(baseUrl: string): string {
    const params = new URLSearchParams({ base_url: baseUrl });
    return `/api/shortcuts/install?${params.toString()}`;
  },
};

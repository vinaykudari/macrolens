interface HistoryMeal { meal_name: string; logged_at: string }

/** Rank the account's recent meals by frequency and time of day, avoiding repeats on the selected day. */
export function suggestMeals(history: HistoryMeal[], dayMeals: HistoryMeal[], selectedDate: string, time: string, query: string): string[] {
  const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const dayNames = new Set(dayMeals.map((m) => m.meal_name.trim().toLowerCase()));
  history.forEach((m) => { const d = new Date(m.logged_at); if (!Number.isNaN(d.getTime()) && localDay(d) === selectedDate) dayNames.add(m.meal_name.trim().toLowerCase()); });
  const normalizedQuery = query.trim().toLowerCase();
  const [hours, minutes] = time.split(':').map(Number);
  const targetMinutes = (Number.isFinite(hours) ? hours : 12) * 60 + (Number.isFinite(minutes) ? minutes : 0);
  const candidates = new Map<string, { name: string; count: number; near: number; recent: number }>();
  history.forEach((meal, index) => {
    const name = meal.meal_name.trim();
    const key = name.toLowerCase();
    const date = new Date(meal.logged_at);
    if (!name || Number.isNaN(date.getTime())) return;
    const localDate = localDay(date);
    if (localDate > selectedDate || (!normalizedQuery && dayNames.has(key))) return;
    if (normalizedQuery && (!key.includes(normalizedQuery) || key === normalizedQuery)) return;
    const minute = date.getHours() * 60 + date.getMinutes();
    const distance = Math.abs(minute - targetMinutes);
    const near = Math.min(distance, 1440 - distance) <= 180 ? 1 : 0;
    const existing = candidates.get(key);
    if (existing) { existing.count += 1; existing.near = Math.max(existing.near, near); }
    else candidates.set(key, { name, count: 1, near, recent: index });
  });
  return [...candidates.values()].sort((a, b) => (b.near - a.near) || (b.count - a.count) || (a.recent - b.recent)).slice(0, 3).map((item) => item.name);
}

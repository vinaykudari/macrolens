export function getLocalDateString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getTzOffsetMinutes(): number {
  return new Date().getTimezoneOffset();
}

export function parseLocalDateString(dateStr: string): Date {
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (!year || !month || !day) {
    return new Date();
  }
  return new Date(year, month - 1, day);
}

export function shiftDateString(dateStr: string, deltaDays: number): string {
  const d = parseLocalDateString(dateStr);
  d.setDate(d.getDate() + deltaDays);
  return getLocalDateString(d);
}

export function formatDayLabel(dateStr: string): string {
  const today = getLocalDateString();
  if (dateStr === today) return 'Today';
  const yesterday = shiftDateString(today, -1);
  if (dateStr === yesterday) return 'Yesterday';
  const tomorrow = shiftDateString(today, 1);
  if (dateStr === tomorrow) return 'Tomorrow';

  const d = parseLocalDateString(dateStr);
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function formatLongDate(dateStr: string): string {
  const d = parseLocalDateString(dateStr);
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

export function normalizeIsoTimestamp(iso: string): Date {
  if (!iso) return new Date();
  const trimmed = iso.trim();
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const normalized =
    trimmed.includes('T') && !hasZone ? `${trimmed}Z` : trimmed;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function formatMealTime(iso: string): string {
  const date = normalizeIsoTimestamp(iso);
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatMealDateTime(iso: string): string {
  const date = normalizeIsoTimestamp(iso);
  const dayStr = getLocalDateString(date);
  const dayLabel = formatDayLabel(dayStr);
  const timeStr = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${dayLabel} · ${timeStr}`;
}

export function formatShortDate(dateStr: string): string {
  const d = parseLocalDateString(dateStr);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function formatWeekdayShort(dateStr: string): string {
  const d = parseLocalDateString(dateStr);
  return d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2);
}

export function toTimeInputValue(iso?: string): string {
  const date = iso ? normalizeIsoTimestamp(iso) : new Date();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function combineDateAndTimeToIso(dateStr: string, timeHHMM: string): string {
  const base = parseLocalDateString(dateStr);
  const [hhStr, mmStr] = timeHHMM.split(':');
  const hh = Number(hhStr);
  const mm = Number(mmStr);
  if (!Number.isNaN(hh) && !Number.isNaN(mm)) {
    base.setHours(hh, mm, 0, 0);
  }
  return base.toISOString();
}

/** Parse the camera's original capture time, using its offset when available. */
export function parsePhotoDate(value: string | undefined, offset: string | undefined, now = Date.now()): Date | null {
  if (!value) return null;
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d, h, min, sec] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const hour = Number(h), minute = Number(min), second = Number(sec);
  if (year < 1970 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  let result: Date;
  if (offset) {
    const zone = /^([+-])(\d{2}):(\d{2})$/.exec(offset.trim());
    if (!zone || Number(zone[2]) > 14 || Number(zone[3]) > 59 || (Number(zone[2]) === 14 && Number(zone[3]) !== 0)) return null;
    result = new Date(`${y}-${m}-${d}T${h}:${min}:${sec}${offset.trim()}`);
  } else {
    result = new Date(year, month - 1, day, hour, minute, second);
    if (result.getFullYear() !== year || result.getMonth() !== month - 1 || result.getDate() !== day || result.getHours() !== hour || result.getMinutes() !== minute) return null;
  }
  if (!Number.isFinite(result.getTime()) || result.getTime() > now + 5 * 60_000) return null;
  return result;
}

/** Read only the original capture timestamp; missing or unreadable metadata is not an error. */
export async function readPhotoDate(file: File): Promise<Date | null> {
  try {
    const module = await import('exifreader');
    const imported = module as unknown as { load?: typeof module.load; default?: typeof module };
    const load = imported.load ?? imported.default?.load;
    if (!load) return null;
    const tags = load(await file.arrayBuffer(), { includeTags: { exif: ['DateTimeOriginal', 'OffsetTimeOriginal'] } });
    return parsePhotoDate(tags.DateTimeOriginal?.description, tags.OffsetTimeOriginal?.description);
  } catch {
    return null;
  }
}

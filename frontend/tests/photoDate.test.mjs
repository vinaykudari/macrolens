import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parsePhotoDate, readPhotoDate } from '../src/utils/photoDate.ts';

const now = Date.parse('2026-11-20T12:00:00Z');
test('reads original capture time and offset from JPEG and HEIC photos', async () => {
  for (const name of ['photo-with-date.jpg', 'photo-with-date.heic']) {
    const contents = await readFile(new URL(`./fixtures/${name}`, import.meta.url));
    const date = await readPhotoDate(new File([contents], name, { type: 'image/jpeg' }));
    assert.equal(date?.toISOString(), '2026-01-08T15:30:45.000Z');
  }
});
test('ignores absent, malformed, implausible and non-existent capture times', async () => {
  const contents = await readFile(new URL('./fixtures/photo-no-date.jpg', import.meta.url));
  assert.equal(await readPhotoDate(new File([contents], 'no-date.jpg', { type: 'image/jpeg' })), null);
  assert.equal(parsePhotoDate('2026:02:30 12:00:00', undefined, now), null);
  assert.equal(parsePhotoDate('2026:11:21 12:00:00', '+00:00', now), null);
  assert.equal(parsePhotoDate('2026:01:08 07:30:45', '+15:00', now), null);
  assert.equal(parsePhotoDate('not a date', undefined, now), null);
});
test('interprets a capture without an offset as local time', () => {
  const result = parsePhotoDate('2026:01:08 07:30:45', undefined, now);
  assert.equal(result?.getFullYear(), 2026);
  assert.equal(result?.getMonth(), 0);
  assert.equal(result?.getDate(), 8);
  assert.equal(result?.getHours(), 7);
  assert.equal(result?.getMinutes(), 30);
});

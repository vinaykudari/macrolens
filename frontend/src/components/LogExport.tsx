import { useState } from 'react';
import { Download, X } from 'lucide-react';
import { apiClient, ApiError } from '../api/client';
import type { MealRecord } from '../types/api';
import { getTzOffsetMinutes, parseLocalDateString } from '../utils/date';
import { addExportRange, mealsToCsv } from '../utils/logExport';

export function LogExport({ selectedDate }: { selectedDate: string }) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<string[]>([]);
  const [start, setStart] = useState(selectedDate);
  const [end, setEnd] = useState(selectedDate);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');

  function show() {
    setDays([selectedDate]);
    setStart(selectedDate);
    setEnd(selectedDate);
    setMessage('');
    setOpen(true);
  }

  function addDays() {
    try {
      setDays(addExportRange(days, start, end));
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to add dates.');
    }
  }

  async function download() {
    setWorking(true);
    setMessage('');
    try {
      const meals: MealRecord[] = [];
      for (const date of days) {
        let page = 1;
        while (true) {
          const result = await apiClient.getMealLogs({ date, page, pageSize: 50, tzOffsetMinutes: getTzOffsetMinutes() });
          meals.push(...result.items);
          if (!result.has_next) break;
          page += 1;
        }
      }
      if (!meals.length) {
        setMessage('No meals found for the selected dates.');
        return;
      }
      const blob = new Blob([mealsToCsv(meals)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `macrolens-logs-${days[0]}${days.length > 1 ? `-to-${days[days.length - 1]}` : ''}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      setMessage(`Exported ${meals.length} ${meals.length === 1 ? 'meal' : 'meals'} from ${days.length} ${days.length === 1 ? 'day' : 'days'}.`);
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'Unable to export meals. Please try again.');
    } finally {
      setWorking(false);
    }
  }

  if (!open) return <button type="button" className="btn btn-secondary btn-sm" onClick={show}><Download size={15} /> Export</button>;
  return <section className="log-export card" aria-label="Export meal logs">
    <div className="log-export-heading"><h2>Export meal logs</h2><button type="button" className="icon-btn" aria-label="Close export" disabled={working} onClick={() => setOpen(false)}><X size={18} /></button></div>
    <p className="text-sm text-secondary">Choose a date or date range. Add more ranges or remove individual days.</p>
    <div className="log-export-date-row">
      <label>From<input type="date" value={start} onChange={(event) => setStart(event.target.value)} disabled={working} /></label>
      <label>To<input type="date" value={end} onChange={(event) => setEnd(event.target.value)} disabled={working} /></label>
      <button type="button" className="btn btn-secondary btn-sm" onClick={addDays} disabled={working}>Add days</button>
    </div>
    <div className="log-export-selection" aria-label="Selected days">
      {days.map((day) => <button type="button" key={day} className="log-export-day" disabled={working} aria-label={`Remove ${day}`} onClick={() => setDays(days.filter((item) => item !== day))}>{parseLocalDateString(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}<X size={13} /></button>)}
      {!days.length && <span className="text-sm text-secondary">No days selected</span>}
    </div>
    <p className="text-xs text-secondary">CSV includes meal names, date and time, macros, notes, and food items. Photos are not included.</p>
    {message && <p className="text-sm" role="status">{message}</p>}
    <button type="button" className="btn btn-primary btn-sm" disabled={working || !days.length} onClick={download}><Download size={15} /> {working ? 'Preparing export…' : `Download CSV (${days.length} ${days.length === 1 ? 'day' : 'days'})`}</button>
  </section>;
}

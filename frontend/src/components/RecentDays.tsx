import React, { useEffect, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { apiClient } from '../api/client';
import type { DashboardHistoryResponse } from '../types/api';
import { formatLongDate, getLocalDateString, getTzOffsetMinutes, parseLocalDateString, shiftDateString } from '../utils/date';

interface RecentDaysProps {
  selectedDate: string;
  onSelectDate: (date: string) => void;
  refreshKey: number;
}

export const RecentDays: React.FC<RecentDaysProps> = ({ selectedDate, onSelectDate, refreshKey }) => {
  const today = getLocalDateString();
  const [endDate, setEndDate] = useState(today);
  const [history, setHistory] = useState<DashboardHistoryResponse | null>(null);
  const [historyEnd, setHistoryEnd] = useState('');
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (selectedDate < shiftDateString(endDate, -6)) setEndDate(shiftDateString(selectedDate, 6));
    else if (selectedDate > endDate) setEndDate(selectedDate);
  }, [selectedDate, endDate]);

  useEffect(() => {
    let active = true;
    setError(false);
    apiClient.getDashboardHistory({ days: 7, endDate, tzOffsetMinutes: getTzOffsetMinutes() })
      .then((result) => { if (active) { setHistory(result); setHistoryEnd(endDate); } })
      .catch(() => { if (active) { setHistory(null); setError(true); } });
    return () => { active = false; };
  }, [endDate, refreshKey, retry]);

  const days = Array.from({ length: 7 }, (_, index) => shiftDateString(endDate, index - 6));
  const selectWeek = (delta: number) => {
    const nextEnd = shiftDateString(endDate, delta * 7);
    setEndDate(nextEnd);
    onSelectDate(delta < 0 ? nextEnd : shiftDateString(nextEnd, -6));
  };

  return (
    <section className="week-nav card" aria-label="Day selector">
      <div className="week-nav-header">
        <button type="button" className="icon-btn" aria-label="Previous seven days" onClick={() => selectWeek(-1)}><ChevronLeft size={18} /></button>
        <div className="week-nav-center">
          <label className="week-date-picker" title="Jump to date">
            <Calendar size={15} aria-hidden="true" />
            <span>{parseLocalDateString(selectedDate).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
            <input type="date" aria-label="Jump to date" value={selectedDate} onChange={(e) => { if (e.target.value) onSelectDate(e.target.value); }} />
          </label>
          {selectedDate !== today && <button type="button" className="week-today" onClick={() => { setEndDate(today); onSelectDate(today); }}>Today</button>}
        </div>
        <button type="button" className="icon-btn" aria-label="Next seven days" onClick={() => selectWeek(1)}><ChevronRight size={18} /></button>
      </div>
      <div className="week-days" aria-label="Choose a day">
        {days.map((day) => {
          const date = parseLocalDateString(day);
          const entry = historyEnd === endDate ? history?.series.find((item) => item.date === day) : undefined;
          const status = error ? 'goal status unavailable' : !entry ? 'goal status loading' : !entry.meal_count ? 'no meals logged' : entry.meeting_goals ? 'calorie and protein goals met' : 'both goals not yet met';
          return <button type="button" key={day} className={`week-day ${selectedDate === day ? 'is-selected' : ''}`} aria-pressed={selectedDate === day} aria-label={`${formatLongDate(day)}${day === today ? ', today' : ''}, ${status}`} title={status} onClick={() => onSelectDate(day)}>
            <span>{day === today ? 'Today' : date.toLocaleDateString(undefined, { weekday: 'short' })}</span>
            <strong>{date.getDate()}</strong>
            <i aria-hidden="true" className={`week-status ${entry?.meal_count ? (entry.meeting_goals ? 'is-met' : 'is-logged') : ''}`} />
          </button>;
        })}
      </div>
      <div className="week-legend">{error ? <button type="button" onClick={() => setRetry((n) => n + 1)}>Goals unavailable · Retry</button> : <><i className="week-status is-met" /> Both goals met</>}</div>
    </section>
  );
};

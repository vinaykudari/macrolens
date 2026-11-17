import React, { useEffect, useState } from 'react';
import { ArrowRight, CalendarDays } from 'lucide-react';
import { apiClient } from '../api/client';
import type { DashboardHistoryResponse } from '../types/api';
import { formatLongDate, getLocalDateString, getTzOffsetMinutes, parseLocalDateString } from '../utils/date';

interface RecentDaysProps {
  selectedDate: string;
  onSelectDate: (date: string) => void;
  refreshKey: number;
}

export const RecentDays: React.FC<RecentDaysProps> = ({ selectedDate, onSelectDate, refreshKey }) => {
  const [history, setHistory] = useState<DashboardHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const today = getLocalDateString();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    apiClient.getDashboardHistory({ days: 7, endDate: today, tzOffsetMinutes: getTzOffsetMinutes() })
      .then((result) => { if (active) setHistory(result); })
      .catch(() => { if (active) { setHistory(null); setError(true); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [today, refreshKey, retry]);

  return (
    <section className="recent-days card" aria-label="Recent daily goals" aria-busy={loading}>
      <div className="recent-days-header">
        <div>
          <div className="recent-days-eyebrow"><CalendarDays size={14} /> YOUR WEEK</div>
          <h2>Recent days</h2>
          <p>Choose a day to see its meals and totals.</p>
        </div>
        {history && !loading && <div className="recent-days-summary"><strong>{history.summary.days_both_met}<span> / {history.summary.days_logged}</span></strong><span>logged days met both goals</span></div>}
      </div>
      {error ? (
        <div className="recent-days-message" role="alert">Couldn’t load recent days. <button type="button" onClick={() => setRetry((n) => n + 1)}>Try again</button></div>
      ) : loading ? (
        <div className="recent-days-message" role="status">Loading recent days…</div>
      ) : history && (
        <>
          <div className="recent-days-list" aria-label="Select a recent day">
            {[...history.series].reverse().map((day) => {
              const date = parseLocalDateString(day.date);
              const logged = day.meal_count > 0;
              const isToday = day.date === today;
              const calorieStatus = day.calories_met ? 'Met' : day.calories_status === 'over' ? 'Over' : 'Under';
              const proteinStatus = day.protein_met ? 'Met' : 'Under';
              return (
                <button type="button" key={day.date} className={`recent-day ${selectedDate === day.date ? 'is-selected' : ''}`} aria-pressed={selectedDate === day.date} aria-label={`${formatLongDate(day.date)}${isToday ? ', today' : ''}, ${logged ? `calories ${calorieStatus}, protein ${proteinStatus}` : 'no meals logged'}`} onClick={() => onSelectDate(day.date)}>
                  <span className="recent-day-date"><span>{isToday ? 'Today' : date.toLocaleDateString(undefined, { weekday: 'short' })}</span><strong>{date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</strong></span>
                  {logged ? <>
                    <span className="recent-day-metric"><span>{Math.round(day.calories).toLocaleString()} <small>kcal</small></span><b className={day.calories_met ? 'is-met' : 'is-other'}>{calorieStatus}</b></span>
                    <span className="recent-day-metric"><span>{Math.round(day.protein_g)}<small>g protein</small></span><b className={day.protein_met ? 'is-met' : 'is-other'}>{proteinStatus}</b></span>
                  </> : <span className="recent-day-empty">No meals<br />logged</span>}
                  <span className="recent-day-link">View day <ArrowRight size={12} /></span>
                </button>
              );
            })}
          </div>
          <p className="recent-days-footnote">Compared with your current targets. Calories met at 90–105%; protein met at 90% or more. Today may still be in progress.</p>
        </>
      )}
    </section>
  );
};

import React from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import type { DailyDashboardResponse } from '../types/api';
import { formatDayLabel, formatLongDate, getLocalDateString, shiftDateString } from '../utils/date';

interface DashboardHeroProps {
  selectedDate: string;
  onChangeDate: (nextDate: string) => void;
  dashboard: DailyDashboardResponse | null;
  loading: boolean;
}

export const DashboardHero: React.FC<DashboardHeroProps> = ({ selectedDate, onChangeDate, dashboard, loading }) => {
  const today = getLocalDateString();
  const metrics = dashboard ? [
    { name: 'Calories', value: dashboard.consumed.calories, target: dashboard.targets.calories, unit: 'kcal', color: 'cal' },
    { name: 'Protein', value: dashboard.consumed.protein_g, target: dashboard.targets.protein_g, unit: 'g', color: 'pro' },
    { name: 'Carbs', value: dashboard.consumed.carbs_g, target: dashboard.targets.carbs_g, unit: 'g', color: 'carb' },
    { name: 'Fat', value: dashboard.consumed.fat_g, target: dashboard.targets.fat_g, unit: 'g', color: 'fat' },
  ] : [];

  return (
    <>
      <div className="day-nav" aria-label="Day selector">
        <button type="button" className="icon-btn" aria-label="Previous day" onClick={() => onChangeDate(shiftDateString(selectedDate, -1))}><ChevronLeft size={18} /></button>
        <div className="day-nav-center">
          <div className="day-pill">
            <Calendar size={15} color="var(--text-secondary)" />
            <span>{formatDayLabel(selectedDate)}</span>
            <input type="date" className="day-date-input" aria-label="Jump to date" value={selectedDate} onChange={(e) => { if (e.target.value) onChangeDate(e.target.value); }} />
          </div>
          {selectedDate !== today && <button type="button" className="today-jump-btn" onClick={() => onChangeDate(today)}>Today</button>}
        </div>
        <button type="button" className="icon-btn" aria-label="Next day" onClick={() => onChangeDate(shiftDateString(selectedDate, 1))}><ChevronRight size={18} /></button>
      </div>
      <section className="card daily-summary" aria-label="Daily calorie and macro progress" aria-busy={loading}>
        <div className="daily-summary-heading">
          <div><span className="daily-summary-eyebrow">{formatLongDate(selectedDate)}</span><h1>Daily totals</h1></div>
          {dashboard && <span className="daily-meal-count">{dashboard.meal_count} {dashboard.meal_count === 1 ? 'meal' : 'meals'}</span>}
        </div>
        {!dashboard ? <div className="skeleton daily-summary-loading" /> : (
          <div className="daily-metrics">
            {metrics.map(({ name, value, target, unit, color }) => {
              const current = Math.round(value);
              const goal = Math.round(target);
              const remaining = goal - current;
              const percent = target > 0 ? Math.min(100, Math.max(0, value / target * 100)) : 0;
              return <div className={`daily-metric daily-metric--${color}`} key={name}>
                <div className="daily-metric-name">{name}</div>
                <div className="daily-metric-value tabular"><strong>{current.toLocaleString()}</strong><span> / {goal.toLocaleString()} {unit}</span></div>
                <div className="daily-metric-track" role="progressbar" aria-label={`${name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><div className="daily-metric-fill" style={{ width: `${percent}%` }} /></div>
                {remaining < 0 && <div className="daily-metric-caption tabular">{Math.abs(remaining).toLocaleString()} {unit} over</div>}
              </div>;
            })}
          </div>
        )}
      </section>
    </>
  );
};

import React from 'react';
import type { DailyDashboardResponse } from '../types/api';
import { formatLongDate } from '../utils/date';

interface DashboardHeroProps {
  selectedDate: string;
  dashboard: DailyDashboardResponse | null;
  loading: boolean;
}

export const DashboardHero: React.FC<DashboardHeroProps> = ({ selectedDate, dashboard, loading }) => {
  const metrics = dashboard ? [
    { name: 'Calories', value: dashboard.consumed.calories, target: dashboard.targets.calories, unit: 'kcal', color: 'cal' },
    { name: 'Protein', value: dashboard.consumed.protein_g, target: dashboard.targets.protein_g, unit: 'g', color: 'pro' },
    { name: 'Carbs', value: dashboard.consumed.carbs_g, target: dashboard.targets.carbs_g, unit: 'g', color: 'carb' },
    { name: 'Fat', value: dashboard.consumed.fat_g, target: dashboard.targets.fat_g, unit: 'g', color: 'fat' },
  ] : [];

  return (
    <>
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

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Flame,
  Target,
  TrendingUp,
} from 'lucide-react';
import { apiClient } from '../api/client';
import type {
  DashboardHistoryResponse,
  HistoryDayPoint,
  MacroTargets,
} from '../types/api';
import {
  formatDayLabel,
  formatShortDate,
  formatWeekdayShort,
  getLocalDateString,
  getTzOffsetMinutes,
} from '../utils/date';

interface GoalChartsProps {
  selectedDate: string;
  onSelectDate: (dateStr: string) => void;
  activeTargets: MacroTargets;
  refreshKey: number;
}

type RangeDays = 7 | 14 | 30;

interface NormalizedDay {
  date: string;
  calories: number;
  protein_g: number;
  target_calories: number;
  target_protein_g: number;
  meal_count: number;
  calStatus: 'met' | 'under' | 'over' | 'empty';
  proStatus: 'met' | 'under' | 'empty';
  calMet: boolean;
  proMet: boolean;
  bothMet: boolean;
}

function normalizeHistoryDay(
  raw: HistoryDayPoint,
  fallbackTargets: MacroTargets
): NormalizedDay {
  const cal = Number(raw.calories ?? 0);
  const pro = Number(raw.protein_g ?? 0);
  const targetCal = Math.max(
    1,
    Number(raw.target_calories ?? fallbackTargets.calories ?? 2000)
  );
  const targetPro = Math.max(
    1,
    Number(raw.target_protein_g ?? fallbackTargets.protein_g ?? 150)
  );
  const mealCount = Number(raw.meal_count ?? 0);
  const hasLogs = mealCount > 0 || cal > 0 || pro > 0;

  const rawCalStatus = (raw.calories_status ?? '').toLowerCase();
  const rawProStatus = (raw.protein_status ?? '').toLowerCase();

  let calStatus: NormalizedDay['calStatus'] = 'empty';
  if (hasLogs) {
    if (rawCalStatus.includes('over')) calStatus = 'over';
    else if (rawCalStatus.includes('track') || rawCalStatus.includes('met')) calStatus = 'met';
    else if (rawCalStatus.includes('under')) calStatus = 'under';
    else if (cal > targetCal * 1.05) calStatus = 'over';
    else if (cal >= targetCal * 0.9) calStatus = 'met';
    else calStatus = 'under';
  }

  let proStatus: NormalizedDay['proStatus'] = 'empty';
  if (hasLogs) {
    if (rawProStatus.includes('met') || rawProStatus.includes('exceed')) proStatus = 'met';
    else if (rawProStatus.includes('under')) proStatus = 'under';
    else if (pro >= targetPro * 0.9) proStatus = 'met';
    else proStatus = 'under';
  }

  const calMet =
    typeof raw.calories_met === 'boolean' ? raw.calories_met : calStatus === 'met';
  const proMet =
    typeof raw.protein_met === 'boolean' ? raw.protein_met : proStatus === 'met';
  const bothMet =
    typeof raw.meeting_goals === 'boolean'
      ? raw.meeting_goals
      : calMet && proMet;

  return {
    date: raw.date,
    calories: cal,
    protein_g: pro,
    target_calories: targetCal,
    target_protein_g: targetPro,
    meal_count: mealCount,
    calStatus,
    proStatus,
    calMet,
    proMet,
    bothMet,
  };
}

interface MetricSvgChartProps {
  title: string;
  unit: string;
  accentColor: string;
  days: NormalizedDay[];
  metric: 'calories' | 'protein';
  selectedDate: string;
  hoveredDate: string | null;
  onHoverDate: (date: string | null) => void;
  onSelectDate: (date: string) => void;
}

const MetricSvgChart: React.FC<MetricSvgChartProps> = ({
  title,
  unit,
  accentColor,
  days,
  metric,
  selectedDate,
  hoveredDate,
  onHoverDate,
  onSelectDate,
}) => {
  const SVG_W = 360;
  const SVG_H = 128;
  const PAD_TOP = 14;
  const PAD_BOTTOM = 20;
  const PAD_X = 6;
  const PLOT_H = SVG_H - PAD_TOP - PAD_BOTTOM;
  const PLOT_W = SVG_W - PAD_X * 2;

  const targetVal = useMemo(() => {
    const last = days[days.length - 1];
    if (!last) return metric === 'calories' ? 2000 : 150;
    return metric === 'calories' ? last.target_calories : last.target_protein_g;
  }, [days, metric]);

  const maxVal = useMemo(() => {
    const vals = days.map((d) => (metric === 'calories' ? d.calories : d.protein_g));
    const peak = Math.max(targetVal * 1.15, ...vals, 1);
    return peak;
  }, [days, metric, targetVal]);

  const targetY = PAD_TOP + PLOT_H * (1 - targetVal / maxVal);

  const activeDay = useMemo(() => {
    const lookup = hoveredDate || selectedDate;
    return days.find((d) => d.date === lookup) || days[days.length - 1] || null;
  }, [days, hoveredDate, selectedDate]);

  const activeStatusBadge = (() => {
    if (!activeDay || activeDay.meal_count === 0 && activeDay.calories === 0) {
      return { text: 'No Data', cls: 'status-badge--track' };
    }
    if (metric === 'calories') {
      if (activeDay.calStatus === 'met') return { text: 'Goal Met', cls: 'status-badge--met' };
      if (activeDay.calStatus === 'over') return { text: 'Over', cls: 'status-badge--over' };
      return { text: 'Under', cls: 'status-badge--track' };
    }
    if (activeDay.proStatus === 'met') return { text: 'Goal Met', cls: 'status-badge--met' };
    return { text: 'Under', cls: 'status-badge--track' };
  })();

  const activeIndex = activeDay
    ? days.findIndex((d) => d.date === activeDay.date)
    : -1;
  const tooltipLeftPct =
    activeIndex >= 0 && days.length > 0
      ? Math.min(82, Math.max(18, ((activeIndex + 0.5) / days.length) * 100))
      : 50;

  const count = Math.max(1, days.length);
  const step = PLOT_W / count;
  const barW = Math.max(4, Math.min(24, step * 0.62));

  return (
    <div className="chart-panel">
      <div className="chart-panel-head">
        <div className="chart-panel-title-wrap">
          <span
            className="chart-dot"
            style={{ backgroundColor: accentColor }}
          />
          <span className="chart-panel-title">{title}</span>
        </div>

        <div className="chart-panel-readout tabular">
          {activeDay ? (
            <>
              <span className="chart-readout-date">
                {formatShortDate(activeDay.date)}
              </span>
              <strong>
                {Math.round(
                  metric === 'calories' ? activeDay.calories : activeDay.protein_g
                ).toLocaleString()}
                {unit}
              </strong>
              <span className="chart-readout-target">
                / {Math.round(targetVal).toLocaleString()}
                {unit}
              </span>
              <span className={`status-badge ${activeStatusBadge.cls}`}>
                {activeStatusBadge.text}
              </span>
            </>
          ) : (
            <span className="chart-readout-target">No history</span>
          )}
        </div>
      </div>

      <div
        className="chart-svg-wrap"
        onMouseLeave={() => onHoverDate(null)}
      >
        {hoveredDate && activeDay && (
          <div
            className="chart-floating-tip tabular"
            style={{ left: `${tooltipLeftPct}%` }}
          >
            <span>{formatDayLabel(activeDay.date)}:</span>
            <strong>
              {Math.round(activeDay.calories).toLocaleString()} kcal ·{' '}
              {Math.round(activeDay.protein_g)}g P
            </strong>
          </div>
        )}

        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          className="chart-svg"
          role="img"
          aria-label={`${title} history chart`}
        >
          {/* Baseline */}
          <line
            x1={PAD_X}
            y1={PAD_TOP + PLOT_H}
            x2={SVG_W - PAD_X}
            y2={PAD_TOP + PLOT_H}
            stroke="var(--border-subtle)"
            strokeWidth="1"
          />

          {/* Target dashed reference line */}
          <line
            x1={PAD_X}
            y1={targetY}
            x2={SVG_W - PAD_X}
            y2={targetY}
            stroke={accentColor}
            strokeOpacity="0.65"
            strokeWidth="1.25"
            strokeDasharray="4 3"
          />
          <text
            x={SVG_W - PAD_X - 2}
            y={Math.max(10, targetY - 4)}
            textAnchor="end"
            fill={accentColor}
            fillOpacity="0.85"
            fontSize="8.5"
            fontWeight="700"
          >
            Target {Math.round(targetVal).toLocaleString()}
            {unit}
          </text>

          {/* Bars */}
          {days.map((d, idx) => {
            const val = metric === 'calories' ? d.calories : d.protein_g;
            const barH = val > 0 ? Math.max(3, (val / maxVal) * PLOT_H) : 2;
            const x = PAD_X + idx * step + (step - barW) / 2;
            const y = PAD_TOP + PLOT_H - barH;
            const isSelected = d.date === selectedDate;
            const isHovered = d.date === hoveredDate;

            let fill = 'var(--fill-3)';
            if (metric === 'calories') {
              if (d.calStatus === 'met') fill = 'var(--status-met-text)';
              else if (d.calStatus === 'over') fill = 'var(--status-over-text)';
              else if (d.calStatus === 'under') fill = 'var(--cal-1)';
            } else {
              if (d.proStatus === 'met') fill = 'var(--pro-1)';
              else if (d.proStatus === 'under') fill = 'var(--status-track-text)';
            }

            const showAxisLabel =
              days.length <= 7 ||
              idx === 0 ||
              idx === days.length - 1 ||
              (days.length <= 14 ? idx % 3 === 0 : idx % 7 === 0);

            return (
              <g
                key={d.date}
                className="chart-bar-group"
                onMouseEnter={() => onHoverDate(d.date)}
                onClick={() => onSelectDate(d.date)}
              >
                {/* Invisible generous hit zone */}
                <rect
                  x={PAD_X + idx * step}
                  y={PAD_TOP}
                  width={step}
                  height={PLOT_H + PAD_BOTTOM}
                  fill="transparent"
                />

                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={barH}
                  rx={Math.min(4, barW / 2)}
                  fill={fill}
                  fillOpacity={isSelected || isHovered ? 1 : val > 0 ? 0.82 : 0.45}
                  stroke={isSelected ? 'var(--text-primary)' : 'none'}
                  strokeWidth={isSelected ? 1.4 : 0}
                />

                {showAxisLabel && (
                  <text
                    x={PAD_X + idx * step + step / 2}
                    y={SVG_H - 5}
                    textAnchor="middle"
                    fill={isSelected ? 'var(--text-primary)' : 'var(--text-muted)'}
                    fontSize="8.5"
                    fontWeight={isSelected ? '700' : '600'}
                  >
                    {days.length <= 7
                      ? formatWeekdayShort(d.date)
                      : formatShortDate(d.date).replace(/\s+/g, ' ')}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
};

export const GoalCharts: React.FC<GoalChartsProps> = ({
  selectedDate,
  onSelectDate,
  activeTargets,
  refreshKey,
}) => {
  const [rangeDays, setRangeDays] = useState<RangeDays>(14);
  const [history, setHistory] = useState<DashboardHistoryResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);

  const endDate = useMemo(() => {
    const today = getLocalDateString();
    return selectedDate > today ? selectedDate : today;
  }, [selectedDate]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    apiClient
      .getDashboardHistory({
        days: rangeDays,
        endDate,
        tzOffsetMinutes: getTzOffsetMinutes(),
      })
      .then((res) => {
        if (!active) return;
        setHistory(res);
      })
      .catch(() => {
        if (!active) return;
        setError('Goal trends unavailable right now.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [rangeDays, endDate, refreshKey]);

  const normalizedDays = useMemo(() => {
    const rawDays = Array.isArray(history?.series) ? history.series : [];
    const fallback = history?.targets ?? activeTargets;
    return rawDays.map((d) => normalizeHistoryDay(d, fallback));
  }, [history, activeTargets]);

  const summaryStats = useMemo(() => {
    const totalDays = history?.days ?? (normalizedDays.length || rangeDays);
    const calMet =
      history?.summary?.days_calories_met ??
      normalizedDays.filter((d) => d.calMet).length;
    const proMet =
      history?.summary?.days_protein_met ??
      normalizedDays.filter((d) => d.proMet).length;
    const bothMet =
      history?.summary?.days_both_met ??
      normalizedDays.filter((d) => d.bothMet).length;
    const streak = history?.summary?.current_streak ?? 0;
    return { totalDays, calMet, proMet, bothMet, streak };
  }, [history, normalizedDays, rangeDays]);

  return (
    <section className="card card-padded charts-card" aria-label="Goal trends and consistency">
      <div className="charts-top-bar">
        <div>
          <h2 className="section-title section-title-row">
            <TrendingUp size={17} color="var(--pro-1)" />
            <span>Goal Progress</span>
          </h2>
          <p className="section-sub">Tap any bar or day to inspect that day&apos;s log</p>
        </div>

        <div className="unit-toggle" role="group" aria-label="History window">
          {([7, 14, 30] as const).map((daysOpt) => (
            <button
              key={daysOpt}
              type="button"
              className={`unit-toggle-btn ${rangeDays === daysOpt ? 'is-active' : ''}`}
              onClick={() => setRangeDays(daysOpt)}
            >
              {daysOpt}D
            </button>
          ))}
        </div>
      </div>

      {/* Summary Chips */}
      <div className="history-chips-row tabular">
        <span className="history-chip history-chip--cal">
          <Target size={13} />
          <span>
            Cal Met: <strong>{summaryStats.calMet}/{summaryStats.totalDays}</strong>
          </span>
        </span>
        <span className="history-chip history-chip--pro">
          <CheckCircle2 size={13} />
          <span>
            Protein Met: <strong>{summaryStats.proMet}/{summaryStats.totalDays}</strong>
          </span>
        </span>
        <span className="history-chip history-chip--both">
          <span>
            Both: <strong>{summaryStats.bothMet}</strong>
          </span>
        </span>
        <span className="history-chip history-chip--streak">
          <Flame size={13} />
          <span>
            Streak: <strong>{summaryStats.streak}d</strong>
          </span>
        </span>
      </div>

      {error ? (
        <div className="charts-error-msg">
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      ) : loading && normalizedDays.length === 0 ? (
        <div className="stack-sm">
          <div className="skeleton charts-skeleton-strip" />
          <div className="skeleton charts-skeleton-body" />
        </div>
      ) : (
        <>
          {/* Goal Attainment Calendar Strip */}
          {normalizedDays.length > 0 && (
            <div className="attainment-strip-wrap">
              <div
                className={`attainment-grid ${
                  normalizedDays.length > 14 ? 'attainment-grid--dense' : ''
                }`}
              >
                {normalizedDays.map((d) => {
                  const isSelected = d.date === selectedDate;
                  let stateClass = 'is-empty';
                  if (d.bothMet) stateClass = 'is-both';
                  else if (d.proMet || d.calMet) stateClass = 'is-partial';
                  else if (d.meal_count > 0 || d.calories > 0) stateClass = 'is-logged';

                  const dayNum = d.date.split('-')[2]?.replace(/^0/, '') || '';

                  return (
                    <button
                      key={d.date}
                      type="button"
                      className={`attainment-cell ${stateClass} ${
                        isSelected ? 'is-selected' : ''
                      }`}
                      title={`${formatDayLabel(d.date)}: ${Math.round(
                        d.calories
                      )} kcal, ${Math.round(d.protein_g)}g protein`}
                      onClick={() => onSelectDate(d.date)}
                    >
                      <span className="attainment-wk">
                        {formatWeekdayShort(d.date).slice(0, 1)}
                      </span>
                      <span className="attainment-num tabular">{dayNum}</span>
                      <span className="attainment-dots" aria-hidden="true">
                        <span
                          className={`mini-dot ${d.calMet ? 'is-cal-hit' : ''}`}
                        />
                        <span
                          className={`mini-dot ${d.proMet ? 'is-pro-hit' : ''}`}
                        />
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="attainment-legend">
                <span>
                  <i className="legend-swatch legend-swatch--both" /> Both goals
                </span>
                <span>
                  <i className="legend-swatch legend-swatch--partial" /> Cal or Protein
                </span>
                <span>
                  <i className="legend-swatch legend-swatch--logged" /> Logged
                </span>
              </div>
            </div>
          )}

          {/* Dual Interactive SVG Bar Charts */}
          <div className="charts-grid">
            <MetricSvgChart
              title="Calories vs Target"
              unit=" kcal"
              accentColor="var(--cal-1)"
              days={normalizedDays}
              metric="calories"
              selectedDate={selectedDate}
              hoveredDate={hoveredDate}
              onHoverDate={setHoveredDate}
              onSelectDate={onSelectDate}
            />

            <MetricSvgChart
              title="Protein vs Target"
              unit="g"
              accentColor="var(--pro-1)"
              days={normalizedDays}
              metric="protein"
              selectedDate={selectedDate}
              hoveredDate={hoveredDate}
              onHoverDate={setHoveredDate}
              onSelectDate={onSelectDate}
            />
          </div>
        </>
      )}
    </section>
  );
};

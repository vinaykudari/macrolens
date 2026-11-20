import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Clock,
  CopyPlus,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Utensils,
  X,
} from 'lucide-react';
import { apiClient, ApiError } from '../api/client';
import type { DailyDashboardResponse, MealRecord, PaginatedMealsResponse } from '../types/api';
import { formatMealDateTime, formatLongDate, getLocalDateString, getTzOffsetMinutes, normalizeIsoTimestamp, parseLocalDateString, shiftDateString } from '../utils/date';
import { getDisplayMealItems } from '../utils/mealItems';
import { MealPhotoThumbnail, PhotoLightboxModal } from './MealPhoto';
import { LogExport } from './LogExport';
import type { SnapInitialTab } from './SnapMealSheet';

interface LogsViewProps {
  refreshKey: number;
  selectedDate: string;
  dashboard: DailyDashboardResponse | null;
  onSelectDate: (date: string) => void;
  onEditMeal: (meal: MealRecord) => void;
  onDeleteMeal: (mealId: string | number) => Promise<void>;
  onDuplicateMeal: (meal: MealRecord) => Promise<void>;
  onOpenSnap: (tab?: SnapInitialTab) => void;
}

const PAGE_SIZE = 12;

function getPageNumbers(current: number, totalPages: number): number[] {
  if (totalPages <= 1) return [1];
  const pages = new Set<number>([1, totalPages, current]);
  if (current - 1 >= 1) pages.add(current - 1);
  if (current + 1 <= totalPages) pages.add(current + 1);
  return Array.from(pages).sort((a, b) => a - b);
}

export const LogsView: React.FC<LogsViewProps> = ({
  refreshKey,
  selectedDate,
  dashboard,
  onSelectDate,
  onEditMeal,
  onDeleteMeal,
  onDuplicateMeal,
  onOpenSnap,
}) => {
  const [searchInput, setSearchInput] = useState<string>('');
  const [debouncedQuery, setDebouncedQuery] = useState<string>('');
  const [allHistory, setAllHistory] = useState(false);
  const requestRef = useRef(0);
  const [page, setPage] = useState<number>(1);

  const [data, setData] = useState<PaginatedMealsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | number | null>(null);
  const [busyId, setBusyId] = useState<string | number | null>(null);
  const [lightboxMeal, setLightboxMeal] = useState<MealRecord | null>(null);

  // Debounce search query and reset to page 1 on filter changes
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(searchInput.trim());
      setPage(1);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const loadLogs = useCallback(async () => {
    const request = ++requestRef.current;
    setData(null);
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.getMealLogs({
        page,
        pageSize: PAGE_SIZE,
        date: allHistory ? undefined : selectedDate,
        tzOffsetMinutes: getTzOffsetMinutes(),
        q: debouncedQuery || undefined,
      });
      if (request !== requestRef.current) return;
      // If deleting last item on a page left it out of bounds, snap back cleanly
      if (res.total_pages > 0 && page > res.total_pages) {
        setPage(res.total_pages);
        return;
      }
      setData(res);
    } catch (err) {
      if (request !== requestRef.current) return;
      setError(
        err instanceof ApiError ? err.message : 'Unable to load meal history.'
      );
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [page, selectedDate, allHistory, debouncedQuery]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs, refreshKey]);

  const goToPage = (nextPage: number) => {
    setPage(nextPage);
    setConfirmDeleteId(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDelete = async (id: string | number) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    setBusyId(id);
    try {
      await onDeleteMeal(id);
    } finally {
      setBusyId(null);
      setConfirmDeleteId(null);
    }
  };

  const handleDuplicate = async (meal: MealRecord) => {
    setBusyId(meal.id);
    try {
      await onDuplicateMeal(meal);
    } finally {
      setBusyId(null);
    }
  };

  const pageNumbers = useMemo(
    () => getPageNumbers(data?.page ?? page, data?.total_pages ?? 1),
    [data?.page, data?.total_pages, page]
  );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, data?.total_pages ?? 1);

  return (
    <div className="logs-layout">
      <section className="logs-calendar card" aria-label="Choose a day">
        <div className="logs-calendar-heading">
          <h1>Meal logs</h1>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpenSnap('photo')}><Plus size={15} /> Add meal</button>
        </div>
        <div className="logs-calendar-controls">
          <button type="button" className="icon-btn" aria-label="Previous week" onClick={() => { onSelectDate(shiftDateString(selectedDate, -7)); setAllHistory(false); setPage(1); }}><ChevronLeft size={18} /></button>
          <strong>{formatLongDate(selectedDate)}</strong>
          <button type="button" className="icon-btn" aria-label="Next week" onClick={() => { onSelectDate(shiftDateString(selectedDate, 7)); setAllHistory(false); setPage(1); }}><ChevronRight size={18} /></button>
        </div>
        <div className="logs-days" aria-label="Days around selected date">
          {Array.from({ length: 7 }, (_, index) => shiftDateString(selectedDate, index - 3)).map((day) => {
            const date = parseLocalDateString(day);
            return <button key={day} type="button" className={`logs-day ${day === selectedDate && !allHistory ? 'is-selected' : ''}`} aria-pressed={day === selectedDate && !allHistory} aria-label={formatLongDate(day)} onClick={() => { onSelectDate(day); setAllHistory(false); setPage(1); }}><span>{date.toLocaleDateString(undefined, { weekday: 'short' })}</span><strong>{date.getDate()}</strong></button>;
          })}
        </div>
        <div className="logs-date-actions">
          <label className="logs-date-picker"><span>Jump to date</span><input type="date" value={selectedDate} aria-label="Jump to date" onChange={(e) => { if (e.target.value) { onSelectDate(e.target.value); setAllHistory(false); setPage(1); } }} /></label>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { onSelectDate(getLocalDateString()); setAllHistory(false); setPage(1); }}>Today</button>
        </div>
      </section>
      <LogExport selectedDate={selectedDate} />
      <div className="logs-list-heading"><h2>{allHistory ? 'All meals' : formatLongDate(selectedDate)}</h2><span>{total} {total === 1 ? 'meal' : 'meals'}</span></div>
      {!allHistory && dashboard?.date === selectedDate && <div className="logs-day-totals" aria-label="Daily totals"><span>{Math.round(dashboard.consumed.calories).toLocaleString()} kcal</span><span>{Math.round(dashboard.consumed.protein_g)}g protein</span><span>{Math.round(dashboard.consumed.carbs_g)}g carbs</span><span>{Math.round(dashboard.consumed.fat_g)}g fat</span></div>}
      <div className="logs-search-row">
        <div className="search-input-wrap"><Search size={16} className="search-input-icon" /><input type="search" className="input input-compact search-input" placeholder="Search meals" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} aria-label="Search meals or notes" />{searchInput && <button type="button" className="search-clear-btn" aria-label="Clear search" onClick={() => setSearchInput('')}><X size={15} /></button>}</div>
        <button type="button" className="btn btn-secondary btn-sm" aria-pressed={allHistory} onClick={() => { setAllHistory((prev) => !prev); setPage(1); }}>{allHistory ? 'Selected day' : 'All history'}</button>
      </div>

      {error && (
        <div className="error-box" role="alert">
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{error}</span>
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="feed-list">
          <div className="skeleton" style={{ height: 160 }} />
          <div className="skeleton" style={{ height: 160 }} />
          <div className="skeleton" style={{ height: 160 }} />
        </div>
      ) : items.length === 0 ? (
        <div className="card empty-feed">
          <div className="empty-feed-copy"><h3>{debouncedQuery ? 'No matching meals' : 'No meals yet'}</h3><p>{allHistory ? 'Try another search.' : 'Add a meal for this day.'}</p></div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpenSnap('photo')}><Plus size={15} /> Add meal</button>
        </div>
      ) : (
        <div className={`feed-list ${loading ? 'is-refreshing' : ''}`}>
          {items.map((meal) => {
            const isBusy = busyId === meal.id;
            const isConfirmingDelete = confirmDeleteId === meal.id;
            const displayItems = getDisplayMealItems(meal);
            const showPhoto = Boolean(meal.has_photo && meal.photo_url);
            const showMultiplier =
              typeof meal.portion_multiplier === 'number' &&
              Math.abs(meal.portion_multiplier - 1) > 0.01;

            return (
              <article key={String(meal.id)} className="card log-entry-card">
                <div className="log-entry-head">
                  {showPhoto && meal.photo_url && (
                    <MealPhotoThumbnail
                      photoUrl={meal.photo_url}
                      mealName={meal.meal_name}
                      size="md"
                      onOpenLightbox={() => setLightboxMeal(meal)}
                    />
                  )}

                  <div className="log-entry-summary">
                    <div className="meal-meta-row">
                      <span className="time-badge tabular">
                        <Clock size={11} />
                        <span>{formatMealDateTime(meal.logged_at)}</span>
                      </span>

                      <span className="source-badge">
                        {meal.source === 'photo' ? (
                          <>
                            <span aria-hidden="true">●</span>
                            <span>AI Snap</span>
                          </>
                        ) : meal.source === 'text' ? (
                          <>
                            <Sparkles size={11} />
                            <span>AI Describe</span>
                          </>
                        ) : (
                          <>
                            <Utensils size={11} />
                            <span>Quick Log</span>
                          </>
                        )}
                      </span>

                      {showMultiplier && (
                        <span className="source-badge tabular">
                          {meal.portion_multiplier}x portion
                        </span>
                      )}
                    </div>

                    <h2 className="log-entry-title">{meal.meal_name}</h2>

                    <div className="meal-macros-row">
                      <span className="macro-pill macro-pill--cal">
                        {Math.round(meal.calories).toLocaleString()} kcal
                      </span>
                      <span className="macro-pill macro-pill--pro">
                        {Math.round(meal.protein_g)}g P
                      </span>
                      <span className="macro-pill macro-pill--carb">
                        {Math.round(meal.carbs_g)}g C
                      </span>
                      <span className="macro-pill macro-pill--fat">
                        {Math.round(meal.fat_g)}g F
                      </span>
                    </div>
                  </div>
                </div>

                {/* Always-visible itemized per-food macro breakdown */}
                {displayItems.length > 0 && (
                  <div className="log-items-section">
                    <div className="log-items-label">
                      Items Breakdown ({displayItems.length})
                    </div>
                    <div className="log-items-grid">
                      {displayItems.map((item, idx) => (
                        <div key={`${meal.id}-logitem-${idx}`} className="log-item-pill-row">
                          <div className="log-item-left">
                            <span className="log-item-name">{item.name}</span>
                            {(item.portion_description || item.estimated_grams > 0) && (
                              <span className="log-item-portion tabular">
                                {item.portion_description}
                                {item.estimated_grams > 0
                                  ? `${item.portion_description ? ' · ' : ''}~${Math.round(
                                      item.estimated_grams
                                    )}g`
                                  : ''}
                              </span>
                            )}
                          </div>

                          <div className="log-item-right tabular">
                            <span className="log-item-kcal">
                              {Math.round(item.calories)} kcal
                            </span>
                            <span className="log-item-pro">
                              {Math.round(item.protein_g)}g P
                            </span>
                            <span className="log-item-cf">
                              {Math.round(item.carbs_g)}C · {Math.round(item.fat_g)}F
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {meal.notes && (
                  <div className="meal-notes-box">{meal.notes}</div>
                )}

                <div className="meal-actions-row">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={isBusy}
                    onClick={() => handleDuplicate(meal)}
                  >
                    <CopyPlus size={14} />
                    <span>Log Again</span>
                  </button>

                  <div className="meal-actions-group">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={isBusy}
                      onClick={() => { setAllHistory(false); setPage(1); onSelectDate(getLocalDateString(normalizeIsoTimestamp(meal.logged_at))); onEditMeal(meal); }}
                    >
                      <Pencil size={14} />
                      <span>Edit</span>
                    </button>

                    <button
                      type="button"
                      className="btn btn-danger-ghost btn-sm"
                      disabled={isBusy}
                      onClick={() => handleDelete(meal.id)}
                    >
                      <Trash2 size={14} />
                      <span>{isConfirmingDelete ? 'Confirm Delete' : 'Delete'}</span>
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Server-Side Pagination Controls */}
      {total > 0 && (
        <nav className="pagination-bar" aria-label="Meal logs pagination">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!data?.has_prev || loading}
            onClick={() => goToPage(Math.max(1, (data?.page ?? page) - 1))}
          >
            <ChevronLeft size={16} />
            <span>Previous</span>
          </button>

          <div className="pagination-center">
            <span className="pagination-mobile-text tabular">
              Page {data?.page ?? page} of {totalPages}
            </span>

            <div className="pagination-desktop-pages">
              {pageNumbers.map((num, idx) => {
                const prevNum = pageNumbers[idx - 1];
                const showEllipsis = prevNum !== undefined && num - prevNum > 1;
                return (
                  <React.Fragment key={num}>
                    {showEllipsis && (
                      <span className="pagination-ellipsis">…</span>
                    )}
                    <button
                      type="button"
                      className={`page-num-btn tabular ${
                        num === (data?.page ?? page) ? 'is-active' : ''
                      }`}
                      disabled={loading}
                      onClick={() => goToPage(num)}
                    >
                      {num}
                    </button>
                  </React.Fragment>
                );
              })}
            </div>
          </div>

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!data?.has_next || loading}
            onClick={() => goToPage((data?.page ?? page) + 1)}
          >
            <span>Next</span>
            <ChevronRight size={16} />
          </button>
        </nav>
      )}

      <PhotoLightboxModal
        meal={lightboxMeal}
        onClose={() => setLightboxMeal(null)}
      />
    </div>
  );
};

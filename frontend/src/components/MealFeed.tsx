import React, { useMemo, useState } from 'react';
import {
  Camera,
  Utensils,
  ChevronDown,
  ChevronUp,
  Clock,
  CopyPlus,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { MealRecord } from '../types/api';
import { formatDayLabel, formatMealTime, normalizeIsoTimestamp } from '../utils/date';
import { getDisplayMealItems } from '../utils/mealItems';
import { MealPhotoThumbnail, PhotoLightboxModal } from './MealPhoto';
import type { SnapInitialTab } from './SnapMealSheet';

interface MealFeedProps {
  selectedDate: string;
  meals: MealRecord[];
  loading: boolean;
  onEditMeal: (meal: MealRecord) => void;
  onDeleteMeal: (mealId: string | number) => Promise<void>;
  onDuplicateMeal: (meal: MealRecord) => Promise<void>;
  onOpenSnap: (initialTab?: SnapInitialTab) => void;
}


export const MealFeed: React.FC<MealFeedProps> = ({
  selectedDate,
  meals,
  loading,
  onEditMeal,
  onDeleteMeal,
  onDuplicateMeal,
  onOpenSnap,
}) => {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | number | null>(null);
  const [busyId, setBusyId] = useState<string | number | null>(null);
  const [lightboxMeal, setLightboxMeal] = useState<MealRecord | null>(null);

  const sortedMeals = useMemo(() => {
    return [...meals].sort(
      (a, b) =>
        normalizeIsoTimestamp(a.logged_at).getTime() -
        normalizeIsoTimestamp(b.logged_at).getTime()
    );
  }, [meals]);

  const toggleExpand = (id: string | number) => {
    const key = String(id);
    setExpandedIds((prev) => ({ ...prev, [key]: !prev[key] }));
    if (confirmDeleteId === id) {
      setConfirmDeleteId(null);
    }
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

  return (
    <section aria-label="Chronological meal feed" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="feed-header">
        <h2 className="feed-title">
          <span>{formatDayLabel(selectedDate)}&apos;s Log</span>
          <span className="count-pill tabular">{sortedMeals.length}</span>
        </h2>

        {sortedMeals.length > 0 && <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onOpenSnap('photo')}
        >
          <Plus size={15} />
          <span>Add meal</span>
        </button>}
      </div>

      {loading && sortedMeals.length === 0 ? (
        <div className="feed-list">
          <div className="skeleton" style={{ height: 104 }} />
          <div className="skeleton" style={{ height: 104 }} />
        </div>
      ) : sortedMeals.length === 0 ? (
        <div className="card empty-feed">
          <div className="empty-feed-copy"><h3>No meals yet</h3><p>Add your first meal.</p></div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpenSnap('photo')}>
            <Plus size={16} /><span>Add meal</span>
          </button>
        </div>
      ) : (
        <div className="feed-list">
          {sortedMeals.map((meal) => {
            const isExpanded = Boolean(expandedIds[String(meal.id)]);
            const isBusy = busyId === meal.id;
            const isConfirmingDelete = confirmDeleteId === meal.id;
            const displayItems = getDisplayMealItems(meal);
            const hasItems = displayItems.length > 0;
            const showPhoto = Boolean(meal.has_photo && meal.photo_url);
            const showMultiplier =
              typeof meal.portion_multiplier === 'number' &&
              Math.abs(meal.portion_multiplier - 1) > 0.01;

            return (
              <article key={String(meal.id)} className="meal-card">
                <div className="meal-card-row">
                  {showPhoto && meal.photo_url && (
                    <div className="meal-card-thumb-col">
                      <MealPhotoThumbnail
                        photoUrl={meal.photo_url}
                        mealName={meal.meal_name}
                        size="sm"
                        onOpenLightbox={() => setLightboxMeal(meal)}
                      />
                    </div>
                  )}

                  <button
                    type="button"
                    className="meal-card-main"
                    onClick={() => toggleExpand(meal.id)}
                    aria-expanded={isExpanded}
                  >
                    <div className="meal-card-top">
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="meal-meta-row">
                          <span className="time-badge tabular">
                            <Clock size={11} />
                            <span>{formatMealTime(meal.logged_at)}</span>
                          </span>

                          <span className="source-badge">
                            {meal.source === 'photo' ? (
                              <>
                                <Camera size={11} />
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

                        <h3 className="meal-title">{meal.meal_name}</h3>
                      </div>

                      <span
                        style={{
                          color: 'var(--text-muted)',
                          paddingTop: 4,
                          flexShrink: 0,
                        }}
                      >
                        {isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                      </span>
                    </div>

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
                  </button>
                </div>

                {isExpanded && (
                  <div className="meal-expanded">
                    {hasItems && (
                      <div className="meal-items-list">
                        {displayItems.map((item, idx) => (
                          <div key={`${meal.id}-item-${idx}`} className="meal-item-row">
                            <div style={{ minWidth: 0 }}>
                              <div className="meal-item-name">{item.name}</div>
                              <div className="meal-item-portion tabular">
                                {item.portion_description}
                                {item.estimated_grams > 0
                                  ? ` · ~${Math.round(item.estimated_grams)}g`
                                  : ''}
                              </div>
                            </div>
                            <div className="meal-item-macros tabular">
                              <strong>{Math.round(item.calories)} kcal</strong>
                              <div>
                                {Math.round(item.protein_g)}P · {Math.round(item.carbs_g)}C ·{' '}
                                {Math.round(item.fat_g)}F
                              </div>
                            </div>
                          </div>
                        ))}
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
                          onClick={() => onEditMeal(meal)}
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
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <PhotoLightboxModal
        meal={lightboxMeal}
        onClose={() => setLightboxMeal(null)}
      />
    </section>
  );
};

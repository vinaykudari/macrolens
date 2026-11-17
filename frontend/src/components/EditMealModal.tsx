import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  Calendar,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Loader2,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { apiClient, ApiError } from '../api/client';
import type { MealItem, MealRecord } from '../types/api';
import {
  combineDateAndTimeToIso,
  getLocalDateString,
  normalizeIsoTimestamp,
  toTimeInputValue,
} from '../utils/date';
import { getDisplayMealItems } from '../utils/mealItems';
import { VoiceDictateButton } from './VoiceDictateButton';

interface EditMealModalProps {
  meal: MealRecord | null;
  onClose: () => void;
  onUpdated: (updated: MealRecord) => void;
}

const MULTIPLIERS = [0.5, 0.75, 1, 1.5, 2] as const;

function scaleRound(val: number, factor: number, decimals = 1): number {
  const p = Math.pow(10, decimals);
  return Math.round(val * factor * p) / p;
}

export const EditMealModal: React.FC<EditMealModalProps> = ({
  meal,
  onClose,
  onUpdated,
}) => {
  const [mealName, setMealName] = useState<string>('');
  const [dateStr, setDateStr] = useState<string>(() => getLocalDateString());
  const [timeStr, setTimeStr] = useState<string>('12:00');
  const [multiplier, setMultiplier] = useState<number>(1);
  const [calories, setCalories] = useState<string>('0');
  const [protein, setProtein] = useState<string>('0');
  const [carbs, setCarbs] = useState<string>('0');
  const [fat, setFat] = useState<string>('0');
  const [notes, setNotes] = useState<string>('');
  const [items, setItems] = useState<MealItem[]>([]);

  // Conversational refinement
  const [instruction, setInstruction] = useState<string>('');
  const [refining, setRefining] = useState<boolean>(false);
  const [refineAppliedNote, setRefineAppliedNote] = useState<string | null>(null);
  const [showManualNumbers, setShowManualNumbers] = useState<boolean>(false);

  // Store 1x baseline so switching multiplier chips never drifts
  const [baseMacros, setBaseMacros] = useState({
    calories: 0,
    protein_g: 0,
    carbs_g: 0,
    fat_g: 0,
  });
  const [baseItems, setBaseItems] = useState<MealItem[]>([]);

  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!meal) return;
    const oldMult =
      meal.portion_multiplier && meal.portion_multiplier > 0
        ? meal.portion_multiplier
        : 1;

    setMealName(meal.meal_name);
    setDateStr(getLocalDateString(normalizeIsoTimestamp(meal.logged_at)));
    setTimeStr(toTimeInputValue(meal.logged_at));
    setMultiplier(oldMult);
    setCalories(String(Math.round(meal.calories)));
    setProtein(String(Math.round(meal.protein_g * 10) / 10));
    setCarbs(String(Math.round(meal.carbs_g * 10) / 10));
    setFat(String(Math.round(meal.fat_g * 10) / 10));
    setNotes(meal.notes || '');

    const displayItems = getDisplayMealItems(meal);
    setItems(displayItems);

    setBaseMacros({
      calories: meal.calories / oldMult,
      protein_g: meal.protein_g / oldMult,
      carbs_g: meal.carbs_g / oldMult,
      fat_g: meal.fat_g / oldMult,
    });
    setBaseItems(
      displayItems.map((it) => ({
        ...it,
        estimated_grams: it.estimated_grams / oldMult,
        calories: it.calories / oldMult,
        protein_g: it.protein_g / oldMult,
        carbs_g: it.carbs_g / oldMult,
        fat_g: it.fat_g / oldMult,
      }))
    );

    setInstruction('');
    setRefineAppliedNote(null);
    setShowManualNumbers(false);
    setError(null);
  }, [meal]);

  if (!meal) return null;

  const handleApplyRefine = async () => {
    const trimmed = instruction.trim();
    if (!trimmed) {
      setError('Describe the change you want to make first.');
      return;
    }
    setError(null);
    setRefining(true);
    try {
      const refined = await apiClient.refineMeal(meal.id, trimmed, {
        meal_name: mealName.trim() || meal.meal_name,
        notes,
        items,
        total: { calories: Number(calories) || 0, protein_g: Number(protein) || 0, carbs_g: Number(carbs) || 0, fat_g: Number(fat) || 0 },
      });
      const nextItems = Array.isArray(refined.items) ? refined.items : [];
      const cal = Number(refined.total?.calories) || 0;
      const pro = Number(refined.total?.protein_g) || 0;
      const carb = Number(refined.total?.carbs_g) || 0;
      const f = Number(refined.total?.fat_g) || 0;

      if (refined.meal_name) setMealName(refined.meal_name);
      setMultiplier(1);
      setItems(nextItems);
      setBaseItems(nextItems);
      setCalories(String(Math.round(cal)));
      setProtein(String(Math.round(pro * 10) / 10));
      setCarbs(String(Math.round(carb * 10) / 10));
      setFat(String(Math.round(f * 10) / 10));
      setBaseMacros({
        calories: cal,
        protein_g: pro,
        carbs_g: carb,
        fat_g: f,
      });
      if (refined.notes) {
        setNotes(refined.notes);
      }
      setInstruction('');
      setRefineAppliedNote('Updated by Gemini — review and tap Save Changes.');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not apply change with Gemini.'
      );
    } finally {
      setRefining(false);
    }
  };

  const handleMultiplierChange = (nextMult: number) => {
    setMultiplier(nextMult);
    setCalories(String(Math.round(baseMacros.calories * nextMult)));
    setProtein(String(scaleRound(baseMacros.protein_g, nextMult, 1)));
    setCarbs(String(scaleRound(baseMacros.carbs_g, nextMult, 1)));
    setFat(String(scaleRound(baseMacros.fat_g, nextMult, 1)));
    setItems(
      baseItems.map((it) => ({
        ...it,
        estimated_grams: Math.round(it.estimated_grams * nextMult),
        calories: Math.round(it.calories * nextMult),
        protein_g: scaleRound(it.protein_g, nextMult, 1),
        carbs_g: scaleRound(it.carbs_g, nextMult, 1),
        fat_g: scaleRound(it.fat_g, nextMult, 1),
      }))
    );
  };

  const handleManualMacroEdit = (
    field: 'calories' | 'protein_g' | 'carbs_g' | 'fat_g',
    rawVal: string
  ) => {
    const num = Math.max(0, Number(rawVal) || 0);
    if (field === 'calories') setCalories(rawVal);
    if (field === 'protein_g') setProtein(rawVal);
    if (field === 'carbs_g') setCarbs(rawVal);
    if (field === 'fat_g') setFat(rawVal);

    setBaseMacros((prev) => ({
      ...prev,
      [field]: num / (multiplier || 1),
    }));
  };

  const syncTotalsFromItems = (nextItems: MealItem[]) => {
    if (nextItems.length === 0) return;
    const sumCal = nextItems.reduce((a, b) => a + (Number(b.calories) || 0), 0);
    const sumPro = nextItems.reduce((a, b) => a + (Number(b.protein_g) || 0), 0);
    const sumCarb = nextItems.reduce((a, b) => a + (Number(b.carbs_g) || 0), 0);
    const sumFat = nextItems.reduce((a, b) => a + (Number(b.fat_g) || 0), 0);
    setCalories(String(Math.round(sumCal)));
    setProtein(String(Math.round(sumPro * 10) / 10));
    setCarbs(String(Math.round(sumCarb * 10) / 10));
    setFat(String(Math.round(sumFat * 10) / 10));
    setBaseMacros({
      calories: sumCal / (multiplier || 1),
      protein_g: sumPro / (multiplier || 1),
      carbs_g: sumCarb / (multiplier || 1),
      fat_g: sumFat / (multiplier || 1),
    });
  };

  const handleItemEdit = (
    idx: number,
    field: keyof MealItem,
    value: string
  ) => {
    const nextItems = items.map((it, i) => {
      if (i !== idx) return it;
      if (field === 'name' || field === 'portion_description') {
        return { ...it, [field]: value };
      }
      return { ...it, [field]: Math.max(0, Number(value) || 0) };
    });
    setItems(nextItems);
    setBaseItems(
      nextItems.map((it) => ({
        ...it,
        estimated_grams: it.estimated_grams / (multiplier || 1),
        calories: it.calories / (multiplier || 1),
        protein_g: it.protein_g / (multiplier || 1),
        carbs_g: it.carbs_g / (multiplier || 1),
        fat_g: it.fat_g / (multiplier || 1),
      }))
    );
    if (
      field === 'calories' ||
      field === 'protein_g' ||
      field === 'carbs_g' ||
      field === 'fat_g'
    ) {
      syncTotalsFromItems(nextItems);
    }
  };

  const handleRemoveItem = (idx: number) => {
    const nextItems = items.filter((_, i) => i !== idx);
    const nextBaseItems = baseItems.filter((_, i) => i !== idx);
    setItems(nextItems);
    setBaseItems(nextBaseItems);
    syncTotalsFromItems(nextItems);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!mealName.trim()) {
      setError('Meal name cannot be empty.');
      return;
    }

    setError(null);
    setSaving(true);
    try {
      const updated = await apiClient.updateMeal(meal.id, {
        meal_name: mealName.trim(),
        ...(dateStr !== getLocalDateString(normalizeIsoTimestamp(meal.logged_at)) || timeStr !== toTimeInputValue(meal.logged_at)
          ? { logged_at: combineDateAndTimeToIso(dateStr, timeStr) } : {}),
        notes: notes.trim() || null,
        portion_multiplier: multiplier,
        items,
        calories: Math.round(Number(calories) || 0),
        protein_g: Math.round((Number(protein) || 0) * 10) / 10,
        carbs_g: Math.round((Number(carbs) || 0) * 10) / 10,
        fat_g: Math.round((Number(fat) || 0) * 10) / 10,
      });
      onUpdated(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update meal.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Edit Meal"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving && !refining) onClose();
      }}
    >
      <div className="sheet-panel">
        <div className="sheet-handle" />
        <div className="sheet-header">
          <h2 className="sheet-title">Edit Meal</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            onClick={onClose}
            disabled={saving || refining}
          >
            <X size={18} />
          </button>
        </div>

        <form id="edit-meal-form" onSubmit={handleSubmit} className="sheet-body">
          {error && (
            <div className="error-box" role="alert">
              <AlertCircle size={16} className="icon-lead" />
              <span>{error}</span>
            </div>
          )}

          {/* Conversational Refine Box */}
          <div className="refine-box">
            <div className="prompt-card-head">
              <label htmlFor="edit-refine-input" className="prompt-card-title text-pro">
                <Sparkles size={13} className="shrink-0" />
                <span>Describe a change</span>
              </label>
              <VoiceDictateButton
                disabled={refining || saving}
                onTranscript={(spoken) => {
                  setError(null);
                  const clean = spoken.trim();
                  if (!clean) return;
                  setInstruction((prev) => {
                    const p = prev.trim();
                    return p ? `${p}, ${clean}` : clean;
                  });
                }}
                onError={(msg) => setError(msg)}
              />
            </div>
            <textarea
              id="edit-refine-input"
              className="prompt-textarea"
              rows={2}
              placeholder='e.g. "I did not eat the potatoes" or "I ate half the rice"'
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              disabled={refining || saving}
            />
            <div className="row-between">
              <span className="text-xs text-secondary">
                {refineAppliedNote || 'Gemini updates items & macros automatically.'}
              </span>
              <button
                type="button"
                className="btn btn-teal btn-sm shrink-0"
                disabled={!instruction.trim() || refining || saving}
                onClick={handleApplyRefine}
              >
                {refining ? (
                  <>
                    <Loader2 size={14} className="spin" />
                    <span>Updating...</span>
                  </>
                ) : (
                  <>
                    <Sparkles size={14} />
                    <span>Apply with Gemini</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <label className="field">
            <span className="field-label">Meal Name</span>
            <input
              type="text"
              className="input"
              value={mealName}
              onChange={(e) => setMealName(e.target.value)}
              required
            />
          </label>

          <div className="form-grid-2">
            <label className="field">
              <span className="field-label">
                <span className="row-sm">
                  <Calendar size={12} /> Date
                </span>
              </span>
              <input
                type="date"
                className="input input-compact"
                value={dateStr}
                onChange={(e) => {
                  if (e.target.value) setDateStr(e.target.value);
                }}
              />
            </label>

            <label className="field">
              <span className="field-label">
                <span className="row-sm">
                  <Clock size={12} /> Time
                </span>
              </span>
              <input
                type="time"
                className="input input-compact"
                value={timeStr}
                onChange={(e) => setTimeStr(e.target.value)}
              />
            </label>
          </div>

          <div className="field">
            <span className="field-label">
              <span>Portion Multiplier</span>
              <span className="tabular text-cal">
                {multiplier}x
              </span>
            </span>
            <div className="chip-row">
              {MULTIPLIERS.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`chip chip-multiplier ${multiplier === m ? 'is-active' : ''}`}
                  onClick={() => handleMultiplierChange(m)}
                >
                  {m}x
                </button>
              ))}
            </div>
          </div>

          {/* Live Totals Summary Strip */}
          <div className="live-totals-grid tabular">
            <div className="live-total-box live-total-box--cal">
              <div className="live-total-val text-cal">
                {Math.round(Number(calories) || 0).toLocaleString()}
              </div>
              <div className="live-total-lbl">Calories</div>
            </div>
            <div className="live-total-box live-total-box--pro">
              <div className="live-total-val text-pro">
                {Math.round(Number(protein) || 0)}g
              </div>
              <div className="live-total-lbl">Protein</div>
            </div>
            <div className="live-total-box">
              <div className="live-total-val text-carb">
                {Math.round(Number(carbs) || 0)}g
              </div>
              <div className="live-total-lbl">Carbs</div>
            </div>
            <div className="live-total-box">
              <div className="live-total-val text-fat">
                {Math.round(Number(fat) || 0)}g
              </div>
              <div className="live-total-lbl">Fat</div>
            </div>
          </div>

          {items.length > 0 && (
            <div className="field">
              <span className="field-label">Items ({items.length})</span>
              <div className="stack-xs">
                {items.map((item, idx) => (
                  <div key={`${item.name}-${idx}`} className="meal-item-row meal-item-row--wrap">
                    <div className="flex-1">
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
                    <button
                      type="button"
                      className="icon-btn icon-btn--compact"
                      aria-label={`Remove ${item.name}`}
                      onClick={() => handleRemoveItem(idx)}
                    >
                      <Trash2 size={14} />
                    </button>

                    {showManualNumbers && (
                      <div className="edit-items-grid">
                        <input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          className="input input-compact tabular"
                          aria-label={`${item.name} calories`}
                          value={Math.round(item.calories)}
                          onChange={(e) => handleItemEdit(idx, 'calories', e.target.value)}
                        />
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step={0.5}
                          className="input input-compact tabular"
                          aria-label={`${item.name} protein`}
                          value={item.protein_g}
                          onChange={(e) => handleItemEdit(idx, 'protein_g', e.target.value)}
                        />
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step={0.5}
                          className="input input-compact tabular"
                          aria-label={`${item.name} carbs`}
                          value={item.carbs_g}
                          onChange={(e) => handleItemEdit(idx, 'carbs_g', e.target.value)}
                        />
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step={0.5}
                          className="input input-compact tabular"
                          aria-label={`${item.name} fat`}
                          value={item.fat_g}
                          onChange={(e) => handleItemEdit(idx, 'fat_g', e.target.value)}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-inline-reset"
              onClick={() => setShowManualNumbers((prev) => !prev)}
            >
              {showManualNumbers ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              <span>Fine-tune numbers manually</span>
            </button>

            {showManualNumbers && (
              <div className="form-grid-4" style={{ marginTop: 8 }}>
                <label className="field">
                  <span className="field-label">Calories</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    className="input input-compact tabular"
                    value={calories}
                    onChange={(e) => handleManualMacroEdit('calories', e.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Protein (g)</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={0.5}
                    className="input input-compact tabular"
                    value={protein}
                    onChange={(e) => handleManualMacroEdit('protein_g', e.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Carbs (g)</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={0.5}
                    className="input input-compact tabular"
                    value={carbs}
                    onChange={(e) => handleManualMacroEdit('carbs_g', e.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Fat (g)</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={0.5}
                    className="input input-compact tabular"
                    value={fat}
                    onChange={(e) => handleManualMacroEdit('fat_g', e.target.value)}
                  />
                </label>
              </div>
            )}
          </div>

          <label className="field">
            <span className="field-label">Notes</span>
            <input
              type="text"
              className="input input-compact"
              placeholder="Optional notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
        </form>

        <div className="sheet-footer">
          <button
            type="submit"
            form="edit-meal-form"
            className="btn btn-primary btn-full"
            disabled={saving || refining}
          >
            {saving ? (
              <>
                <Loader2 size={18} className="spin" />
                <span>Saving changes...</span>
              </>
            ) : (
              <>
                <Check size={18} />
                <span>Save Changes</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

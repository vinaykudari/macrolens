import { suggestMeals } from '../utils/suggestions';
import { manualCalories } from '../utils/nutrition';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Calendar,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  ImagePlus,
  Loader2,
  MessageSquareText,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  apiClient,
  ApiError,
  getRecentMealsCache,
  PRESET_QUICK_MEALS,
} from '../api/client';
import type {
  AnalyzeMealResponse,
  MealItem,
  MealRecord,
  QuickMealTemplate,
} from '../types/api';
import {
  combineDateAndTimeToIso,
  getLocalDateString,
  formatLongDate,
  getTzOffsetMinutes,
  shiftDateString,
  toTimeInputValue,
} from '../utils/date';
import { prepareMealImage } from '../utils/image';
import { VoiceDictateButton } from './VoiceDictateButton';

export type SnapInitialTab = 'photo' | 'describe' | 'manual';

interface SnapMealSheetProps {
  isOpen: boolean;
  initialTab: SnapInitialTab;
  initialFile: File | null;
  selectedDate: string;
  userId: string | number;
  recentMealsFromDay: MealRecord[];
  onClose: () => void;
  onMealLogged: (meal: MealRecord) => void;
}

const MULTIPLIERS = [0.5, 0.75, 1, 1.5, 2] as const;

const QUICK_NOTE_CHIPS = [
  'oat milk latte',
  'black iced coffee',
  'ate half',
  'cooked in oil',
];

function appendTranscript(prev: string, spoken: string): string {
  const cleanSpoken = spoken.trim();
  if (!cleanSpoken) return prev;
  const cleanPrev = prev.trim();
  if (!cleanPrev) return cleanSpoken;
  return /[.!?]$/.test(cleanPrev)
    ? `${cleanPrev} ${cleanSpoken}`
    : `${cleanPrev}, ${cleanSpoken}`;
}

const DESCRIBE_EXAMPLES = [
  '3 scrambled eggs, 1 bowl oatmeal with berries, 1 banana',
  'Grilled chicken bowl with rice, black beans, and guac',
  '200g salmon, roasted broccoli, 1 cup jasmine rice',
  'Greek yogurt with 1 scoop whey and almonds',
];

function isRealRef(ref: string | null | undefined): ref is string {
  if (!ref) return false;
  const s = ref.trim().toLowerCase();
  return Boolean(s && s !== 'none' && s !== 'null' && s !== 'n/a');
}

function getConfidenceClass(confidence: string | null | undefined): string {
  const s = String(confidence || '').toLowerCase();
  if (s.includes('high')) return 'confidence-pill--high';
  if (s.includes('low')) return 'confidence-pill--low';
  return 'confidence-pill--medium';
}

function scaleNum(n: number, mult: number, decimals = 1): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * mult * factor) / factor;
}

export const SnapMealSheet: React.FC<SnapMealSheetProps> = ({
  isOpen,
  initialTab,
  initialFile,
  selectedDate,
  userId,
  recentMealsFromDay,
  onClose,
  onMealLogged,
}) => {
  const [tab, setTab] = useState<'photo' | 'describe'>(
    initialTab === 'photo' ? 'photo' : 'describe'
  );

  // Photo capture state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [note, setNote] = useState<string>('');
  const [isDragging, setIsDragging] = useState<boolean>(false);

  // Text describe state
  const [description, setDescription] = useState<string>('');

  // Shared analysis & confirmation state
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const [analysis, setAnalysis] = useState<AnalyzeMealResponse | null>(null);
  const [analysisSource, setAnalysisSource] = useState<'photo' | 'text'>('photo');
  const [editedMealName, setEditedMealName] = useState<string>('');
  const [baseItems, setBaseItems] = useState<MealItem[]>([]);
  const [baseTotal, setBaseTotal] = useState({
    calories: 0,
    protein_g: 0,
    carbs_g: 0,
    fat_g: 0,
  });
  const [multiplier, setMultiplier] = useState<number>(1);
  const [confirmNotes, setConfirmNotes] = useState<string>('');

  // Discreet collapsible manual numbers fallback
  const [showManualEntry, setShowManualEntry] = useState<boolean>(false);
  const [manualName, setManualName] = useState<string>('');
  const [manualCal, setManualCal] = useState<string>('');
  const [manualPro, setManualPro] = useState<string>('');
  const [manualCarb, setManualCarb] = useState<string>('');
  const [manualFat, setManualFat] = useState<string>('');
  const [manualNote, setManualNote] = useState<string>('');
  const [manualMult, setManualMult] = useState<number>(1);
  const [manualItems, setManualItems] = useState<MealItem[]>([]);
  const [yesterdayMeals, setYesterdayMeals] = useState<MealRecord[]>([]);
  const [mealHistory, setMealHistory] = useState<MealRecord[]>([]);

  // Date + Time for current or past-day logging
  const [logDate, setLogDate] = useState<string>(selectedDate);
  const [logTime, setLogTime] = useState<string>(() => toTimeInputValue());
  const [customDateTimeTouched, setCustomDateTimeTouched] = useState<boolean>(false);

  const [saving, setSaving] = useState<boolean>(false);
  const [quickSavingId, setQuickSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const photoSaveIdRef = useRef<string | null>(null);
  const photoSavingRef = useRef(false);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setTab(initialTab === 'photo' ? 'photo' : 'describe');
    setShowManualEntry(initialTab === 'manual');
    setError(null);

    const today = getLocalDateString();
    setLogDate(selectedDate);
    setLogTime(toTimeInputValue());
    setCustomDateTimeTouched(selectedDate !== today);

    if (initialFile) {
      setTab('photo');
      setSelectedFile(initialFile);
      setAnalysis(null);
    }
  }, [isOpen, initialTab, initialFile, selectedDate]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const yesterday = shiftDateString(getLocalDateString(), -1);
    apiClient
      .getMeals(yesterday, getTzOffsetMinutes())
      .then((meals) => {
        if (!cancelled) setYesterdayMeals(meals);
      })
      .catch(() => {
        // Ignore silent history fetch failure
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setMealHistory([]);
    apiClient.getMealLogs({ page: 1, pageSize: 50 }).then((result) => {
      if (!cancelled) setMealHistory(result.items);
    }).catch(() => { if (!cancelled) setMealHistory([]); });
    return () => { cancelled = true; };
  }, [isOpen, userId]);

  const suggestions = useMemo(() => suggestMeals(mealHistory, logDate === selectedDate ? recentMealsFromDay : [], logDate, logTime, description), [mealHistory, recentMealsFromDay, selectedDate, logDate, logTime, description]);

  useEffect(() => {
    if (!selectedFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(selectedFile);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [selectedFile]);

  const resetAll = () => {
    photoSaveIdRef.current = null;
    setSelectedFile(null);
    setPreviewUrl(null);
    setNote('');
    setDescription('');
    setAnalysis(null);
    setAnalysisSource('photo');
    setEditedMealName('');
    setBaseItems([]);
    setBaseTotal({ calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
    setMultiplier(1);
    setConfirmNotes('');
    setShowManualEntry(false);
    setManualName('');
    setManualCal('');
    setManualPro('');
    setManualCarb('');
    setManualFat('');
    setManualNote('');
    setManualMult(1);
    setManualItems([]);
    setError(null);
  };

  const handleClose = () => {
    if (analyzing || saving) return;
    resetAll();
    onClose();
  };

  const handleFileChosen = async (file: File | undefined | null) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Please choose an image file (JPG, PNG, HEIC, or WebP).');
      return;
    }
    setError(null);
    setAnalysis(null);
    const prepared = await prepareMealImage(file);
    setSelectedFile(prepared);
  };

  const applyAnalysisResult = (
    result: AnalyzeMealResponse,
    sourceKind: 'photo' | 'text',
    fallbackNote: string
  ) => {
    setAnalysis(result);
    setAnalysisSource(sourceKind);
    setEditedMealName(result.meal_name || 'Analyzed Meal');
    const items = Array.isArray(result.items) ? result.items : [];
    setBaseItems(items);
    setBaseTotal({
      calories: Number(result.total?.calories) || 0,
      protein_g: Number(result.total?.protein_g) || 0,
      carbs_g: Number(result.total?.carbs_g) || 0,
      fat_g: Number(result.total?.fat_g) || 0,
    });
    setMultiplier(1);
    setConfirmNotes(result.notes || fallbackNote || '');
  };

  const handleAnalyzePhoto = async () => {
    if (!selectedFile) {
      setError('Snap or choose a meal photo first.');
      return;
    }
    setError(null);
    setAnalyzing(true);
    try {
      const result = await apiClient.analyzeMeal({
        image: selectedFile,
        note: note.trim(),
        referenceHint: '',
      });
      applyAnalysisResult(result, 'photo', note.trim());
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not analyze image. Try Describe Meal instead.'
      );
    } finally {
      setAnalyzing(false);
    }
  };

  const handleAnalyzeDescription = async () => {
    const trimmed = description.trim();
    if (!trimmed) {
      setError('Describe what you ate first.');
      return;
    }
    setError(null);
    setAnalyzing(true);
    try {
      const result = await apiClient.analyzeMealText(trimmed);
      applyAnalysisResult(result, 'text', trimmed);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not analyze description right now. Please try again.'
      );
    } finally {
      setAnalyzing(false);
    }
  };

  const handleRemoveAnalyzedItem = (indexToRemove: number) => {
    const remaining = baseItems.filter((_, idx) => idx !== indexToRemove);
    setBaseItems(remaining);
    if (remaining.length > 0) {
      const nextTotals = remaining.reduce(
        (acc, item) => ({
          calories: acc.calories + (Number(item.calories) || 0),
          protein_g: acc.protein_g + (Number(item.protein_g) || 0),
          carbs_g: acc.carbs_g + (Number(item.carbs_g) || 0),
          fat_g: acc.fat_g + (Number(item.fat_g) || 0),
        }),
        { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }
      );
      setBaseTotal(nextTotals);
    } else {
      setBaseTotal({ calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
    }
  };

  const scaledTotals = useMemo(
    () => ({
      calories: Math.round(baseTotal.calories * multiplier),
      protein_g: scaleNum(baseTotal.protein_g, multiplier, 1),
      carbs_g: scaleNum(baseTotal.carbs_g, multiplier, 1),
      fat_g: scaleNum(baseTotal.fat_g, multiplier, 1),
    }),
    [baseTotal, multiplier]
  );

  const scaledItems = useMemo(
    () =>
      baseItems.map((item) => ({
        ...item,
        estimated_grams: Math.round(item.estimated_grams * multiplier),
        calories: Math.round(item.calories * multiplier),
        protein_g: scaleNum(item.protein_g, multiplier, 1),
        carbs_g: scaleNum(item.carbs_g, multiplier, 1),
        fat_g: scaleNum(item.fat_g, multiplier, 1),
      })),
    [baseItems, multiplier]
  );

  const getLoggedAtPayload = (): string | undefined => {
    const isToday = logDate === getLocalDateString();
    if (isToday && !customDateTimeTouched) {
      return undefined;
    }
    return combineDateAndTimeToIso(logDate, logTime);
  };

  const handleSaveAnalyzedMeal = async () => {
    if (!analysis || photoSavingRef.current) return;
    if (!editedMealName.trim()) {
      setError('Please enter a meal name.');
      return;
    }
    setError(null);
    photoSavingRef.current = true;
    setSaving(true);
    try {
      const payload = {
        meal_name: editedMealName.trim(),
        logged_at: getLoggedAtPayload(),
        source: analysisSource,
        detected_reference:
          analysisSource === 'photo' && isRealRef(analysis.detected_reference)
            ? analysis.detected_reference
            : null,
        confidence: analysis.confidence || null,
        notes: confirmNotes.trim() || null,
        portion_multiplier: multiplier,
        items: scaledItems,
        calories: scaledTotals.calories,
        protein_g: scaledTotals.protein_g,
        carbs_g: scaledTotals.carbs_g,
        fat_g: scaledTotals.fat_g,
      };
      if (analysisSource === 'photo' && !selectedFile) throw new Error('Choose the photo again before saving.');
      if (analysisSource === 'photo' && !photoSaveIdRef.current) photoSaveIdRef.current = crypto.randomUUID();
      const savedMeal = analysisSource === 'photo' && selectedFile
        ? await apiClient.createMealWithPhoto(payload, selectedFile, photoSaveIdRef.current!)
        : await apiClient.createMeal(payload);
      resetAll();
      onMealLogged(savedMeal);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save meal.');
    } finally {
      photoSavingRef.current = false;
      setSaving(false);
    }
  };

  const recentTemplates = useMemo<QuickMealTemplate[]>(() => {
    const cached = getRecentMealsCache(userId);
    const seen = new Set<string>();
    const combined: QuickMealTemplate[] = [];

    const pushMeal = (m: MealRecord) => {
      const key = m.meal_name.trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      const mult = m.portion_multiplier && m.portion_multiplier > 0 ? m.portion_multiplier : 1;
      combined.push({
        id: `meal-${m.id}`,
        meal_name: m.meal_name,
        calories: Math.round(m.calories / mult),
        protein_g: scaleNum(m.protein_g, 1 / mult, 1),
        carbs_g: scaleNum(m.carbs_g, 1 / mult, 1),
        fat_g: scaleNum(m.fat_g, 1 / mult, 1),
        items: (m.items || []).map((it) => ({
          ...it,
          estimated_grams: Math.round(it.estimated_grams / mult),
          calories: Math.round(it.calories / mult),
          protein_g: scaleNum(it.protein_g, 1 / mult, 1),
          carbs_g: scaleNum(it.carbs_g, 1 / mult, 1),
          fat_g: scaleNum(it.fat_g, 1 / mult, 1),
        })),
        notes: m.notes ?? null,
      });
    };

    recentMealsFromDay.forEach(pushMeal);
    yesterdayMeals.forEach(pushMeal);
    cached.forEach((entry) => {
      const key = entry.meal_name.trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      combined.push(entry);
    });

    PRESET_QUICK_MEALS.forEach((preset) => {
      const key = preset.meal_name.trim().toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        combined.push(preset);
      }
    });

    return combined.slice(0, 6);
  }, [userId, recentMealsFromDay, yesterdayMeals]);

  const handleInstantQuickLog = async (tpl: QuickMealTemplate) => {
    setError(null);
    setQuickSavingId(tpl.id);
    try {
      const created = await apiClient.createMeal({
        meal_name: tpl.meal_name,
        logged_at: getLoggedAtPayload(),
        source: 'recent',
        notes: tpl.notes ?? null,
        portion_multiplier: 1,
        items: tpl.items || [],
        calories: Math.round(tpl.calories),
        protein_g: Number(tpl.protein_g) || 0,
        carbs_g: Number(tpl.carbs_g) || 0,
        fat_g: Number(tpl.fat_g) || 0,
      });
      resetAll();
      onMealLogged(created);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Failed to log quick snack.'
      );
    } finally {
      setQuickSavingId(null);
    }
  };

  const handlePopulateManualForm = (tpl: QuickMealTemplate) => {
    setShowManualEntry(true);
    setManualName(tpl.meal_name);
    setManualCal(String(Math.round(tpl.calories)));
    setManualPro(String(Math.round(tpl.protein_g * 10) / 10));
    setManualCarb(String(Math.round(tpl.carbs_g * 10) / 10));
    setManualFat(String(Math.round(tpl.fat_g * 10) / 10));
    setManualNote(tpl.notes || '');
    setManualItems(tpl.items || []);
    setManualMult(1);
  };

  const handleSaveManualMeal = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (!manualName.trim()) {
      setError('Please enter a meal or snack name.');
      return;
    }
    const pro = Number(manualPro) || 0;
    const carb = Number(manualCarb) || 0;
    const fat = Number(manualFat) || 0;
    const cal = manualCalories(manualCal, pro, carb, fat);
    if (cal <= 0 && pro <= 0 && carb <= 0 && fat <= 0) {
      setError('Enter calories or macro amounts.');
      return;
    }

    const scaledManualItems =
      manualItems.length > 0
        ? manualItems.map((it) => ({
            ...it,
            estimated_grams: Math.round(it.estimated_grams * manualMult),
            calories: Math.round(it.calories * manualMult),
            protein_g: scaleNum(it.protein_g, manualMult, 1),
            carbs_g: scaleNum(it.carbs_g, manualMult, 1),
            fat_g: scaleNum(it.fat_g, manualMult, 1),
          }))
        : [
            {
              name: manualName.trim(),
              portion_description:
                manualMult === 1 ? '1 serving' : `${manualMult}x serving`,
              estimated_grams: 0,
              calories: Math.round(cal * manualMult),
              protein_g: scaleNum(pro, manualMult, 1),
              carbs_g: scaleNum(carb, manualMult, 1),
              fat_g: scaleNum(fat, manualMult, 1),
            },
          ];

    setSaving(true);
    try {
      const created = await apiClient.createMeal({
        meal_name: manualName.trim(),
        logged_at: getLoggedAtPayload(),
        source: 'manual',
        notes: manualNote.trim() || null,
        portion_multiplier: manualMult,
        items: scaledManualItems,
        calories: Math.round(cal * manualMult),
        protein_g: scaleNum(pro, manualMult, 1),
        carbs_g: scaleNum(carb, manualMult, 1),
        fat_g: scaleNum(fat, manualMult, 1),
      });
      resetAll();
      onMealLogged(created);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Failed to save manual meal.'
      );
    } finally {
      setSaving(false);
    }
  };

  const appendNoteChip = (phrase: string) => {
    setNote((prev) => {
      const current = prev.trim();
      if (!current) return phrase;
      if (current.toLowerCase().includes(phrase.toLowerCase())) return prev;
      return `${current}, ${phrase}`;
    });
  };

  if (!isOpen) return null;

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Add Meal"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="sheet-panel">
        <div className="sheet-handle" />
        <div className="sheet-header">
          <div>
            <h2 className="sheet-title">
              {analysis ? 'Review & Tweak Portion' : 'Add Meal'}
            </h2>
            <div className="sheet-log-date">{formatLongDate(logDate)}</div>
          </div>

          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            onClick={handleClose}
          >
            <X size={18} />
          </button>
        </div>

        <div className="sheet-body">
          {!analysis && (
            <div className="segmented" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'photo'}
                className={`segmented-btn ${tab === 'photo' ? 'is-active' : ''}`}
                onClick={() => {
                  setTab('photo');
                  setError(null);
                }}
              >
                <Camera size={16} />
                <span>Snap Photo</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'describe'}
                className={`segmented-btn ${tab === 'describe' ? 'is-active' : ''}`}
                onClick={() => {
                  setTab('describe');
                  setError(null);
                }}
              >
                <MessageSquareText size={16} />
                <span>Describe Meal</span>
              </button>
            </div>
          )}

          {error && (
            <div className="error-box" role="alert">
              <AlertCircle size={16} className="icon-lead" />
              <span>{error}</span>
            </div>
          )}

          {/* Mode 1: Snap Photo */}
          {tab === 'photo' && !analysis && (
            <>
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="is-hidden-input"
                onChange={(e) => handleFileChosen(e.target.files?.[0])}
              />
              <input
                ref={galleryInputRef}
                type="file"
                accept="image/*"
                className="is-hidden-input"
                onChange={(e) => handleFileChosen(e.target.files?.[0])}
              />

              {!previewUrl ? (
                <div
                  className={`dropzone ${isDragging ? 'is-dragging' : ''}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragging(true);
                  }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDragging(false);
                    handleFileChosen(e.dataTransfer.files?.[0]);
                  }}
                >
                  <div className="dropzone-icon-badge">
                    <Camera size={24} />
                  </div>

                  <div>
                    <div className="dropzone-title">
                      Add a meal photo
                    </div>
                    <div className="dropzone-sub">
                      Drag a photo here, or choose an option below
                    </div>
                  </div>

                  <div className="capture-btn-row">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => cameraInputRef.current?.click()}
                    >
                      <Camera size={17} />
                      <span>Take Photo</span>
                    </button>

                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => galleryInputRef.current?.click()}
                    >
                      <ImagePlus size={17} />
                      <span>Upload</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="preview-frame">
                  <img
                    src={previewUrl}
                    alt="Selected meal preview"
                    className="preview-img"
                  />
                  {!analyzing && (
                    <button
                      type="button"
                      className="icon-btn preview-clear-btn"
                      aria-label="Choose another photo"
                      onClick={() => {
                        setSelectedFile(null);
                        setPreviewUrl(null);
                      }}
                    >
                      <RotateCcw size={16} />
                    </button>
                  )}

                  {analyzing && (
                    <div className="analyzing-overlay">
                      <div className="scan-beam" />
                      <Loader2 size={28} className="spin" color="var(--pro-1)" />
                      <div className="analyzing-title">
                        Analyzing meal...
                      </div>
                      <div className="analyzing-sub">
                        Estimating portions, ingredients &amp; macros
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="prompt-card">
                <div className="prompt-card-head">
                  <label htmlFor="snap-photo-context" className="prompt-card-title">
                    <MessageSquareText size={13} className="text-pro shrink-0" />
                    <span>Meal description</span>
                    <span className="prompt-optional-tag">Optional</span>
                  </label>
                  <VoiceDictateButton
                    disabled={analyzing}
                    onTranscript={(spoken) => {
                      setError(null);
                      setNote((prev) => appendTranscript(prev, spoken));
                    }}
                    onError={(msg) => setError(msg)}
                  />
                </div>
                <textarea
                  id="snap-photo-context"
                  rows={2}
                  className="prompt-textarea"
                  placeholder='e.g. "iced oat milk latte, 16 oz", "black coffee", "cooked in butter", "ate half"'
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={analyzing}
                />
                <div className="chip-row prompt-chips">
                  {QUICK_NOTE_CHIPS.map((phrase) => (
                    <button
                      key={phrase}
                      type="button"
                      className="chip"
                      onClick={() => appendNoteChip(phrase)}
                    >
                      <Plus size={12} />
                      <span>{phrase}</span>
                    </button>
                  ))}
                </div>
              </div>

              <details className="photo-options">
                <summary>Date and time <span>Optional</span></summary>
              <div className="photo-options-content">
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
                    value={logDate}
                    onChange={(e) => {
                      if (e.target.value) {
                        setLogDate(e.target.value);
                        setCustomDateTimeTouched(true);
                      }
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
                    value={logTime}
                    onChange={(e) => {
                      setLogTime(e.target.value);
                      setCustomDateTimeTouched(true);
                    }}
                  />
                </label>
              </div>
              </div>
              </details>
            </>
          )}

          {/* Mode 2: Describe Meal (Conversational Natural Language + 1-Tap Recent + Discreet Manual Toggle) */}
          {tab === 'describe' && !analysis && (
            <>
              <div className="prompt-card">
                <div className="prompt-card-head">
                  <label htmlFor="snap-describe-input" className="prompt-card-title">
                    <Sparkles size={13} className="text-pro shrink-0" />
                    <span>What did you eat?</span>
                  </label>
                  <VoiceDictateButton
                    disabled={analyzing}
                    onTranscript={(spoken) => {
                      setError(null);
                      setDescription((prev) => appendTranscript(prev, spoken));
                    }}
                    onError={(msg) => setError(msg)}
                  />
                </div>
                <textarea
                  id="snap-describe-input"
                  className="prompt-textarea prompt-textarea--tall"
                  rows={3}
                  placeholder="Describe what you ate—e.g. 3 scrambled eggs, 1 bowl oatmeal with berries, and 1 medium banana"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={analyzing}
                />
                {suggestions.length > 0 && (
                  <div className="meal-suggestions">
                    <span>From your meals</span>
                    <div className="chip-row">
                      {suggestions.map((meal) => <button key={meal} type="button" className="chip" onClick={() => setDescription(meal)}>{meal}</button>)}
                    </div>
                  </div>
                )}
                <details className="example-options"><summary>Examples</summary><div className="chip-row prompt-chips">
                  {DESCRIBE_EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      className="chip"
                      onClick={() => setDescription(ex)}
                    >
                      <Sparkles size={11} />
                      <span className="chip-label-clamp">{ex}</span>
                    </button>
                  ))}
                </div></details>
              </div>

              <details className="photo-options"><summary>Date and time <span>Optional</span></summary><div className="photo-options-content"><div className="form-grid-2">
                <label className="field">
                  <span className="field-label">
                    <span className="row-sm">
                      <Calendar size={12} /> Date
                    </span>
                  </span>
                  <input
                    type="date"
                    className="input input-compact"
                    value={logDate}
                    onChange={(e) => {
                      if (e.target.value) {
                        setLogDate(e.target.value);
                        setCustomDateTimeTouched(true);
                      }
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
                    value={logTime}
                    onChange={(e) => {
                      setLogTime(e.target.value);
                      setCustomDateTimeTouched(true);
                    }}
                  />
                </label>
              </div></div></details>

              <details className="photo-options"><summary>Recent and quick meals</summary>
                <div className="photo-options-content"><div className="quick-recent-list">
                  {recentTemplates.map((tpl) => {
                    const isQuickBusy = quickSavingId === tpl.id;
                    return (
                      <div key={tpl.id} className="quick-recent-card">
                        <button
                          type="button"
                          className="quick-recent-info"
                          onClick={() => handlePopulateManualForm(tpl)}
                        >
                          <div className="quick-recent-name">{tpl.meal_name}</div>
                          <div className="quick-recent-macros tabular">
                            {Math.round(tpl.calories)} kcal · {Math.round(tpl.protein_g)}g P ·{' '}
                            {Math.round(tpl.carbs_g)}g C · {Math.round(tpl.fat_g)}g F
                          </div>
                        </button>

                        <button
                          type="button"
                          className="btn btn-teal btn-sm"
                          disabled={isQuickBusy || saving || analyzing}
                          onClick={() => handleInstantQuickLog(tpl)}
                        >
                          {isQuickBusy ? (
                            <Loader2 size={14} className="spin" />
                          ) : (
                            <Plus size={14} />
                          )}
                          <span>Add</span>
                        </button>
                      </div>
                    );
                  })}
                </div></div>
              </details>

              <div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-inline-reset"
                  onClick={() => setShowManualEntry((prev) => !prev)}
                >
                  {showManualEntry ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                  <span>Enter manually</span>
                </button>

                {showManualEntry && (
                  <form
                    id="manual-meal-form"
                    onSubmit={handleSaveManualMeal}
                    className="manual-entry-panel"
                  >
                    <input
                      type="text"
                      className="input input-compact"
                      placeholder="Meal or snack name"
                      value={manualName}
                      onChange={(e) => setManualName(e.target.value)}
                      required
                    />

                    <div className="form-grid-4">
                      <label className="field">
                        <span className="field-label">Calories</span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          className="input input-compact"
                          placeholder="210"
                          value={manualCal}
                          onChange={(e) => { setManualCal(e.target.value); setManualItems([]); }}
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">Protein (g)</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step={0.5}
                          className="input input-compact"
                          placeholder="20"
                          value={manualPro}
                          onChange={(e) => { setManualPro(e.target.value); setManualItems([]); }}
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">Carbs (g)</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step={0.5}
                          className="input input-compact"
                          placeholder="22"
                          value={manualCarb}
                          onChange={(e) => { setManualCarb(e.target.value); setManualItems([]); }}
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">Fat (g)</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step={0.5}
                          className="input input-compact"
                          placeholder="7"
                          value={manualFat}
                          onChange={(e) => { setManualFat(e.target.value); setManualItems([]); }}
                        />
                      </label>
                    </div>

                    <p className="manual-calorie-hint">Leave calories blank to estimate from macros.</p>
                    <div className="chip-row">
                      {MULTIPLIERS.map((m) => (
                        <button
                          key={m}
                          type="button"
                          className={`chip chip-multiplier ${
                            manualMult === m ? 'is-active' : ''
                          }`}
                          onClick={() => setManualMult(m)}
                        >
                          {m}x
                        </button>
                      ))}
                    </div>

                    <button
                      type="submit"
                      className="btn btn-secondary btn-sm"
                      disabled={saving}
                    >
                      {saving ? (
                        <Loader2 size={15} className="spin" />
                      ) : (
                        <Check size={15} />
                      )}
                      <span className="tabular">
                        {Number(manualCal) > 0
                          ? `Save · ${Math.round(Number(manualCal) * manualMult)} kcal`
                          : 'Save Manual Entry'}
                      </span>
                    </button>
                  </form>
                )}
              </div>
            </>
          )}

          {/* Confirmation & Quick-Tweak View (Shared for Photo & Text Analysis) */}
          {analysis && (
            <>
              <div className="row-md">
                {analysisSource === 'photo' && previewUrl && (
                  <img
                    src={previewUrl}
                    alt="Analyzed meal"
                    className="analysis-thumb"
                  />
                )}
                <div className="flex-1 stack-sm">
                  <div className="analysis-badges-row">
                    {analysisSource === 'text' && (
                      <span className="ref-badge">
                        <Sparkles size={12} />
                        <span>From description</span>
                      </span>
                    )}
                    {analysis.confidence && (
                      <span
                        className={`confidence-pill ${getConfidenceClass(
                          analysis.confidence
                        )}`}
                      >
                        {analysis.confidence} confidence
                      </span>
                    )}
                  </div>

                  <button
                    type="button"
                    className="btn btn-ghost btn-sm btn-inline-reset"
                    onClick={() => setAnalysis(null)}
                  >
                    <RotateCcw size={13} />
                    <span>
                      {analysisSource === 'photo'
                        ? 'Re-analyze / Change Photo'
                        : 'Edit Description'}
                    </span>
                  </button>
                </div>
              </div>

              <label className="field">
                <span className="field-label">Meal Title</span>
                <input
                  type="text"
                  className="input"
                  value={editedMealName}
                  onChange={(e) => setEditedMealName(e.target.value)}
                />
              </label>

              <div className="field">
                <span className="field-label">
                  <span>Portion Consumed</span>
                  <span className="tabular text-cal">
                    {multiplier}x
                  </span>
                </span>
                <div className="chip-row">
                  {MULTIPLIERS.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`chip chip-multiplier ${
                        multiplier === m ? 'is-active' : ''
                      }`}
                      onClick={() => setMultiplier(m)}
                    >
                      {m}x
                    </button>
                  ))}
                </div>
              </div>

              <div className="live-totals-grid tabular">
                <div className="live-total-box live-total-box--cal">
                  <div className="live-total-val text-cal">
                    {scaledTotals.calories.toLocaleString()}
                  </div>
                  <div className="live-total-lbl">Calories</div>
                </div>
                <div className="live-total-box live-total-box--pro">
                  <div className="live-total-val text-pro">
                    {Math.round(scaledTotals.protein_g)}g
                  </div>
                  <div className="live-total-lbl">Protein</div>
                </div>
                <div className="live-total-box">
                  <div className="live-total-val text-carb">
                    {Math.round(scaledTotals.carbs_g)}g
                  </div>
                  <div className="live-total-lbl">Carbs</div>
                </div>
                <div className="live-total-box">
                  <div className="live-total-val text-fat">
                    {Math.round(scaledTotals.fat_g)}g
                  </div>
                  <div className="live-total-lbl">Fat</div>
                </div>
              </div>

              {scaledItems.length > 0 && (
                <div className="field">
                  <span className="field-label">
                    <span>Detected Breakdown ({scaledItems.length})</span>
                    <span className="text-muted">Tap trash to exclude</span>
                  </span>
                  <div className="stack-sm">
                    {scaledItems.map((item, idx) => (
                      <div key={`${item.name}-${idx}`} className="meal-item-row">
                        <div className="flex-1">
                          <div className="meal-item-name">{item.name}</div>
                          <div className="meal-item-portion tabular">
                            {item.portion_description}
                            {item.estimated_grams > 0
                              ? ` · ~${item.estimated_grams}g`
                              : ''}
                          </div>
                        </div>

                        <div className="meal-item-macros tabular">
                          <strong>{item.calories} kcal</strong>
                          <div>
                            {Math.round(item.protein_g)}P · {Math.round(item.carbs_g)}C ·{' '}
                            {Math.round(item.fat_g)}F
                          </div>
                        </div>

                        <button
                          type="button"
                          className="icon-btn icon-btn--compact"
                          aria-label={`Remove ${item.name}`}
                          onClick={() => handleRemoveAnalyzedItem(idx)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

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
                    value={logDate}
                    onChange={(e) => {
                      if (e.target.value) {
                        setLogDate(e.target.value);
                        setCustomDateTimeTouched(true);
                      }
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
                    value={logTime}
                    onChange={(e) => {
                      setLogTime(e.target.value);
                      setCustomDateTimeTouched(true);
                    }}
                  />
                </label>
              </div>

              <label className="field">
                <span className="field-label">Notes</span>
                <input
                  type="text"
                  className="input input-compact"
                  placeholder="Optional notes"
                  value={confirmNotes}
                  onChange={(e) => setConfirmNotes(e.target.value)}
                />
              </label>
            </>
          )}
        </div>

        <div className="sheet-footer">
          {!analysis && tab === 'photo' && (
            <button
              type="button"
              className="btn btn-primary btn-full"
              disabled={!selectedFile || analyzing}
              onClick={handleAnalyzePhoto}
            >
              {analyzing ? (
                <>
                  <Loader2 size={18} className="spin" />
                  <span>Analyzing with Gemini...</span>
                </>
              ) : (
                <>
                  <Sparkles size={18} />
                  <span>Analyze Meal Photo</span>
                </>
              )}
            </button>
          )}

          {!analysis && tab === 'describe' && (
            <button
              type="button"
              className="btn btn-primary btn-full"
              disabled={!description.trim() || analyzing}
              onClick={handleAnalyzeDescription}
            >
              {analyzing ? (
                <>
                  <Loader2 size={18} className="spin" />
                  <span>Analyzing with Gemini...</span>
                </>
              ) : (
                <>
                  <Sparkles size={18} />
                  <span>Analyze with Gemini</span>
                </>
              )}
            </button>
          )}

          {analysis && (
            <button
              type="button"
              className="btn btn-primary btn-full"
              disabled={saving}
              onClick={handleSaveAnalyzedMeal}
            >
              {saving ? (
                <>
                  <Loader2 size={18} className="spin" />
                  <span>
                    {analysisSource === 'photo' && selectedFile
                      ? 'Saving meal & photo...'
                      : 'Saving meal...'}
                  </span>
                </>
              ) : (
                <>
                  <Check size={18} />
                  <span className="tabular">
                    Log Meal · {scaledTotals.calories.toLocaleString()} kcal ·{' '}
                    {Math.round(scaledTotals.protein_g)}g P
                  </span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

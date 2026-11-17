import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Bell,
  BellOff,
  Check,
  Globe,
  Loader2,
  LogOut,
  RefreshCw,
  Send,
  Smartphone,
} from 'lucide-react';
import { apiClient, ApiError } from '../api/client';
import type {
  ActivityLevel,
  ConfigResponse,
  Goal,
  MacroTargets,
  NotificationSettings,
  Sex,
  User,
  UserProfile,
} from '../types/api';
import {
  ACTIVITY_OPTIONS,
  GOAL_OPTIONS,
  SEX_OPTIONS,
  calculateTargetsFromProfile,
  cmToFtIn,
  ftInToCm,
  kgToLbs,
  lbsToKg,
} from '../utils/calibration';
import {
  getCurrentBrowserPushEndpoint,
  getDetectedTimezone,
  isIosSafariNeedsHomeScreen,
  isPushSupported,
  subscribeBrowserPush,
  unsubscribeBrowserPush,
} from '../utils/push';

const targetDraftFrom = (targets: MacroTargets): Record<keyof MacroTargets, string> => ({
  calories: String(targets.calories), protein_g: String(targets.protein_g),
  carbs_g: String(targets.carbs_g), fat_g: String(targets.fat_g),
});

interface ConfigViewProps {
  user: User;
  onConfigUpdated: (nextConfig: ConfigResponse) => void;
  onSignOut: () => Promise<void>;
  onNotify: (message: string, kind?: 'success' | 'error') => void;
}

export const ConfigView: React.FC<ConfigViewProps> = ({
  user,
  onConfigUpdated,
  onSignOut,
  onNotify,
}) => {
  const [loading, setLoading] = useState<boolean>(true);
  const [savingTargets, setSavingTargets] = useState<boolean>(false);
  const [savingProfile, setSavingProfile] = useState<boolean>(false);
  const [recalibrating, setRecalibrating] = useState<boolean>(false);
  const [signingOut, setSigningOut] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const [heightUnit, setHeightUnit] = useState<'cm' | 'ft'>('ft');
  const [weightUnit, setWeightUnit] = useState<'kg' | 'lbs'>('lbs');

  const [profile, setProfile] = useState<UserProfile>(user.profile);
  const [targets, setTargets] = useState<MacroTargets>(user.targets);
  const [targetDraft, setTargetDraft] = useState(() => targetDraftFrom(user.targets));
  const [autoCalibrated, setAutoCalibrated] = useState<MacroTargets>(() =>
    calculateTargetsFromProfile(user.profile)
  );

  // Meal reminder & Web Push state
  const detectedTimezone = useMemo(() => getDetectedTimezone(), []);
  const needsIosHomeScreen = useMemo(() => isIosSafariNeedsHomeScreen(), []);
  const pushSupported = useMemo(() => isPushSupported(), []);

  const [notifications, setNotifications] = useState<NotificationSettings>({
    enabled: false,
    breakfast_time: '08:30',
    lunch_time: '13:00',
    dinner_time: '19:30',
    timezone: detectedTimezone,
    active_subscriptions: 0,
  });
  const [deviceSubscribed, setDeviceSubscribed] = useState<boolean>(false);
  const [togglingPush, setTogglingPush] = useState<boolean>(false);
  const [savingSchedule, setSavingSchedule] = useState<boolean>(false);
  const [sendingTest, setSendingTest] = useState<boolean>(false);
  const [pushError, setPushError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    apiClient
      .getConfig()
      .then((cfg) => {
        if (!active) return;
        setProfile(cfg.profile);
        setTargets(cfg.targets);
        setTargetDraft(targetDraftFrom(cfg.targets));
        setAutoCalibrated(cfg.auto_calibrated_targets);
        if (cfg.notifications) {
          setNotifications({
            enabled: Boolean(cfg.notifications.enabled),
            breakfast_time: cfg.notifications.breakfast_time || '08:30',
            lunch_time: cfg.notifications.lunch_time || '13:00',
            dinner_time: cfg.notifications.dinner_time || '19:30',
            timezone: cfg.notifications.timezone || detectedTimezone,
            active_subscriptions: cfg.notifications.active_subscriptions ?? 0,
          });
        }
        setError(null);
      })
      .catch((err) => {
        if (!active) return;
        setError(
          err instanceof ApiError ? err.message : 'Unable to load configuration.'
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    getCurrentBrowserPushEndpoint().then((endpoint) => {
      if (active) setDeviceSubscribed(Boolean(endpoint));
    });

    return () => {
      active = false;
    };
  }, [detectedTimezone]);

  const livePreviewTargets = useMemo(
    () => calculateTargetsFromProfile(profile),
    [profile]
  );

  const ftIn = useMemo(() => cmToFtIn(profile.height_cm), [profile.height_cm]);
  const weightLbs = useMemo(
    () => Math.round(kgToLbs(profile.weight_kg)),
    [profile.weight_kg]
  );

  const isCustomOverride =
    Math.round(targets.calories) !== Math.round(autoCalibrated.calories) ||
    Math.round(targets.protein_g) !== Math.round(autoCalibrated.protein_g) ||
    Math.round(targets.carbs_g) !== Math.round(autoCalibrated.carbs_g) ||
    Math.round(targets.fat_g) !== Math.round(autoCalibrated.fat_g);

  const handleSaveTargets = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSavingTargets(true);
    try {
      const updated = await apiClient.updateConfig({
        targets: {
          calories: Number(targetDraft.calories),
          protein_g: Number(targetDraft.protein_g),
          carbs_g: Number(targetDraft.carbs_g),
          fat_g: Number(targetDraft.fat_g),
        },
      });
      setProfile(updated.profile);
      setTargets(updated.targets);
      setTargetDraft(targetDraftFrom(updated.targets));
      setAutoCalibrated(updated.auto_calibrated_targets);
      onConfigUpdated(updated);
      onNotify('Daily macro targets updated', 'success');
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not update targets.'
      );
    } finally {
      setSavingTargets(false);
    }
  };

  const handleSaveProfile = async (recalibrate: boolean) => {
    setError(null);
    if (recalibrate) {
      setRecalibrating(true);
    } else {
      setSavingProfile(true);
    }
    try {
      const updated = await apiClient.updateConfig({
        profile,
        recalibrate_from_profile: recalibrate,
      });
      setProfile(updated.profile);
      setTargets(updated.targets);
      setTargetDraft(targetDraftFrom(updated.targets));
      setAutoCalibrated(updated.auto_calibrated_targets);
      onConfigUpdated(updated);
      onNotify(
        recalibrate
          ? 'Profile saved & targets recalculated'
          : 'Body profile saved',
        'success'
      );
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not update profile.'
      );
    } finally {
      setSavingProfile(false);
      setRecalibrating(false);
    }
  };

  const handleEnablePushOnThisDevice = async () => {
    setPushError(null);
    setTogglingPush(true);
    try {
      const vapid = await apiClient.getVapidPublicKey();
      if (!vapid.configured || !vapid.public_key) {
        throw new Error(
          'Push notifications are not configured on the server yet.'
        );
      }
      const subPayload = await subscribeBrowserPush(vapid.public_key);
      await apiClient.subscribePush(subPayload);

      const updated = await apiClient.updateConfig({
        notifications: {
          enabled: true,
          breakfast_time: notifications.breakfast_time,
          lunch_time: notifications.lunch_time,
          dinner_time: notifications.dinner_time,
          timezone: detectedTimezone,
        },
      });
      setDeviceSubscribed(true);
      if (updated.notifications) {
        setNotifications(updated.notifications);
      } else {
        setNotifications((prev) => ({
          ...prev,
          enabled: true,
          timezone: detectedTimezone,
          active_subscriptions: Math.max(1, prev.active_subscriptions),
        }));
      }
      onNotify('Meal reminders enabled on this device', 'success');
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Could not enable push notifications.';
      setPushError(msg);
    } finally {
      setTogglingPush(false);
    }
  };

  const handleTogglePush = async () => {
    if (notifications.enabled) {
      setPushError(null);
      setTogglingPush(true);
      try {
        const endpoint = await unsubscribeBrowserPush();
        await apiClient.unsubscribePush(endpoint);
        const updated = await apiClient.updateConfig({
          notifications: {
            enabled: false,
            timezone: detectedTimezone,
          },
        });
        setDeviceSubscribed(false);
        if (updated.notifications) {
          setNotifications(updated.notifications);
        } else {
          setNotifications((prev) => ({
            ...prev,
            enabled: false,
            active_subscriptions: Math.max(0, prev.active_subscriptions - 1),
          }));
        }
        onNotify('Meal reminders paused', 'success');
      } catch (err) {
        setPushError(
          err instanceof ApiError
            ? err.message
            : 'Could not disable reminders.'
        );
      } finally {
        setTogglingPush(false);
      }
    } else {
      await handleEnablePushOnThisDevice();
    }
  };

  const handleSaveSchedule = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPushError(null);
    setSavingSchedule(true);
    try {
      const updated = await apiClient.updateConfig({
        notifications: {
          enabled: notifications.enabled,
          breakfast_time: notifications.breakfast_time,
          lunch_time: notifications.lunch_time,
          dinner_time: notifications.dinner_time,
          timezone: detectedTimezone,
        },
      });
      if (updated.notifications) {
        setNotifications(updated.notifications);
      }
      onNotify('Reminder schedule saved', 'success');
    } catch (err) {
      setPushError(
        err instanceof ApiError
          ? err.message
          : 'Could not save reminder schedule.'
      );
    } finally {
      setSavingSchedule(false);
    }
  };

  const handleSendTest = async () => {
    setPushError(null);
    setSendingTest(true);
    try {
      const res = await apiClient.sendTestPush();
      const msg =
        res.detail ||
        (res.sent > 0
          ? `Test notification sent (${res.sent} device)`
          : 'No active subscribed devices found');
      onNotify(msg, res.sent > 0 ? 'success' : 'error');
    } catch (err) {
      setPushError(
        err instanceof ApiError
          ? err.message
          : 'Could not send test notification.'
      );
    } finally {
      setSendingTest(false);
    }
  };

  const handleLogout = async () => {
    setSigningOut(true);
    try {
      await onSignOut();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="config-layout">
      <h1 className="settings-page-title">Settings</h1>
      {error && (
        <div className="error-box" role="alert">
          <AlertCircle size={16} className="icon-lead" />
          <span>{error}</span>
        </div>
      )}

      {/* Daily Targets Direct Override */}
      <form className="card card-padded stack-md settings-card" onSubmit={handleSaveTargets}>
        <div className="config-card-head">
          <div>
            <h2 className="section-title section-title-row">
              <span>Daily targets</span>
            </h2>
          </div>
          <span
            className={`status-badge ${
              isCustomOverride ? 'status-badge--track' : 'status-badge--met'
            }`}
          >
            {isCustomOverride ? 'Custom' : 'Auto'}
          </span>
        </div>

        {loading ? (
          <div className="skeleton config-skeleton" />
        ) : (
          <div className="stack-md">
            <p className="settings-target-hint">Edit any value, then save.</p>
            <div className="form-grid-4">
              <label className="field">
                <span className="field-label text-cal">
                  Calories
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={1}
                  max={20000}
                  step="0.1"
                  required
                  className="input tabular"
                  value={targetDraft.calories}
                  onChange={(e) => setTargetDraft((prev) => ({ ...prev, calories: e.target.value }))}
                />
              </label>

              <label className="field">
                <span className="field-label text-pro">
                  Protein (g)
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={2000}
                  step="0.1"
                  required
                  className="input tabular"
                  value={targetDraft.protein_g}
                  onChange={(e) => setTargetDraft((prev) => ({ ...prev, protein_g: e.target.value }))}
                />
              </label>

              <label className="field">
                <span className="field-label text-carb">
                  Carbs (g)
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={3000}
                  step="0.1"
                  required
                  className="input tabular"
                  value={targetDraft.carbs_g}
                  onChange={(e) => setTargetDraft((prev) => ({ ...prev, carbs_g: e.target.value }))}
                />
              </label>

              <label className="field">
                <span className="field-label text-fat">
                  Fat (g)
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={1000}
                  step="0.1"
                  required
                  className="input tabular"
                  value={targetDraft.fat_g}
                  onChange={(e) => setTargetDraft((prev) => ({ ...prev, fat_g: e.target.value }))}
                />
              </label>
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              disabled={savingTargets || recalibrating}
            >
              {savingTargets ? (
                <>
                  <Loader2 size={17} className="spin" />
                  <span>Saving...</span>
                </>
              ) : (
                <>
                  <Check size={17} />
                  <span>Save targets</span>
                </>
              )}
            </button>
          </div>
        )}
      </form>

      {/* Meal Reminders (3x Daily) & Web Push */}
      <form
        className="card card-padded stack-md settings-card"
        onSubmit={handleSaveSchedule}
      >
        <div className="config-card-head">
          <div>
            <h2 className="section-title section-title-row">
              <span>Meal reminders</span>
            </h2>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={notifications.enabled}
            aria-label={
              notifications.enabled
                ? 'Disable meal reminders'
                : 'Enable meal reminders'
            }
            className={`push-switch ${notifications.enabled ? 'is-on' : ''}`}
            disabled={togglingPush}
            onClick={handleTogglePush}
          >
            <span className="push-switch-thumb">
              {togglingPush ? (
                <Loader2 size={12} className="spin" />
              ) : notifications.enabled ? (
                <Bell size={12} />
              ) : (
                <BellOff size={12} />
              )}
            </span>
          </button>
        </div>

        {needsIosHomeScreen && (
          <div className="tip-callout">
            <Smartphone
              size={18}
              className="tip-callout-icon"
            />
            <span>
              On iOS Safari, tap <strong>Share -&gt; Add to Home Screen</strong> first,
              then open MacroLens from your Home Screen to enable push reminders.
            </span>
          </div>
        )}

        {!needsIosHomeScreen && !pushSupported && (
          <div className="meal-notes-box">
            Web Push notifications are not supported by this browser.
          </div>
        )}

        {pushError && (
          <div className="error-box" role="alert">
            <AlertCircle size={16} className="icon-lead" />
            <span>{pushError}</span>
          </div>
        )}

        <div className="reminder-status-row tabular">
          <span
            className={`status-badge ${
              notifications.enabled && notifications.active_subscriptions > 0
                ? 'status-badge--met'
                : 'status-badge--track'
            }`}
          >
            {notifications.active_subscriptions}{' '}
            {notifications.active_subscriptions === 1
              ? 'active device'
              : 'active devices'}
          </span>
          <span className="source-badge">
            <Globe size={12} />
            <span>{notifications.timezone || detectedTimezone}</span>
          </span>
          {notifications.enabled && !deviceSubscribed && pushSupported && !needsIosHomeScreen && (
            <button
              type="button"
              className="btn btn-teal btn-xs"
              disabled={togglingPush}
              onClick={handleEnablePushOnThisDevice}
            >
              Enable on this device
            </button>
          )}
        </div>

        <div className="reminder-times-grid">
          <label className="field">
            <span className="field-label">Breakfast</span>
            <input
              type="time"
              className="input input-compact tabular"
              value={notifications.breakfast_time}
              onChange={(e) =>
                setNotifications((prev) => ({
                  ...prev,
                  breakfast_time: e.target.value || '08:30',
                }))
              }
            />
          </label>

          <label className="field">
            <span className="field-label">Lunch</span>
            <input
              type="time"
              className="input input-compact tabular"
              value={notifications.lunch_time}
              onChange={(e) =>
                setNotifications((prev) => ({
                  ...prev,
                  lunch_time: e.target.value || '13:00',
                }))
              }
            />
          </label>

          <label className="field">
            <span className="field-label">Dinner</span>
            <input
              type="time"
              className="input input-compact tabular"
              value={notifications.dinner_time}
              onChange={(e) =>
                setNotifications((prev) => ({
                  ...prev,
                  dinner_time: e.target.value || '19:30',
                }))
              }
            />
          </label>
        </div>

        <div className="form-grid-2">
          <button
            type="submit"
            className="btn btn-secondary"
            disabled={savingSchedule || togglingPush}
          >
            {savingSchedule ? (
              <>
                <Loader2 size={16} className="spin" />
                <span>Saving...</span>
              </>
            ) : (
              <>
                <Check size={16} />
                <span>Save schedule</span>
              </>
            )}
          </button>

          <button
            type="button"
            className="btn btn-teal"
            disabled={sendingTest || togglingPush}
            onClick={handleSendTest}
          >
            {sendingTest ? (
              <>
                <Loader2 size={16} className="spin" />
                <span>Sending...</span>
              </>
            ) : (
              <>
                <Send size={16} />
                <span>Send test</span>
              </>
            )}
          </button>
        </div>
      </form>

      {/* Body Profile & Mifflin-St Jeor Recalibration */}
      <details className="card settings-profile">
        <summary><span>Profile &amp; recalculation</span></summary>
        <div className="settings-profile-body stack-md">
        <div className="form-grid-2">
          <div className="field">
            <div className="field-label">
              <span>Height</span>
              <div className="unit-toggle">
                <button
                  type="button"
                  className={`unit-toggle-btn ${heightUnit === 'ft' ? 'is-active' : ''}`}
                  onClick={() => setHeightUnit('ft')}
                >
                  ft/in
                </button>
                <button
                  type="button"
                  className={`unit-toggle-btn ${heightUnit === 'cm' ? 'is-active' : ''}`}
                  onClick={() => setHeightUnit('cm')}
                >
                  cm
                </button>
              </div>
            </div>

            {heightUnit === 'cm' ? (
              <input
                aria-label="Height in centimeters"
                type="number"
                inputMode="decimal"
                min={100}
                max={240}
                className="input tabular"
                value={Math.round(profile.height_cm)}
                onChange={(e) =>
                  setProfile((p) => ({
                    ...p,
                    height_cm: Number(e.target.value) || 170,
                  }))
                }
              />
            ) : (
              <div className="grid-2">
                <input
                  type="number"
                  inputMode="numeric"
                  min={3}
                  max={8}
                  className="input tabular"
                  value={ftIn.feet}
                  onChange={(e) =>
                    setProfile((p) => ({
                      ...p,
                      height_cm: ftInToCm(Number(e.target.value) || 0, ftIn.inches),
                    }))
                  }
                  aria-label="Height feet"
                />
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={11}
                  className="input tabular"
                  value={ftIn.inches}
                  onChange={(e) =>
                    setProfile((p) => ({
                      ...p,
                      height_cm: ftInToCm(ftIn.feet, Number(e.target.value) || 0),
                    }))
                  }
                  aria-label="Height inches"
                />
              </div>
            )}
          </div>

          <div className="field">
            <div className="field-label">
              <span>Weight</span>
              <div className="unit-toggle">
                <button
                  type="button"
                  className={`unit-toggle-btn ${weightUnit === 'lbs' ? 'is-active' : ''}`}
                  onClick={() => setWeightUnit('lbs')}
                >
                  lbs
                </button>
                <button
                  type="button"
                  className={`unit-toggle-btn ${weightUnit === 'kg' ? 'is-active' : ''}`}
                  onClick={() => setWeightUnit('kg')}
                >
                  kg
                </button>
              </div>
            </div>

            {weightUnit === 'kg' ? (
              <input
                aria-label="Weight in kilograms"
                type="number"
                inputMode="decimal"
                min={30}
                max={280}
                step={0.5}
                className="input tabular"
                value={Math.round(profile.weight_kg * 10) / 10}
                onChange={(e) =>
                  setProfile((p) => ({
                    ...p,
                    weight_kg: Number(e.target.value) || 70,
                  }))
                }
              />
            ) : (
              <input
                aria-label="Weight in pounds"
                type="number"
                inputMode="decimal"
                min={70}
                max={600}
                className="input tabular"
                value={weightLbs}
                onChange={(e) =>
                  setProfile((p) => ({
                    ...p,
                    weight_kg: lbsToKg(Number(e.target.value) || 150),
                  }))
                }
              />
            )}
          </div>
        </div>

        <div className="form-grid-2">
          <label className="field">
            <span className="field-label">Age</span>
            <input
              type="number"
              inputMode="numeric"
              min={13}
              max={100}
              className="input tabular"
              value={profile.age}
              onChange={(e) =>
                setProfile((p) => ({ ...p, age: Number(e.target.value) || 25 }))
              }
            />
          </label>

          <div className="field">
            <span className="field-label">Sex</span>
            <div className="segmented">
              {SEX_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`segmented-btn ${
                    profile.sex === opt.value ? 'is-active' : ''
                  }`}
                  onClick={() =>
                    setProfile((p) => ({ ...p, sex: opt.value as Sex }))
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <label className="field">
          <span className="field-label">Activity Level</span>
          <select
            className="select"
            value={profile.activity_level}
            onChange={(e) =>
              setProfile((p) => ({
                ...p,
                activity_level: e.target.value as ActivityLevel,
              }))
            }
          >
            {ACTIVITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label} — {opt.description}
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          <span className="field-label">Goal</span>
          <div className="option-grid-cards">
            {GOAL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`option-card ${
                  profile.goal === opt.value ? 'is-active' : ''
                }`}
                onClick={() =>
                  setProfile((p) => ({ ...p, goal: opt.value as Goal }))
                }
              >
                <strong>{opt.label}</strong>
                <span>{opt.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="preview-targets-card">
          <div className="preview-targets-head">
            <span>Calculated targets</span>
          </div>
          <div className="preview-targets-row tabular">
            <div>
              <strong className="text-cal">
                {livePreviewTargets.calories.toLocaleString()}
              </strong>
              <span>kcal</span>
            </div>
            <div>
              <strong className="text-pro">
                {livePreviewTargets.protein_g}g
              </strong>
              <span>Protein</span>
            </div>
            <div>
              <strong className="text-carb">
                {livePreviewTargets.carbs_g}g
              </strong>
              <span>Carbs</span>
            </div>
            <div>
              <strong className="text-fat">
                {livePreviewTargets.fat_g}g
              </strong>
              <span>Fat</span>
            </div>
          </div>
        </div>

        <div className="form-grid-2">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={savingProfile || recalibrating}
            onClick={() => handleSaveProfile(false)}
          >
            {savingProfile ? (
              <>
                <Loader2 size={16} className="spin" />
                <span>Saving...</span>
              </>
            ) : (
              <span>Save profile</span>
            )}
          </button>

          <button
            type="button"
            className="btn btn-teal"
            disabled={savingProfile || recalibrating}
            onClick={() => handleSaveProfile(true)}
          >
            {recalibrating ? (
              <>
                <Loader2 size={16} className="spin" />
                <span>Recalculating...</span>
              </>
            ) : (
              <>
                <RefreshCw size={16} />
                <span>Recalculate targets</span>
              </>
            )}
          </button>
        </div>
        </div>
      </details>

      {/* Account */}
      <section className="card card-padded account-card">
        <div className="row-md">
          <div>
            <div className="text-strong">{user.name}</div>
            <div className="text-sm text-secondary">
              {user.email}
            </div>
          </div>
        </div>

        <button
          type="button"
          className="btn btn-danger-ghost btn-sm"
          disabled={signingOut}
          onClick={handleLogout}
        >
          {signingOut ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <LogOut size={15} />
          )}
          <span>Sign Out</span>
        </button>
      </section>
    </div>
  );
};

import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  Eye,
  EyeOff,
  Loader2,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { apiClient, ApiError, getLastEmail } from '../api/client';
import type { ActivityLevel, AuthResponse, Goal, Sex, UserProfile } from '../types/api';
import {
  ACTIVITY_OPTIONS,
  GOAL_OPTIONS,
  SEX_OPTIONS,
  calculateBmrAndTdee,
  calculateTargetsFromProfile,
  cmToFtIn,
  ftInToCm,
  kgToLbs,
  lbsToKg,
} from '../utils/calibration';

interface AuthViewProps {
  onAuthenticated: (auth: AuthResponse) => void;
}

export const AuthView: React.FC<AuthViewProps> = ({ onAuthenticated }) => {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState<string>(() => getLastEmail());
  const [pin, setPin] = useState<string>('');
  const [showPin, setShowPin] = useState<boolean>(false);
  const [name, setName] = useState<string>('');

  const [heightUnit, setHeightUnit] = useState<'cm' | 'ft'>('ft');
  const [weightUnit, setWeightUnit] = useState<'kg' | 'lbs'>('lbs');

  const [heightCm, setHeightCm] = useState<number>(175);
  const [weightKg, setWeightKg] = useState<number>(74.8);
  const [age, setAge] = useState<number>(28);
  const [sex, setSex] = useState<Sex>('male');
  const [activityLevel, setActivityLevel] = useState<ActivityLevel>('moderate');
  const [goal, setGoal] = useState<Goal>('lose');

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const profile: UserProfile = useMemo(
    () => ({
      height_cm: Math.round(heightCm * 10) / 10,
      weight_kg: Math.round(weightKg * 10) / 10,
      age: Math.max(13, Math.min(100, Number(age) || 28)),
      sex,
      activity_level: activityLevel,
      goal,
    }),
    [heightCm, weightKg, age, sex, activityLevel, goal]
  );

  const previewTargets = useMemo(
    () => calculateTargetsFromProfile(profile),
    [profile]
  );

  const { tdee } = useMemo(() => calculateBmrAndTdee(profile), [profile]);
  const ftIn = useMemo(() => cmToFtIn(heightCm), [heightCm]);
  const weightLbs = useMemo(() => Math.round(kgToLbs(weightKg)), [weightKg]);

  const handlePinChange = (raw: string) => {
    const digitsOnly = raw.replace(/\D/g, '').slice(0, 6);
    setPin(digitsOnly);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError('Please enter your email address.');
      return;
    }
    if (pin.length < 4 || pin.length > 6) {
      setError('PIN must be 4 to 6 numeric digits.');
      return;
    }

    if (mode === 'signup') {
      if (!name.trim()) {
        setError('Please enter your name.');
        return;
      }
      if (profile.height_cm < 100 || profile.height_cm > 250) {
        setError('Please enter a realistic height.');
        return;
      }
      if (profile.weight_kg < 30 || profile.weight_kg > 300) {
        setError('Please enter a realistic weight.');
        return;
      }
    }

    setSubmitting(true);
    try {
      const auth =
        mode === 'login'
          ? await apiClient.login({ email: trimmedEmail, pin })
          : await apiClient.signup({
              email: trimmedEmail,
              pin,
              name: name.trim(),
              profile,
            });
      onAuthenticated(auth);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : 'Unable to authenticate. Please try again.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-container">
        <div className="auth-brand-header">
          <img src="/icon.svg?v=mono1" alt="MacroLens" />
          <h1>MacroLens</h1>
          <p>Snap any meal. Dial in calories &amp; protein in seconds.</p>
        </div>

        <div className="card auth-card">
          <div className="segmented" role="tablist" aria-label="Authentication mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              className={`segmented-btn ${mode === 'login' ? 'is-active' : ''}`}
              onClick={() => {
                setMode('login');
                setError(null);
              }}
            >
              Log In
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'signup'}
              className={`segmented-btn ${mode === 'signup' ? 'is-active' : ''}`}
              onClick={() => {
                setMode('signup');
                setError(null);
              }}
            >
              Create Account
            </button>
          </div>

          {error && (
            <div className="error-box" role="alert">
              <AlertCircle size={16} className="icon-lead" />
              <span>{error}</span>
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            className="stack-md"
          >
            {mode === 'signup' && (
              <label className="field" htmlFor="name">
                <span className="field-label">Your Name</span>
                <input
                  id="name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  className="input"
                  placeholder="Alex"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </label>
            )}

            <label className="field" htmlFor="email">
              <span className="field-label">Email Address</span>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                className="input"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>

            <label className="field" htmlFor="pin">
              <span className="field-label">
                <span>4–6 Digit PIN</span>
                <span
                  className={`tabular pin-status-hint ${
                    pin.length >= 4 ? 'is-ready' : ''
                  }`}
                >
                  {pin.length >= 4 ? `${pin.length} digits ready` : `${pin.length}/4–6 digits`}
                </span>
              </span>

              <div className="pin-wrapper">
                <div className="input-with-action">
                  <input
                    id="pin"
                    name="pin"
                    type={showPin ? 'text' : 'password'}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    minLength={4}
                    maxLength={6}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    className="input pin-input"
                    placeholder="••••"
                    value={pin}
                    onChange={(e) => handlePinChange(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    className="input-action-btn"
                    aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                    onClick={() => setShowPin((prev) => !prev)}
                  >
                    {showPin ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>

                <div className="pin-dots-bar" aria-hidden="true">
                  {[0, 1, 2, 3, 4, 5].map((idx) => (
                    <span
                      key={idx}
                      className={`pin-dot-cell ${idx < pin.length ? 'is-filled' : ''} ${
                        idx >= 4 ? 'is-optional' : ''
                      }`}
                    />
                  ))}
                </div>
              </div>
            </label>

            {mode === 'signup' && (
              <>
                <div className="auth-signup-divider">
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
                          type="number"
                          inputMode="decimal"
                          min={100}
                          max={240}
                          step={0.5}
                          className="input"
                          value={Math.round(heightCm)}
                          onChange={(e) => setHeightCm(Number(e.target.value) || 170)}
                          aria-label="Height in centimeters"
                        />
                      ) : (
                        <div className="grid-2">
                          <input
                            type="number"
                            inputMode="numeric"
                            min={3}
                            max={8}
                            className="input"
                            value={ftIn.feet}
                            onChange={(e) =>
                              setHeightCm(
                                ftInToCm(Number(e.target.value) || 0, ftIn.inches)
                              )
                            }
                            aria-label="Height feet"
                            placeholder="ft"
                          />
                          <input
                            type="number"
                            inputMode="numeric"
                            min={0}
                            max={11}
                            className="input"
                            value={ftIn.inches}
                            onChange={(e) =>
                              setHeightCm(
                                ftInToCm(ftIn.feet, Number(e.target.value) || 0)
                              )
                            }
                            aria-label="Height inches"
                            placeholder="in"
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
                          type="number"
                          inputMode="decimal"
                          min={30}
                          max={280}
                          step={0.5}
                          className="input"
                          value={Math.round(weightKg * 10) / 10}
                          onChange={(e) => setWeightKg(Number(e.target.value) || 70)}
                          aria-label="Weight in kilograms"
                        />
                      ) : (
                        <input
                          type="number"
                          inputMode="decimal"
                          min={70}
                          max={600}
                          step={1}
                          className="input"
                          value={weightLbs}
                          onChange={(e) =>
                            setWeightKg(lbsToKg(Number(e.target.value) || 150))
                          }
                          aria-label="Weight in pounds"
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
                        className="input"
                        value={age}
                        onChange={(e) => setAge(Number(e.target.value) || 25)}
                      />
                    </label>

                    <div className="field">
                      <span className="field-label">Sex (for BMR)</span>
                      <div className="segmented">
                        {SEX_OPTIONS.map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            className={`segmented-btn ${sex === opt.value ? 'is-active' : ''}`}
                            onClick={() => setSex(opt.value)}
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
                      value={activityLevel}
                      onChange={(e) => setActivityLevel(e.target.value as ActivityLevel)}
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
                          className={`option-card ${goal === opt.value ? 'is-active' : ''}`}
                          onClick={() => setGoal(opt.value)}
                        >
                          <strong>{opt.label}</strong>
                          <span>{opt.hint}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="preview-targets-card">
                    <div className="preview-targets-head">
                      <span className="row-sm">
                        <Sparkles size={14} color="var(--pro-1)" />
                        Live Daily Target Preview
                      </span>
                      <span className="tabular">TDEE ~{tdee.toLocaleString()} kcal</span>
                    </div>
                    <div className="preview-targets-row tabular">
                      <div>
                        <strong className="text-cal">
                          {previewTargets.calories.toLocaleString()}
                        </strong>
                        <span>kcal</span>
                      </div>
                      <div>
                        <strong className="text-pro">
                          {previewTargets.protein_g}g
                        </strong>
                        <span>Protein</span>
                      </div>
                      <div>
                        <strong className="text-carb">
                          {previewTargets.carbs_g}g
                        </strong>
                        <span>Carbs</span>
                      </div>
                      <div>
                        <strong className="text-fat">
                          {previewTargets.fat_g}g
                        </strong>
                        <span>Fat</span>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}

            <button
              type="submit"
              className="btn btn-primary btn-full"
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <Loader2 size={18} className="spin" />
                  <span>{mode === 'login' ? 'Signing in...' : 'Creating account...'}</span>
                </>
              ) : (
                <span>
                  {mode === 'login' ? 'Unlock Tracker' : 'Create Account & Start Tracking'}
                </span>
              )}
            </button>

            <div className="auth-security-note">
              <ShieldCheck size={14} />
              <span>Session stays signed in across launches.</span>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

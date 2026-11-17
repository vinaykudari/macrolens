import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  History,
  LayoutDashboard,
  Loader2,
  RefreshCw,
  Sliders,
  Upload,
  WifiOff,
} from 'lucide-react';
import {
  apiClient,
  ApiError,
  saveMealToRecentCache,
  setUnauthorizedHandler,
} from './api/client';
import { AuthView } from './components/AuthView';
import { BottomNav, type AppTab } from './components/BottomNav';
import { ConfigView } from './components/ConfigView';
import { DashboardHero } from './components/DashboardHero';
import { RecentDays } from './components/RecentDays';
import { EditMealModal } from './components/EditMealModal';
import { GoalCharts } from './components/GoalCharts';
import { LogsView } from './components/LogsView';
import { MealFeed } from './components/MealFeed';
import { SnapMealSheet, type SnapInitialTab } from './components/SnapMealSheet';
import type {
  AuthResponse,
  ConfigResponse,
  DailyDashboardResponse,
  MealRecord,
  User,
} from './types/api';
import {
  combineDateAndTimeToIso,
  getLocalDateString,
  getTzOffsetMinutes,
  toTimeInputValue,
  normalizeIsoTimestamp,
} from './utils/date';
import { prepareMealImage } from './utils/image';

interface ToastState {
  message: string;
  kind: 'success' | 'error';
}

export const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<AppTab>('dashboard');
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  const [selectedDate, setSelectedDate] = useState<string>(() =>
    getLocalDateString()
  );
  const [dashboard, setDashboard] = useState<DailyDashboardResponse | null>(null);
  const [loadingDashboard, setLoadingDashboard] = useState<boolean>(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const dashboardRequestRef = useRef(0);
  const [refreshKey, setRefreshKey] = useState<number>(0);

  // Modals / Sheets
  const [snapOpen, setSnapOpen] = useState<boolean>(false);
  const [snapInitialTab, setSnapInitialTab] = useState<SnapInitialTab>('photo');
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [editingMeal, setEditingMeal] = useState<MealRecord | null>(null);

  // Desktop global drag state
  const [isWindowDragging, setIsWindowDragging] = useState<boolean>(false);
  const dragDepthRef = useRef<number>(0);

  // Toast feedback
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback(
    (message: string, kind: 'success' | 'error' = 'success') => {
      setToast({ message, kind });
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
      toastTimerRef.current = window.setTimeout(() => {
        setToast(null);
      }, 3200);
    },
    []
  );

  const bumpRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // Online / Offline listeners
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Unauthorized mid-session handler
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setDashboard(null);
      setSnapOpen(false);
      setEditingMeal(null);
      showToast('Session expired — please enter your PIN again.', 'error');
    });
    return () => setUnauthorizedHandler(null);
  }, [showToast]);

  // Restore persistent session (HttpOnly cookie or bearer token)
  useEffect(() => {
    let active = true;
    apiClient
      .me(true)
      .then((meUser) => {
        if (active) setUser(meUser);
      })
      .catch(() => {
        if (active) setUser(null);
      })
      .finally(() => {
        if (active) setBooting(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // Deep-link from Web Push notification (`/?action=snap`) & SW message handler
  useEffect(() => {
    if (!user) return;

    const params = new URLSearchParams(window.location.search);
    if (params.get('action') === 'snap') {
      setActiveTab('dashboard');
      setSelectedDate(getLocalDateString());
      setDroppedFile(null);
      setSnapInitialTab('photo');
      setSnapOpen(true);

      params.delete('action');
      const nextSearch = params.toString();
      const nextUrl = `${window.location.pathname}${
        nextSearch ? `?${nextSearch}` : ''
      }${window.location.hash}`;
      window.history.replaceState({}, '', nextUrl);
    }
  }, [user]);

  useEffect(() => {
    if (!user || !('serviceWorker' in navigator)) return;
    const handleSwMessage = (event: MessageEvent) => {
      if (event.data?.type === 'MACROLENS_NOTIFICATION_CLICK') {
        const rawUrl = String(event.data.url || '');
        if (rawUrl.includes('action=snap')) {
          setActiveTab('dashboard');
          setSelectedDate(getLocalDateString());
          setDroppedFile(null);
          setSnapInitialTab('photo');
          setSnapOpen(true);
        }
      }
    };
    navigator.serviceWorker.addEventListener('message', handleSwMessage);
    return () => {
      navigator.serviceWorker.removeEventListener('message', handleSwMessage);
    };
  }, [user]);

  const fetchDashboard = useCallback(
    async (dateStr: string) => {
      if (!user) return;
      const request = ++dashboardRequestRef.current;
      setLoadingDashboard(true);
      setDashboardError(null);
      try {
        const data = await apiClient.getDailyDashboard(
          dateStr,
          getTzOffsetMinutes()
        );
        if (request === dashboardRequestRef.current) setDashboard(data);
      } catch (err) {
        if (request !== dashboardRequestRef.current) return;
        setDashboardError(
          err instanceof ApiError
            ? err.message
            : 'Unable to load daily dashboard.'
        );
      } finally {
        if (request === dashboardRequestRef.current) setLoadingDashboard(false);
      }
    },
    [user]
  );

  useEffect(() => {
    if (user) {
      fetchDashboard(selectedDate);
    }
  }, [user, selectedDate, fetchDashboard]);

  // Global desktop drag-and-drop image capture
  useEffect(() => {
    if (!user) return;

    const hasImageDrag = (e: DragEvent): boolean => {
      if (!e.dataTransfer) return false;
      const types = Array.from(e.dataTransfer.types || []);
      return types.includes('Files');
    };

    const onDragEnter = (e: DragEvent) => {
      if (!hasImageDrag(e)) return;
      e.preventDefault();
      dragDepthRef.current += 1;
      setIsWindowDragging(true);
    };

    const onDragOver = (e: DragEvent) => {
      if (!hasImageDrag(e)) return;
      e.preventDefault();
    };

    const onDragLeave = (e: DragEvent) => {
      if (!hasImageDrag(e)) return;
      e.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsWindowDragging(false);
      }
    };

    const onDrop = async (e: DragEvent) => {
      if (!hasImageDrag(e)) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setIsWindowDragging(false);

      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith('image/')) {
        const prepared = await prepareMealImage(file);
        setDroppedFile(prepared);
        setSnapInitialTab('photo');
        setSnapOpen(true);
      }
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [user]);

  const openSnapSheet = (tab: SnapInitialTab = 'photo') => {
    setDroppedFile(null);
    setSnapInitialTab(tab);
    setSnapOpen(true);
  };

  const handleAuthenticated = (auth: AuthResponse) => {
    setUser(auth.user);
    setActiveTab('dashboard');
    setSelectedDate(getLocalDateString());
    bumpRefresh();
    showToast(`Welcome, ${auth.user.name.split(' ')[0]}!`, 'success');
  };

  const handleMealLogged = async (meal: MealRecord) => {
    if (user) {
      saveMealToRecentCache(user.id, meal);
    }
    setSnapOpen(false);
    setDroppedFile(null);
    if (activeTab === 'config') {
      setActiveTab('dashboard');
    }
    const mealDate = getLocalDateString(normalizeIsoTimestamp(meal.logged_at));
    if (activeTab === 'logs' && mealDate !== selectedDate) setSelectedDate(mealDate);
    await fetchDashboard(activeTab === 'logs' ? mealDate : selectedDate);
    bumpRefresh();
    showToast(`Logged ${meal.meal_name}`, 'success');
  };

  const handleMealUpdated = async (updated: MealRecord) => {
    if (user) {
      saveMealToRecentCache(user.id, updated);
    }
    setEditingMeal(null);
    const mealDate = getLocalDateString(normalizeIsoTimestamp(updated.logged_at));
    if (activeTab === 'logs' && mealDate !== selectedDate) setSelectedDate(mealDate);
    await fetchDashboard(activeTab === 'logs' ? mealDate : selectedDate);
    bumpRefresh();
    showToast(`Updated ${updated.meal_name}`, 'success');
  };

  const handleDeleteMeal = async (mealId: string | number) => {
    try {
      await apiClient.deleteMeal(mealId);
      await fetchDashboard(selectedDate);
      bumpRefresh();
      showToast('Meal deleted', 'success');
    } catch (err) {
      showToast(
        err instanceof ApiError ? err.message : 'Failed to delete meal.',
        'error'
      );
    }
  };

  const handleDuplicateMeal = async (meal: MealRecord) => {
    try {
      const targetDate = selectedDate;
      const isToday = targetDate === getLocalDateString();
      const loggedAt = isToday
        ? undefined
        : combineDateAndTimeToIso(targetDate, toTimeInputValue());

      const created = await apiClient.createMeal({
        meal_name: meal.meal_name,
        logged_at: loggedAt,
        source: meal.source || 'manual',
        detected_reference: meal.detected_reference ?? null,
        confidence: meal.confidence ?? null,
        notes: meal.notes ?? null,
        portion_multiplier: meal.portion_multiplier || 1,
        items: meal.items || [],
        calories: meal.calories,
        protein_g: meal.protein_g,
        carbs_g: meal.carbs_g,
        fat_g: meal.fat_g,
      });
      if (user) {
        saveMealToRecentCache(user.id, created);
      }
      await fetchDashboard(selectedDate);
      bumpRefresh();
      showToast(`Logged ${meal.meal_name} again`, 'success');
    } catch (err) {
      showToast(
        err instanceof ApiError ? err.message : 'Could not log meal again.',
        'error'
      );
    }
  };

  const handleConfigUpdated = async (cfg: ConfigResponse) => {
    setUser((prev) =>
      prev
        ? {
            ...prev,
            profile: cfg.profile,
            targets: cfg.targets,
          }
        : prev
    );
    await fetchDashboard(selectedDate);
    bumpRefresh();
  };

  const handleSignOut = async () => {
    await apiClient.logout();
    setUser(null);
    setDashboard(null);
    setActiveTab('dashboard');
    showToast('Signed out', 'success');
  };

  const handleRefreshView = () => {
    if (activeTab === 'dashboard') {
      fetchDashboard(selectedDate);
    }
    bumpRefresh();
  };

  if (booting) {
    return (
      <div
        style={{
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
        }}
      >
        <img
          src="/icon.svg?v=mono1"
          alt="MacroLens"
          style={{ width: 52, height: 52, borderRadius: 16 }}
        />
        <Loader2 size={22} className="spin" color="var(--pro-1)" />
      </div>
    );
  }

  if (!user) {
    return (
      <>
        {!isOnline && (
          <div className="offline-banner">
            <WifiOff size={15} />
            <span>You&apos;re offline — reconnect to sign in.</span>
          </div>
        )}
        <AuthView onAuthenticated={handleAuthenticated} />
        {toast && (
          <div className={`toast-banner toast-banner--${toast.kind}`}>
            {toast.kind === 'success' ? (
              <CheckCircle2 size={16} />
            ) : (
              <AlertCircle size={16} />
            )}
            <span>{toast.message}</span>
          </div>
        )}
      </>
    );
  }

  const firstName = user.name?.trim().split(/\s+/)[0] || 'there';

  return (
    <div className="app-shell">
      {!isOnline && (
        <div className="offline-banner" role="status">
          <WifiOff size={15} />
          <span>Offline mode — reconnect to analyze photos &amp; sync meals.</span>
        </div>
      )}

      <header className="app-header">
        <div className="app-header-inner">
          <div className="brand-lockup">
            <img src="/icon.svg?v=mono1" alt="MacroLens" className="brand-icon" />
            <div className="brand-text">
              <span className="brand-name">MacroLens</span>
              <span className="brand-greeting">Hey, {firstName}</span>
            </div>
          </div>

          <nav className="desktop-nav" aria-label="Desktop navigation">
            <button
              type="button"
              className={`btn btn-sm ${
                activeTab === 'dashboard' ? 'btn-secondary' : 'btn-ghost'
              }`}
              onClick={() => setActiveTab('dashboard')}
            >
              <LayoutDashboard size={15} />
              <span>Today</span>
            </button>
            <button
              type="button"
              className={`btn btn-sm ${
                activeTab === 'logs' ? 'btn-secondary' : 'btn-ghost'
              }`}
              onClick={() => setActiveTab('logs')}
            >
              <History size={15} />
              <span>Logs</span>
            </button>
            <button
              type="button"
              className={`btn btn-sm ${
                activeTab === 'config' ? 'btn-secondary' : 'btn-ghost'
              }`}
              onClick={() => setActiveTab('config')}
            >
              <Sliders size={15} />
              <span>Settings</span>
            </button>
          </nav>

          <div className="header-actions">
            {activeTab !== 'config' && (
              <button
                type="button"
                className="icon-btn"
                aria-label="Refresh"
                onClick={handleRefreshView}
                disabled={loadingDashboard}
              >
                <RefreshCw
                  size={16}
                  className={loadingDashboard ? 'spin' : undefined}
                />
              </button>
            )}

            <button
              type="button"
              className="btn btn-primary btn-sm desktop-nav"
              onClick={() => openSnapSheet('photo')}
            >
              <Camera size={15} />
              <span>Add Meal</span>
            </button>
          </div>
        </div>
      </header>

      <main className="app-main">
        {activeTab === 'dashboard' && (
          <div className="dashboard-layout">
            <div className="dashboard-left">
              <RecentDays selectedDate={selectedDate} onSelectDate={setSelectedDate} refreshKey={refreshKey} />
              {dashboardError && (
                <div className="error-box" role="alert">
                  <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>{dashboardError}</span>
                </div>
              )}

              <DashboardHero
                selectedDate={selectedDate}
                dashboard={dashboard?.date === selectedDate ? dashboard : null}
                loading={loadingDashboard || (!dashboardError && dashboard?.date !== selectedDate)}
              />
            </div>

            <div className="dashboard-right">
              <MealFeed
                selectedDate={selectedDate}
                meals={dashboard?.date === selectedDate ? dashboard.meals : []}
                loading={loadingDashboard || (!dashboardError && dashboard?.date !== selectedDate)}
                onEditMeal={(meal) => setEditingMeal(meal)}
                onDeleteMeal={handleDeleteMeal}
                onDuplicateMeal={handleDuplicateMeal}
                onOpenSnap={(tab) => openSnapSheet(tab ?? 'photo')}
              />

              <details className="trends-disclosure">
                <summary><span>Progress over time</span><span className="trends-hint">View trends</span></summary>
                <GoalCharts
                  selectedDate={selectedDate}
                  onSelectDate={(next) => setSelectedDate(next)}
                  activeTargets={dashboard?.targets ?? user.targets}
                  refreshKey={refreshKey}
                />
              </details>
            </div>
          </div>
        )}

        {activeTab === 'logs' && (
          <LogsView
            refreshKey={refreshKey}
            selectedDate={selectedDate}
            dashboard={dashboard}
            onSelectDate={setSelectedDate}
            onEditMeal={(meal) => setEditingMeal(meal)}
            onDeleteMeal={handleDeleteMeal}
            onDuplicateMeal={handleDuplicateMeal}
            onOpenSnap={(tab) => openSnapSheet(tab ?? 'photo')}
          />
        )}

        {activeTab === 'config' && (
          <ConfigView
            user={user}
            onConfigUpdated={handleConfigUpdated}
            onSignOut={handleSignOut}
            onNotify={showToast}
          />
        )}
      </main>

      <BottomNav
        activeTab={activeTab}
        onChangeTab={setActiveTab}
        onSnapMeal={() => openSnapSheet('photo')}
      />

      <SnapMealSheet
        isOpen={snapOpen}
        initialTab={snapInitialTab}
        initialFile={droppedFile}
        selectedDate={selectedDate}
        userId={user.id}
        recentMealsFromDay={dashboard?.meals ?? []}
        onClose={() => {
          setSnapOpen(false);
          setDroppedFile(null);
        }}
        onMealLogged={handleMealLogged}
      />

      <EditMealModal
        meal={editingMeal}
        onClose={() => setEditingMeal(null)}
        onUpdated={handleMealUpdated}
      />

      {isWindowDragging && (
        <div className="global-drop-overlay">
          <div className="global-drop-box">
            <Upload size={36} color="var(--pro-1)" />
            <div style={{ fontSize: '1.15rem', fontWeight: 800 }}>
              Drop meal photo to analyze
            </div>
            <div style={{ fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
              Gemini will estimate portions, calories, and macros
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`toast-banner toast-banner--${toast.kind}`} role="status">
          {toast.kind === 'success' ? (
            <CheckCircle2 size={16} />
          ) : (
            <AlertCircle size={16} />
          )}
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
};

export default App;

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Check,
  Copy,
  Download,
  KeyRound,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { apiClient, ApiError } from '../api/client';
import type { ShortcutHealthSyncResponse } from '../types/api';

interface AppleHealthBridgeCardProps {
  userId: string | number;
  onNotify: (message: string, kind?: 'success' | 'error') => void;
}

const shortcutTokenStorageKey = (userId: string | number): string =>
  `macrolens_shortcut_token_${userId}`;

function readSavedShortcutToken(userId: string | number): string {
  try {
    return window.localStorage.getItem(shortcutTokenStorageKey(userId)) || '';
  } catch {
    return '';
  }
}

function writeSavedShortcutToken(userId: string | number, token: string): void {
  try {
    if (token) {
      window.localStorage.setItem(shortcutTokenStorageKey(userId), token);
    } else {
      window.localStorage.removeItem(shortcutTokenStorageKey(userId));
    }
  } catch {
    // Ignore storage quota errors
  }
}

export const AppleHealthBridgeCard: React.FC<AppleHealthBridgeCardProps> = ({
  userId,
  onNotify,
}) => {
  const [configured, setConfigured] = useState<boolean>(false);
  const [savedToken, setSavedToken] = useState<string>(() => readSavedShortcutToken(userId));
  const [loadingStatus, setLoadingStatus] = useState<boolean>(true);
  const [working, setWorking] = useState<boolean>(false);
  const [testing, setTesting] = useState<boolean>(false);
  const [preview, setPreview] = useState<ShortcutHealthSyncResponse | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<boolean>(false);
  const refreshTimerRef = useRef<number | null>(null);

  const origin = useMemo(
    () => (typeof window !== 'undefined' ? window.location.origin : 'https://your-host'),
    []
  );

  const syncEndpointUrl = useMemo(() => {
    const tokenParam = savedToken
      ? encodeURIComponent(savedToken)
      : 'mls_YOUR_TOKEN';
    return `${origin}/api/shortcuts/health-sync?token=${tokenParam}&unsynced_only=true`;
  }, [origin, savedToken]);

  const installHref = useMemo(
    () => apiClient.buildShortcutInstallUrl(origin),
    [origin, configured, savedToken]
  );

  useEffect(() => {
    setSavedToken(readSavedShortcutToken(userId));
  }, [userId]);

  useEffect(() => {
    let active = true;
    setLoadingStatus(true);
    apiClient
      .getShortcutTokenStatus()
      .then((res) => {
        if (!active) return;
        const isConfigured = Boolean(res.configured);
        setConfigured(isConfigured);
        if (!isConfigured) {
          setSavedToken('');
          writeSavedShortcutToken(userId, '');
        } else if (res.token) {
          setSavedToken(res.token);
          writeSavedShortcutToken(userId, res.token);
        }
      })
      .catch(() => {
        // Non-fatal if status check fails
      })
      .finally(() => {
        if (active) setLoadingStatus(false);
      });
    return () => {
      active = false;
    };
  }, [userId]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  const copyText = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedUrl(true);
      window.setTimeout(() => setCopiedUrl(false), 1800);
      onNotify(message);
    } catch {
      onNotify('Copy failed — select and copy manually.', 'error');
    }
  };

  const handleGenerate = async () => {
    setWorking(true);
    try {
      const res = await apiClient.generateShortcutToken();
      setConfigured(res.configured);
      setSavedToken(res.token);
      writeSavedShortcutToken(userId, res.token);
      onNotify('New Apple Shortcut token generated and saved.');
    } catch (err) {
      onNotify(
        err instanceof ApiError ? err.message : 'Unable to generate shortcut token.',
        'error'
      );
    } finally {
      setWorking(false);
    }
  };

  const handleRevoke = async () => {
    setWorking(true);
    try {
      const res = await apiClient.revokeShortcutToken();
      setConfigured(res.configured);
      setSavedToken('');
      writeSavedShortcutToken(userId, '');
      onNotify('Shortcut token revoked');
    } catch (err) {
      onNotify(
        err instanceof ApiError ? err.message : 'Unable to revoke shortcut token.',
        'error'
      );
    } finally {
      setWorking(false);
    }
  };

  const handleInstallClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!savedToken) {
      event.preventDefault();
      onNotify('Generate a token before installing the Shortcut.', 'error');
      return;
    }
    if (savedToken && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(syncEndpointUrl).catch(() => {});
    }
    onNotify('Opening Shortcut installer — tap Add Shortcut when prompted');

    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => {
      apiClient
        .getShortcutTokenStatus()
        .then((res) => {
          setConfigured(Boolean(res.configured));
          if (res.token) {
            setSavedToken(res.token);
            writeSavedShortcutToken(userId, res.token);
          }
        })
        .catch(() => {});
    }, 2000);
  };

  const handlePreviewSync = async () => {
    setTesting(true);
    try {
      const data = await apiClient.getShortcutHealthSync({ unsyncedOnly: false });
      setPreview(data);
    } catch (err) {
      onNotify(
        err instanceof ApiError ? err.message : 'Unable to preview health sync payload.',
        'error'
      );
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="card card-padded stack-md">
      <div className="row-between">
        <div>
          <h2 className="section-title row-sm">
            <Activity size={17} />
            <span>Apple Health (iOS Shortcuts)</span>
          </h2>
          <p className="text-sm text-secondary">
            One-tap iPhone Shortcut install to sync calories &amp; macros into Apple Health
          </p>
        </div>

        <span
          className={`status-badge ${
            configured ? 'status-badge--met' : 'status-badge--track'
          }`}
        >
          {loadingStatus ? '...' : configured ? 'Token active' : 'Auto-setup'}
        </span>
      </div>

      <a
        href={installHref}
        target="_blank"
        rel="noopener noreferrer"
        className="btn btn-primary"
        onClick={handleInstallClick}
      >
        <Download size={16} />
        <span>{savedToken ? 'Install Apple Health Shortcut' : 'Generate a token first'}</span>
      </a>

      <div className="field">
        <span className="field-label">
          <span>Sync URL (token baked in)</span>
        </span>
        <div className="row-sm">
          <input
            type="text"
            readOnly
            className="input input-compact tabular"
            value={syncEndpointUrl}
            aria-label="Apple Shortcuts sync URL"
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => copyText(syncEndpointUrl, 'Apple Shortcuts sync URL copied')}
          >
            {copiedUrl ? <Check size={14} /> : <Copy size={14} />}
            <span>Copy</span>
          </button>
        </div>
      </div>

      <div className="row-sm row-wrap">
        <button
          type="button"
          className="btn btn-teal btn-sm"
          disabled={working}
          onClick={handleGenerate}
        >
          {working ? (
            <Loader2 size={14} className="spin" />
          ) : configured ? (
            <RefreshCw size={14} />
          ) : (
            <KeyRound size={14} />
          )}
          <span>{configured ? 'Rotate Token' : 'Generate Token'}</span>
        </button>

        {configured && (
          <button
            type="button"
            className="btn btn-danger-ghost btn-sm"
            disabled={working}
            onClick={handleRevoke}
          >
            <Trash2 size={14} />
            <span>Revoke</span>
          </button>
        )}

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={testing}
          onClick={handlePreviewSync}
        >
          {testing ? <Loader2 size={14} className="spin" /> : <Activity size={14} />}
          <span>Preview Today</span>
        </button>
      </div>

      {preview && (
        <div className="preview-targets-card">
          <div className="preview-targets-head">
            <span>
              {preview.date} · {preview.meal_count} meals ({preview.unsynced_count} unsynced)
            </span>
          </div>
          <div className="preview-targets-row tabular">
            <div>
              <strong className="text-cal">{Math.round(preview.total_calories)}</strong>
              <span>kcal</span>
            </div>
            <div>
              <strong className="text-pro">{preview.total_protein_g}g</strong>
              <span>Protein</span>
            </div>
            <div>
              <strong className="text-carb">{preview.total_carbs_g}g</strong>
              <span>Carbs</span>
            </div>
            <div>
              <strong className="text-fat">{preview.total_fat_g}g</strong>
              <span>Fat</span>
            </div>
          </div>
        </div>
      )}

      <details className="preview-targets-card">
        <summary className="text-sm text-strong" style={{ cursor: 'pointer' }}>
          Quick 2-step iPhone install
        </summary>
        <ol className="text-xs text-secondary stack-xs" style={{ paddingLeft: 18, marginTop: 8 }}>
          <li>
            Tap <strong>Install Apple Health Shortcut</strong> above on your iPhone (or Mac) and
            tap <strong>Add Shortcut</strong> — when prompted, paste your Sync URL copied from the app. Generate a token first if needed.
          </li>
          <li>
            <em>(Optional)</em> In iPhone <strong>Shortcuts -&gt; Automation</strong>, schedule{' '}
            <em>MacroLens Health Sync</em> daily (e.g. 10:00 PM, <em>Run Immediately</em>) —{' '}
            Each meal is marked synced after its Health entries are written. If a run stops partway through a meal, check Apple Health before retrying to avoid duplicates.
          </li>
        </ol>
      </details>
    </section>
  );
};

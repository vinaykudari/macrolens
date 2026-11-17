import React, { useEffect, useState } from 'react';
import { Maximize2, X } from 'lucide-react';
import { getStoredToken } from '../api/client';
import type { MealRecord } from '../types/api';
import { formatMealDateTime } from '../utils/date';

function useAuthenticatedPhotoUrl(photoUrl: string | null | undefined): {
  src: string | null;
  failed: boolean;
  onImgError: () => void;
} {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [triedAuthFetch, setTriedAuthFetch] = useState<boolean>(false);
  const [failed, setFailed] = useState<boolean>(false);

  useEffect(() => {
    setBlobUrl(null);
    setTriedAuthFetch(false);
    setFailed(false);
  }, [photoUrl]);

  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [blobUrl]);

  const onImgError = async () => {
    if (!photoUrl || triedAuthFetch) {
      setFailed(true);
      return;
    }
    setTriedAuthFetch(true);
    const token = getStoredToken();
    if (!token) {
      setFailed(true);
      return;
    }
    try {
      const res = await fetch(photoUrl, {
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setFailed(true);
        return;
      }
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      setBlobUrl(objUrl);
    } catch {
      setFailed(true);
    }
  };

  return {
    src: blobUrl || photoUrl || null,
    failed,
    onImgError,
  };
}

interface MealPhotoThumbnailProps {
  photoUrl: string;
  mealName: string;
  size?: 'sm' | 'md';
  onOpenLightbox: () => void;
}

export const MealPhotoThumbnail: React.FC<MealPhotoThumbnailProps> = ({
  photoUrl,
  mealName,
  size = 'sm',
  onOpenLightbox,
}) => {
  const { src, failed, onImgError } = useAuthenticatedPhotoUrl(photoUrl);

  if (!src || failed) return null;

  return (
    <button
      type="button"
      className={`meal-thumb-btn meal-thumb-btn--${size}`}
      onClick={onOpenLightbox}
      aria-label={`View photo of ${mealName}`}
    >
      <img
        src={src}
        alt={mealName}
        className="meal-thumb-img"
        loading="lazy"
        onError={onImgError}
      />
      <span className="meal-thumb-zoom" aria-hidden="true">
        <Maximize2 size={11} />
      </span>
    </button>
  );
};

interface PhotoLightboxModalProps {
  meal: MealRecord | null;
  onClose: () => void;
}

export const PhotoLightboxModal: React.FC<PhotoLightboxModalProps> = ({
  meal,
  onClose,
}) => {
  const { src, failed, onImgError } = useAuthenticatedPhotoUrl(meal?.photo_url);

  useEffect(() => {
    if (!meal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [meal, onClose]);

  if (!meal || !meal.photo_url) return null;

  return (
    <div
      className="lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Photo of ${meal.meal_name}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="lightbox-card">
        <div className="lightbox-header">
          <div style={{ minWidth: 0 }}>
            <div className="lightbox-title">{meal.meal_name}</div>
            <div className="lightbox-sub tabular">
              {formatMealDateTime(meal.logged_at)}
            </div>
          </div>

          <button
            type="button"
            className="icon-btn"
            aria-label="Close photo preview"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>

        <div className="lightbox-media">
          {src && !failed ? (
            <img
              src={src}
              alt={meal.meal_name}
              className="lightbox-img"
              onError={onImgError}
            />
          ) : (
            <div style={{ padding: 40, color: 'var(--text-secondary)', fontSize: '0.88rem' }}>
              Unable to load stored meal photo.
            </div>
          )}
        </div>

        <div className="lightbox-footer">
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
    </div>
  );
};

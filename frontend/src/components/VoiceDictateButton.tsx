import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { apiClient, ApiError } from '../api/client';

interface VoiceDictateButtonProps {
  disabled?: boolean;
  onTranscript: (transcript: string) => void;
  onError: (message: string) => void;
}

const MIME_CANDIDATES = [
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg',
];

function selectSupportedMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return '';
}

function extensionForMime(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower.includes('mp4')) return 'm4a';
  if (lower.includes('ogg')) return 'ogg';
  return 'webm';
}

function formatDuration(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = String(totalSeconds % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

export const VoiceDictateButton: React.FC<VoiceDictateButtonProps> = ({
  disabled = false,
  onTranscript,
  onError,
}) => {
  const [recording, setRecording] = useState<boolean>(false);
  const [transcribing, setTranscribing] = useState<boolean>(false);
  const [elapsedSec, setElapsedSec] = useState<number>(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<number | null>(null);
  const mountedRef = useRef<boolean>(true);
  const chosenMimeRef = useRef<string>('');

  const stopMediaTracks = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Ignore track stop errors
        }
      });
      streamRef.current = null;
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // Ignore stop errors on unmount
        }
      }
      mediaRecorderRef.current = null;
      stopMediaTracks();
    };
  }, []);

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    } else {
      stopMediaTracks();
      setRecording(false);
    }
  };

  const startRecording = async () => {
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === 'undefined'
    ) {
      onError('Voice dictation is not supported in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      streamRef.current = stream;
      const mimeType = selectSupportedMimeType();
      chosenMimeRef.current = mimeType;

      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      chunksRef.current = [];
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        stopMediaTracks();
        if (mountedRef.current) {
          setRecording(false);
          setTranscribing(false);
          onError('Microphone recording failed. Please try again.');
        }
      };

      recorder.onstop = async () => {
        stopMediaTracks();
        if (!mountedRef.current) return;

        setRecording(false);
        const finalMime =
          recorder.mimeType || chosenMimeRef.current || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: finalMime });
        chunksRef.current = [];
        mediaRecorderRef.current = null;

        if (blob.size < 64) {
          onError('No audio captured — try speaking closer to your mic.');
          return;
        }

        setTranscribing(true);
        try {
          const ext = extensionForMime(finalMime);
          const result = await apiClient.transcribeAudio(
            blob,
            `dictation.${ext}`
          );
          if (!mountedRef.current) return;
          const clean = (result.transcript || '').trim();
          if (clean) {
            onTranscript(clean);
          } else {
            onError('Could not hear speech clearly. Try dictating again.');
          }
        } catch (err) {
          if (!mountedRef.current) return;
          onError(
            err instanceof ApiError
              ? err.message
              : 'Voice transcription failed. Try again or type manually.'
          );
        } finally {
          if (mountedRef.current) {
            setTranscribing(false);
          }
        }
      };

      setElapsedSec(0);
      setRecording(true);
      recorder.start();

      timerRef.current = window.setInterval(() => {
        setElapsedSec((prev) => {
          if (prev >= 89) {
            stopRecording();
            return prev;
          }
          return prev + 1;
        });
      }, 1000);
    } catch (err) {
      stopMediaTracks();
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        onError(
          'Microphone permission denied. Allow mic access in browser settings to dictate.'
        );
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        onError('No microphone detected on this device.');
      } else {
        onError('Could not start microphone recording.');
      }
    }
  };

  const handleClick = () => {
    if (disabled || transcribing) return;
    if (recording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  return (
    <button
      type="button"
      className={`voice-btn ${recording ? 'voice-btn--recording' : ''}`}
      disabled={disabled || transcribing}
      onClick={handleClick}
      aria-label={
        recording
          ? 'Stop voice recording'
          : transcribing
          ? 'Transcribing audio'
          : 'Dictate with voice'
      }
    >
      {transcribing ? (
        <>
          <Loader2 size={13} className="spin" />
          <span>Transcribing...</span>
        </>
      ) : recording ? (
        <>
          <span className="voice-pulse-dot" aria-hidden="true" />
          <Square size={11} fill="currentColor" />
          <span className="tabular">
            {formatDuration(elapsedSec)} · Tap to stop
          </span>
        </>
      ) : (
        <>
          <Mic size={13} />
          <span>Dictate</span>
        </>
      )}
    </button>
  );
};

import { useEffect, useRef, useState } from 'react';
import type { PartyPhoto } from '@dj-sync/shared';
import { audioUrl } from '../api';

/** Thumbnail video: play to the end, scrub back to 0, play again (ping-pong). */
function PingPongVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;

    let dir: 1 | -1 = 1;
    let raf = 0;
    let last = performance.now();
    let stopped = false;

    v.muted = true;
    v.playsInline = true;
    v.loop = false;
    v.playbackRate = 1;

    const reverseTick = (now: number) => {
      if (stopped || dir !== -1) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const next = v.currentTime - dt;
      if (next <= 0) {
        v.currentTime = 0;
        dir = 1;
        void v.play().catch(() => {});
        return;
      }
      v.currentTime = next;
      raf = requestAnimationFrame(reverseTick);
    };

    const onEnded = () => {
      if (stopped) return;
      dir = -1;
      last = performance.now();
      raf = requestAnimationFrame(reverseTick);
    };

    const onReady = () => {
      void v.play().catch(() => {});
    };

    v.addEventListener('ended', onEnded);
    if (v.readyState >= 1) onReady();
    else v.addEventListener('loadedmetadata', onReady, { once: true });

    return () => {
      stopped = true;
      v.removeEventListener('ended', onEnded);
      cancelAnimationFrame(raf);
    };
  }, [src]);

  return (
    <video
      ref={ref}
      src={src}
      muted
      playsInline
      preload="metadata"
      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
    />
  );
}

function MomentThumb({ photo }: { photo: PartyPhoto }) {
  const src = photo.url.startsWith('http') ? photo.url : (audioUrl(photo.url) ?? '');
  if (photo.kind === 'video') {
    return <PingPongVideo src={src} />;
  }
  return <img src={src} alt="" />;
}

function MomentViewer({ photo }: { photo: PartyPhoto }) {
  const src = photo.url.startsWith('http') ? photo.url : (audioUrl(photo.url) ?? '');
  if (photo.kind === 'video') {
    return (
      <video
        src={src}
        controls
        autoPlay
        muted
        playsInline
        loop
        style={{ maxWidth: 'min(520px, 92vw)', maxHeight: '78vh', borderRadius: 14 }}
      />
    );
  }
  return <img src={src} alt="" />;
}

type PendingUpload = {
  id: number;
  previewUrl: string;
  kind: 'image' | 'video';
  progress: number;
  status: 'uploading' | 'done' | 'error';
};

export function MomentsStrip({
  photos,
  onUpload,
}: {
  photos: PartyPhoto[];
  onUpload: (file: File, onProgress?: (pct: number) => void) => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingUpload | null>(null);
  const [viewer, setViewer] = useState<PartyPhoto | null>(null);
  const pendingRef = useRef<PendingUpload | null>(null);

  const clearPending = (item: PendingUpload, delay: number) => {
    window.setTimeout(() => {
      setPending((p) => (p && p.id === item.id ? null : p));
      URL.revokeObjectURL(item.previewUrl);
    }, delay);
  };

  useEffect(() => {
    return () => {
      if (pendingRef.current) URL.revokeObjectURL(pendingRef.current.previewUrl);
    };
  }, []);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const visible = photos.slice(0, 4);
  const extra = photos.length - visible.length;

  const pick = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    const item: PendingUpload = {
      id: Date.now(),
      previewUrl: URL.createObjectURL(file),
      kind: file.type.startsWith('video') ? 'video' : 'image',
      progress: 0,
      status: 'uploading',
    };
    pendingRef.current = item;
    setPending(item);
    try {
      await onUpload(file, (pct) => {
        setPending((p) => (p && p.id === item.id ? { ...p, progress: pct } : p));
      });
      setPending((p) => (p && p.id === item.id ? { ...p, progress: 100, status: 'done' } : p));
      clearPending(item, 900);
    } catch {
      setPending((p) => (p && p.id === item.id ? { ...p, status: 'error' } : p));
      clearPending(item, 2400);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="moments">
      <div className="moments-lab">моменты</div>
      <div className="strip">
        {pending && (
          <div
            className={`strip-ph strip-pending ${pending.status}`}
            aria-busy={pending.status === 'uploading'}
            title={
              pending.status === 'uploading'
                ? `Загрузка ${pending.progress}%`
                : pending.status === 'done'
                  ? 'Загружено'
                  : 'Ошибка загрузки'
            }
          >
            {pending.kind === 'video' ? (
              <video src={pending.previewUrl} muted playsInline preload="metadata" />
            ) : (
              <img src={pending.previewUrl} alt="" />
            )}
            {pending.status === 'uploading' && (
              <span className="strip-pending-dim" style={{ left: `${pending.progress}%` }} />
            )}
            {pending.status === 'uploading' && <span className="strip-spinner" />}
            {pending.status === 'done' && <span className="strip-pending-ok">✓</span>}
            {pending.status === 'error' && <span className="strip-pending-err">!</span>}
          </div>
        )}
        {visible.map((p) => (
          <button
            key={p.id}
            type="button"
            className="strip-ph"
            onClick={() => setViewer(p)}
            title={`${p.uploadedBy}`}
          >
            <MomentThumb photo={p} />
          </button>
        ))}
        {extra > 0 && <div className="strip-more">+{extra}</div>}
        <button
          type="button"
          className="strip-add"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          title="Добавить фото или видео"
        >
          +
        </button>
      </div>
      <input
        ref={fileRef}
        className="file-input"
        type="file"
        accept="image/*,video/*"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      {viewer && (
        <div className="lightbox" onClick={() => setViewer(null)}>
          <MomentViewer photo={viewer} />
          <button type="button" className="close" onClick={() => setViewer(null)}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

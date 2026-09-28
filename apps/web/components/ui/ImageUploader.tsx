"use client";

import { useRef, useState } from "react";
import { ConfirmModal } from "./ConfirmModal";

/**
 * IMAGE MANAGEMENT V1 — the one shared upload/preview/replace/remove
 * component behind all three image roles (menu item photo, QR hero,
 * restaurant logo). The owner never sees a URL field: choose a photo →
 * preview → save. Upload/delete requests go straight to `uploadUrl`
 * (multipart POST for upload, DELETE for remove) — this component has no
 * opinion on storage, it only knows the two endpoints its parent gives it.
 *
 * Shape controls preview aspect only (visual — matches where the image is
 * used): "circle" for the logo, "wide" for the hero, "square" for a menu
 * item photo.
 */
export interface ImageUploaderProps {
  value: string | null;
  uploadUrl: string;
  label: string;
  shape?: "square" | "circle" | "wide";
  disabled?: boolean;
  onUploaded: (url: string) => void;
  onRemoved: () => void;
}

const SHAPE_CLASS: Record<NonNullable<ImageUploaderProps["shape"]>, string> = {
  square: "aspect-square rounded-xl",
  circle: "aspect-square rounded-full",
  wide: "aspect-video rounded-xl",
};

const ACCEPTED_MIME = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024;

export function ImageUploader({ value, uploadUrl, label, shape = "square", disabled, onUploaded, onRemoved }: ImageUploaderProps) {
  const [status, setStatus] = useState<"idle" | "uploading" | "removing" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = status === "uploading" || status === "removing";

  function validate(file: File): string | null {
    if (!ACCEPTED_MIME.includes(file.type)) return "Dozvoljeni formati su JPEG, PNG i WebP.";
    if (file.size > MAX_BYTES) return "Fajl je prevelik (maksimum 10 MB).";
    return null;
  }

  async function upload(file: File) {
    const validationError = validate(file);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setStatus("uploading");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(uploadUrl, { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
      const url: string = body.imageUrl ?? body.coverImageUrl ?? body.logoUrl;
      onUploaded(url);
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (e) {
      setError((e as Error).message);
      setStatus("idle");
    }
  }

  async function remove() {
    setConfirmRemove(false);
    setError(null);
    setStatus("removing");
    try {
      const res = await fetch(uploadUrl, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
      onRemoved();
      setStatus("idle");
    } catch (e) {
      setError((e as Error).message);
      setStatus("idle");
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (disabled || busy) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void upload(file);
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-sm font-medium text-ink">{label}</p>
        {status === "saved" && <span className="text-xs font-medium text-success">Sačuvano ✓</span>}
      </div>

      <div className="flex items-start gap-4">
        <div
          className={`relative shrink-0 overflow-hidden border border-line bg-cream-100 ${SHAPE_CLASS[shape]} ${shape === "wide" ? "w-40" : "w-20"}`}
          aria-busy={busy}
        >
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element -- admin-side preview of our own uploaded asset, arbitrary aspect handled above
            <img src={value} alt="" className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-ink/30">
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" width="22" height="22">
                <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
                <circle cx="8.5" cy="10" r="1.5" fill="currentColor" />
                <path d="M21 15l-5.5-5.5a1 1 0 0 0-1.4 0L5 19" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          )}
          {busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/70">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-gold border-t-transparent" />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          {!value ? (
            <div
              onClick={() => !disabled && !busy && inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); if (!disabled && !busy) setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              role="button"
              tabIndex={disabled ? -1 : 0}
              onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !disabled && !busy) { e.preventDefault(); inputRef.current?.click(); } }}
              aria-label={`Dodaj fotografiju — ${label}`}
              className={`flex min-h-[72px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-3 py-3 text-center transition-colors ${
                dragging ? "border-gold bg-gold-soft" : "border-line hover:border-gold/50 hover:bg-cream-100"
              } ${disabled || busy ? "pointer-events-none opacity-50" : ""}`}
            >
              <span className="text-sm font-medium text-gold-dark">Dodaj fotografiju</span>
              <span className="mt-0.5 text-xs text-ink/45">Prevuci fajl ili klikni za izbor · JPEG, PNG, WebP · do 10 MB</span>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={disabled || busy}
                className="min-h-11 rounded-md border border-line bg-white px-3.5 text-sm font-medium text-ink hover:border-gold/50 hover:bg-cream-100 disabled:opacity-40"
              >
                Zameni
              </button>
              <button
                type="button"
                onClick={() => setConfirmRemove(true)}
                disabled={disabled || busy}
                className="min-h-11 rounded-md border border-danger/30 bg-transparent px-3.5 text-sm font-medium text-danger hover:bg-danger/5 disabled:opacity-40"
              >
                Ukloni
              </button>
            </div>
          )}
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // allow re-selecting the same file after a remove/replace
          if (file) void upload(file);
        }}
      />

      {confirmRemove && (
        <ConfirmModal
          title="Ukloni fotografiju?"
          body="Fotografija će biti uklonjena i neće se više prikazivati na QR meniju. Ova radnja se ne može opozvati."
          confirmLabel="Ukloni"
          danger
          onConfirm={remove}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </div>
  );
}

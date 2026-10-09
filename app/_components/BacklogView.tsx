"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import {
  ATTACHMENT_ACCEPT,
  BACKLOG_BUCKET,
  backlogCode,
  backlogMessage,
  formatSize,
  isImageType,
  messageToFields,
  pastedFileName,
  safeFileName,
  validateAttachments,
} from "@/lib/backlog";

// Zakładka Backlog (uproszczona 10.10.2026, na prośbę właściciela): lista WIADOMOŚCI zespołu — wpisujesz treść i opcjonalnie dołączasz zrzut ekranu/plik.
// Lista pokazuje wiadomość, autora, datę i załączniki; wiadomość można oznaczyć jako "Zrobione". Baza zostaje bez zmian (typ/priorytet/obszar/osoba/kryteria
// nie są już w UI; stare zadania zachowują te dane). Zmiany statusu idą przez funkcję bazy backlog_apply (zapis + wpis do logu w jednej transakcji).
// Widoczna dla wszystkich ról; dodawać może każdy zalogowany, usuwać tylko Admin.

type FieldChange = { field: string; from: string | null; to: string | null };
type HistoryEntry = { action: "created" | "edited"; by_email: string | null; at: string; changes?: FieldChange[] };

type Item = {
  id: number;
  title: string;
  status: string;
  description: string;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
  done_at: string | null;
  history: HistoryEntry[];
  backlog_attachments?: { count: number }[]; // z zapytania listy: liczba załączników
};

type Attachment = {
  id: number;
  item_id: number;
  path: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_by_user_id: string | null;
  uploaded_by_email: string | null;
  created_at: string;
};

const pill = (active: boolean) =>
  `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const btnPrimary = "bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50";
const inputCls = "w-full border border-line bg-white px-2 py-2 rounded text-sm";

function fmtDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Pliki ze schowka (wklejone zrzuty ekranu) mają ogólną nazwę "image.png" — dajemy im czytelną, z datą.
function collectFiles(list: FileList | File[] | null | undefined, fromPaste = false): File[] {
  return Array.from(list ?? []).map((f) =>
    fromPaste && /^image\.\w+$/i.test(f.name) ? new File([f], pastedFileName(f), { type: f.type }) : f
  );
}

// Wgrywa pliki do prywatnego bucketu i zapisuje ich metadane. Zwraca nazwy plików, których nie udało się wgrać.
async function uploadFiles(session: Session, itemId: number, files: File[]): Promise<{ done: string[]; failed: string[] }> {
  const done: string[] = [];
  const failed: string[] = [];
  for (const f of files) {
    const path = `${itemId}/${crypto.randomUUID()}-${safeFileName(f.name)}`;
    const up = await supabase.storage.from(BACKLOG_BUCKET).upload(path, f, { contentType: f.type, upsert: false });
    if (up.error) {
      failed.push(`${f.name} (${up.error.message})`);
      continue;
    }
    const { error: rowErr } = await supabase.from("backlog_attachments").insert({
      item_id: itemId,
      path,
      filename: f.name,
      mime_type: f.type,
      size_bytes: f.size,
      uploaded_by_user_id: session.user.id,
      uploaded_by_email: session.user.email,
    });
    if (rowErr) {
      await supabase.storage.from(BACKLOG_BUCKET).remove([path]); // nie zostawiamy pliku bez wiersza
      failed.push(`${f.name} (${rowErr.message})`);
      continue;
    }
    done.push(f.name);
  }
  return { done, failed };
}

// Pole do dodawania plików: wybór z dysku albo przeciągnięcie. (Wklejanie ze schowka obsługuje kontener nadrzędny.)
function FilePicker({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!disabled) onFiles(collectFiles(e.dataTransfer.files));
      }}
      className={`border border-dashed rounded px-3 py-3 text-xs text-inksoft flex items-center justify-between gap-3 ${over ? "border-teal bg-tealsoft" : "border-line bg-paper"}`}
    >
      <span>Przeciągnij pliki tutaj, wklej zrzut ekranu (Ctrl+V) albo wybierz z dysku. Do 10 MB, obrazy, PDF, TXT, CSV, DOCX, XLSX.</span>
      <button type="button" onClick={() => inputRef.current?.click()} disabled={disabled} className="px-3 py-1.5 border border-line bg-white rounded font-semibold text-ink disabled:opacity-50 whitespace-nowrap">
        Wybierz pliki
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          onFiles(collectFiles(e.target.files));
          e.target.value = ""; // pozwala wybrać ten sam plik ponownie
        }}
      />
    </div>
  );
}

export default function BacklogView({
  session,
  members,
  isAdmin,
}: {
  session: Session;
  members: (MemberLite & { role?: string })[];
  isAdmin: boolean;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<"active" | "done" | "all">("active");
  const [search, setSearch] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    load();
    const schedule = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(load, 500);
    };
    const channel = supabase
      .channel("backlog-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "backlog_items" }, schedule)
      .subscribe();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      supabase.removeChannel(channel);
    };
  }, []);

  async function load() {
    setLoading(true);
    try {
      const all: Item[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error: err } = await supabase.from("backlog_items").select("id, title, status, description, created_by_email, created_at, updated_at, done_at, history, backlog_attachments(count)").order("id", { ascending: false }).range(from, from + 999);
        if (err) throw new Error(err.message);
        all.push(...((data as Item[]) || []));
        if (!data || data.length < 1000) break;
      }
      setItems(all);
      setError("");
    } catch (e: any) {
      setError(`Nie udało się wczytać wiadomości: ${e.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  // Zrobione <-> aktywne (+ wpis do logu, jedna transakcja w bazie). Powrót z "Zrobione" daje status "backlog".
  async function setDone(item: Item, done: boolean): Promise<boolean> {
    const status = done ? "done" : "backlog";
    if (item.status === status) return true;
    const entry: HistoryEntry = { action: "edited", by_email: session.user.email ?? null, at: new Date().toISOString(), changes: [{ field: "Status", from: item.status === "done" ? "Zrobione" : "Aktywne", to: done ? "Zrobione" : "Aktywne" }] };
    const { error: err } = await supabase.rpc("backlog_apply", { p_id: item.id, p_patch: { status }, p_entry: entry });
    if (err) {
      setError(`Nie udało się zapisać zmiany (${backlogCode(item.id)}): ${err.message}`);
      await load();
      return false;
    }
    setError("");
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, status, done_at: done ? entry.at : null, history: [...(i.history || []), entry] } : i)));
    return true;
  }

  // Wpis do logu bez zmiany pól (np. dodanie/usunięcie załącznika) — ta sama funkcja bazy, pusty patch.
  async function logChange(item: Item, changes: FieldChange[]) {
    const entry: HistoryEntry = { action: "edited", by_email: session.user.email ?? null, at: new Date().toISOString(), changes };
    const { error: err } = await supabase.rpc("backlog_apply", { p_id: item.id, p_patch: {}, p_entry: entry });
    if (err) setError(`Nie udało się zapisać wpisu w logu (${backlogCode(item.id)}): ${err.message}`);
    else await load();
  }

  const activeCount = items.filter((i) => i.status !== "done").length;
  const doneCount = items.length - activeCount;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((i) => (statusFilter === "active" ? i.status !== "done" : statusFilter === "done" ? i.status === "done" : true))
      .filter((i) => {
        if (!q) return true;
        const m = backlogMessage(i);
        return m.head.toLowerCase().includes(q) || m.body.toLowerCase().includes(q) || backlogCode(i.id).toLowerCase().includes(q);
      })
      .sort((a, b) => (a.status === "done" ? 1 : 0) - (b.status === "done" ? 1 : 0) || b.id - a.id); // aktywne najpierw, potem od najnowszych
  }, [items, statusFilter, search]);

  const openItem = items.find((i) => i.id === openId) ?? null;

  return (
    <div className="max-w-4xl">
      <AddForm
        session={session}
        onCreated={async () => {
          await load();
        }}
        onError={setError}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setStatusFilter("active")} className={pill(statusFilter === "active")}>Aktywne {activeCount}</button>
          <button onClick={() => setStatusFilter("done")} className={pill(statusFilter === "done")}>Zrobione {doneCount}</button>
          <button onClick={() => setStatusFilter("all")} className={pill(statusFilter === "all")}>Wszystkie {items.length}</button>
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Szukaj w wiadomościach" className="w-64 border border-line bg-white px-3 py-2 rounded text-sm" />
      </div>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}

      <div className="border border-line bg-white">
        {!loading && visible.length === 0 && (
          <div className="p-6 text-center text-inksoft text-sm">{items.length === 0 ? "Brak wiadomości — napisz pierwszą w polu powyżej." : "Nic nie pasuje do filtra."}</div>
        )}
        {visible.map((i) => {
          const m = backlogMessage(i);
          const done = i.status === "done";
          const att = i.backlog_attachments?.[0]?.count ?? 0;
          return (
            <div key={i.id} className={`flex items-start gap-3 px-4 py-3 border-b border-line last:border-b-0 hover:bg-paper ${done ? "text-inksoft" : ""}`}>
              <input type="checkbox" checked={done} onChange={(e) => setDone(i, e.target.checked)} title={done ? "Przywróć jako aktywne" : "Oznacz jako zrobione"} className="mt-1" />
              <button onClick={() => setOpenId(i.id)} className="flex-1 min-w-0 text-left">
                {m.head && <div className={`text-sm font-semibold ${done ? "line-through" : ""}`}>{m.head}</div>}
                {m.body && <div className={`text-sm whitespace-pre-wrap break-words line-clamp-4 ${m.head ? "text-inksoft" : done ? "line-through" : ""}`}>{m.body}</div>}
                <div className="text-xs text-inksoft mt-1">
                  <span className="font-mono">{backlogCode(i.id)}</span> · {displayNameForEmail(i.created_by_email, members)} · {fmtDateTime(i.created_at)}
                  {att > 0 && <span title="Załączniki"> · 📎 {att}</span>}
                </div>
              </button>
            </div>
          );
        })}
      </div>

      {openItem && (
        <BacklogCard
          item={openItem}
          members={members}
          isAdmin={isAdmin}
          onClose={() => setOpenId(null)}
          onSetDone={setDone}
          session={session}
          onLog={logChange}
          onDeleted={async () => {
            setOpenId(null);
            await load();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

/* ---------------- dodawanie wiadomości ---------------- */

function AddForm({ session, onCreated, onError }: { session: Session; onCreated: () => Promise<void>; onError: (msg: string) => void }) {
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [files, setFiles] = useState<File[]>([]);

  function addFiles(list: File[]) {
    if (list.length === 0) return;
    const problems = validateAttachments([...files, ...list], 0);
    if (problems.length > 0) {
      setFormError(problems.join(" "));
      return;
    }
    setFormError("");
    setFiles((prev) => [...prev, ...list]);
  }

  async function submit() {
    setFormError("");
    const text = message.trim();
    if (!text && files.length === 0) {
      setFormError("Napisz wiadomość albo dołącz plik.");
      return;
    }
    setSaving(true);
    const fields = messageToFields(text || "(załącznik)");
    const { data: created, error: err } = await supabase.from("backlog_items").insert({
      title: fields.title,
      type: "task",
      priority: "p2",
      status: "backlog",
      area: null,
      description: fields.description,
      acceptance: "",
      assignee_email: null,
      created_by_user_id: session.user.id,
      created_by_email: session.user.email,
      history: [{ action: "created", by_email: session.user.email ?? null, at: new Date().toISOString() }],
    }).select("id").single();
    if (err || !created) {
      setSaving(false);
      setFormError(`Nie udało się dodać wiadomości: ${err?.message ?? "brak odpowiedzi"}`);
      onError("");
      return;
    }
    // Wiadomość już istnieje — załączniki dodajemy do niej; ewentualne porażki zgłaszamy, ale wiadomości nie cofamy.
    const { failed } = files.length > 0 ? await uploadFiles(session, created.id as number, files) : { failed: [] as string[] };
    setSaving(false);
    setMessage("");
    setFiles([]);
    await onCreated();
    if (failed.length > 0) onError(`Wiadomość dodano, ale nie wszystkie załączniki się wgrały: ${failed.join("; ")}. Dodaj je ponownie na karcie wiadomości.`);
  }

  return (
    <div
      className="border border-line bg-white p-4 mb-5"
      onPaste={(e) => {
        const pasted = collectFiles(e.clipboardData.files, true);
        if (pasted.length > 0) {
          e.preventDefault(); // wklejamy plik (zrzut ekranu), nie tekst
          addFiles(pasted);
        }
      }}
    >
      <h2 className="text-xs font-semibold text-inksoft mb-2">NOWA WIADOMOŚĆ</h2>
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} maxLength={4000} placeholder="Napisz, co trzeba zrobić, poprawić albo zgłosić" className={`${inputCls} mb-3`} />
      <div className="mb-3">
        <FilePicker onFiles={addFiles} disabled={saving} />
        {files.length > 0 && (
          <ul className="mt-2 text-xs space-y-1">
            {files.map((f, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="font-mono">{f.name}</span>
                <span className="text-inksoft">{formatSize(f.size)}</span>
                <button type="button" onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} className="text-rust hover:underline">usuń</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {formError && <p className="text-rust text-xs mb-2">{formError}</p>}
      <button onClick={submit} disabled={saving} className={btnPrimary}>{saving ? (files.length > 0 ? "Zapisywanie i wgrywanie plików…" : "Zapisywanie…") : "Dodaj"}</button>
    </div>
  );
}

/* ---------------- karta wiadomości ---------------- */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 px-3 py-2 border-b border-line last:border-b-0 text-sm">
      <span className="text-inksoft">{label}</span>
      <span className="font-semibold text-right">{children}</span>
    </div>
  );
}

function BacklogCard({
  item,
  members,
  isAdmin,
  onClose,
  onSetDone,
  session,
  onLog,
  onDeleted,
  onError,
}: {
  item: Item;
  members: MemberLite[];
  isAdmin: boolean;
  onClose: () => void;
  onSetDone: (item: Item, done: boolean) => Promise<boolean>;
  session: Session;
  onLog: (item: Item, changes: FieldChange[]) => Promise<void>;
  onDeleted: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [attError, setAttError] = useState("");
  const m = backlogMessage(item);
  const done = item.status === "done";
  useEffect(() => {
    loadAttachments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  // Bucket jest prywatny — do wyświetlenia potrzebne są podpisane adresy (ważne godzinę, odnawiane przy każdym otwarciu karty).
  async function loadAttachments() {
    const { data, error: err } = await supabase.from("backlog_attachments").select("*").eq("item_id", item.id).order("created_at");
    if (err) {
      setAttError(`Nie udało się wczytać załączników: ${err.message}`);
      return;
    }
    const list = (data as Attachment[]) || [];
    setAttachments(list);
    if (list.length > 0) {
      const signed = await supabase.storage.from(BACKLOG_BUCKET).createSignedUrls(list.map((a) => a.path), 3600);
      const map: Record<string, string> = {};
      for (const x of signed.data || []) if (x.signedUrl && x.path) map[x.path] = x.signedUrl;
      setUrls(map);
    }
  }

  async function addFiles(list: File[]) {
    if (list.length === 0) return;
    const problems = validateAttachments(list, attachments.length);
    if (problems.length > 0) {
      setAttError(problems.join(" "));
      return;
    }
    setAttError("");
    setUploading(true);
    const { done, failed } = await uploadFiles(session, item.id, list);
    setUploading(false);
    if (failed.length > 0) setAttError(`Nie udało się wgrać: ${failed.join("; ")}`);
    await loadAttachments();
    if (done.length > 0) await onLog(item, done.map((n) => ({ field: "Załącznik", from: null, to: n })));
  }

  // Najpierw plik, potem wiersz: polityka usuwania pliku sprawdza wiersz w backlog_attachments (patrz backlog.sql).
  async function removeAttachment(a: Attachment) {
    if (!confirm(`Usunąć załącznik „${a.filename}”?`)) return;
    const rm = await supabase.storage.from(BACKLOG_BUCKET).remove([a.path]);
    if (rm.error || !rm.data?.length) {
      setAttError(rm.error ? `Nie udało się usunąć pliku: ${rm.error.message}` : "Nie usunięto — załącznik może usunąć tylko jego autor albo Admin.");
      return;
    }
    const { error: err } = await supabase.from("backlog_attachments").delete().eq("id", a.id);
    if (err) {
      setAttError(`Plik usunięto, ale nie wiersz: ${err.message}`);
      return;
    }
    setAttError("");
    await loadAttachments();
    await onLog(item, [{ field: "Załącznik", from: a.filename, to: null }]);
  }


  // Usuwanie tylko dla Admina (polityka w bazie: is_admin(); każde usunięcie trafia do deleted_records).
  async function remove() {
    if (!confirm(`Usunąć wiadomość ${backlogCode(item.id)}? Tej operacji nie można cofnąć.`)) return;
    // Pliki usuwamy razem z wiadomością (wiersze znikną kaskadowo, ale pliki w Storage same by zostały).
    if (attachments.length > 0) await supabase.storage.from(BACKLOG_BUCKET).remove(attachments.map((a) => a.path));
    const { data, error: err } = await supabase.from("backlog_items").delete().eq("id", item.id).select("id");
    if (err) onError(`Nie udało się usunąć: ${err.message}`);
    else if (!data?.length) onError("Nie usunięto — brak uprawnień (tylko Admin) albo wiadomość już nie istnieje.");
    else await onDeleted();
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex justify-end z-50" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="w-full max-w-lg bg-paper h-full overflow-y-auto p-6 border-l border-line"
        onPaste={(e) => {
          const pasted = collectFiles(e.clipboardData.files, true);
          if (pasted.length > 0) {
            e.preventDefault();
            addFiles(pasted);
          }
        }}
      >
        <div className="flex justify-between items-start mb-3">
          <div className="text-xs text-inksoft font-mono">{backlogCode(item.id)}</div>
          <button onClick={onClose} className="text-inksoft text-lg">✕</button>
        </div>

        <div className="border border-line bg-white mb-4 p-3 text-sm whitespace-pre-wrap break-words">
          {m.head && <div className="font-semibold">{m.head}</div>}
          {m.body && <div className={m.head ? "text-inksoft mt-1" : ""}>{m.body}</div>}
        </div>

        <div className="border border-line bg-white mb-4">
          <Row label="Dodał">{displayNameForEmail(item.created_by_email, members)}</Row>
          <Row label="Dodano">{fmtDateTime(item.created_at)}</Row>
          <Row label="Status">{done ? `Zrobione (${fmtDateTime(item.done_at)})` : "Aktywne"}</Row>
        </div>
        <button onClick={() => onSetDone(item, !done)} className={`${btnPrimary} mb-6`}>{done ? "Przywróć jako aktywne" : "Oznacz jako zrobione ✓"}</button>

        <h3 className="text-xs font-semibold text-inksoft mb-2">ZAŁĄCZNIKI {attachments.length > 0 && `(${attachments.length})`}</h3>
        <div className="border border-line bg-white mb-6 p-3 text-sm">
          {attachments.length === 0 && <div className="text-inksoft mb-2">Brak załączników.</div>}
          {attachments.some((a) => isImageType(a.mime_type)) && (
            <div className="flex flex-wrap gap-2 mb-3">
              {attachments.filter((a) => isImageType(a.mime_type)).map((a) => (
                <div key={a.id} className="relative">
                  {urls[a.path] ? (
                    <a href={urls[a.path]} target="_blank" rel="noreferrer" title={a.filename}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={urls[a.path]} alt={a.filename} className="h-24 w-24 object-cover border border-line rounded" />
                    </a>
                  ) : (
                    <div className="h-24 w-24 border border-line rounded bg-paper" />
                  )}
                  <button onClick={() => removeAttachment(a)} title="Usuń załącznik" className="absolute -top-2 -right-2 bg-white border border-line rounded-full w-5 h-5 text-xs leading-none text-rust">✕</button>
                </div>
              ))}
            </div>
          )}
          {attachments.filter((a) => !isImageType(a.mime_type)).map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-2 mb-1">
              {urls[a.path] ? (
                <a href={urls[a.path]} target="_blank" rel="noreferrer" className="text-teal hover:underline truncate">{a.filename}</a>
              ) : (
                <span className="truncate">{a.filename}</span>
              )}
              <span className="text-xs text-inksoft whitespace-nowrap">{formatSize(a.size_bytes)}</span>
              <button onClick={() => removeAttachment(a)} className="text-xs text-rust hover:underline">usuń</button>
            </div>
          ))}
          <div className="mt-2">
            <FilePicker onFiles={addFiles} disabled={uploading} />
          </div>
          {uploading && <p className="text-xs text-inksoft mt-2">Wgrywanie…</p>}
          {attError && <p className="text-rust text-xs mt-2">{attError}</p>}
        </div>

        <h3 className="text-xs font-semibold text-inksoft mb-2">LOG ZMIAN</h3>
        <div className="border border-line bg-white mb-6 p-3 text-sm">
          {!item.history?.length && <div className="text-inksoft">Brak wpisów.</div>}
          {item.history?.map((h, i) => (
            <div key={i} className="mb-2 last:mb-0">
              <div>
                <span className="font-mono text-inksoft mr-1">{i + 1}.</span>
                {h.action === "created" ? "Utworzono" : "Edytowano"} przez <span className="font-semibold">{displayNameForEmail(h.by_email, members)}</span>, {fmtDateTime(h.at)}
              </div>
              {!!h.changes?.length && (
                <ul className="ml-6 list-disc text-xs text-inksoft">
                  {h.changes.map((c, j) => (
                    <li key={j}>{c.field}: „{c.from || "—"}” → „{c.to || "—"}”</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>

        {isAdmin && (
          <button onClick={remove} className="text-xs font-semibold text-rust hover:underline">Usuń wiadomość</button>
        )}
      </div>
    </div>
  );
}

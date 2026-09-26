"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import {
  ATTACHMENT_ACCEPT,
  BACKLOG_BUCKET,
  BACKLOG_AREAS,
  BACKLOG_PRIORITIES,
  BACKLOG_STATUSES,
  BACKLOG_TYPES,
  backlogCode,
  backlogLabel,
  compareBacklog,
  formatSize,
  isImageType,
  pastedFileName,
  safeFileName,
  validateAttachments,
  type BacklogPriority,
  type BacklogStatus,
  type BacklogType,
} from "@/lib/backlog";

// Zakładka Backlog: zadania i pomysły zespołu. Lista z filtrami, szybkie zmiany statusu/priorytetu/osoby w wierszu i karta
// zadania (opis, kryteria akceptacji, log zmian). Zmiany idą przez funkcję bazy backlog_apply (zapis + wpis do logu w jednej
// transakcji). Widoczna dla wszystkich ról; dodawać i edytować może każdy zalogowany, usuwać tylko Admin.

type FieldChange = { field: string; from: string | null; to: string | null };
type HistoryEntry = { action: "created" | "edited"; by_email: string | null; at: string; changes?: FieldChange[] };

type Item = {
  id: number;
  title: string;
  type: BacklogType;
  priority: BacklogPriority;
  status: BacklogStatus;
  area: string | null;
  description: string;
  acceptance: string;
  assignee_email: string | null;
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

type Patch = Partial<Pick<Item, "title" | "type" | "priority" | "status" | "area" | "description" | "acceptance" | "assignee_email">>;

const FIELD_LABEL: Record<keyof Patch, string> = {
  title: "Tytuł",
  type: "Typ",
  priority: "Priorytet",
  status: "Status",
  area: "Obszar",
  description: "Opis",
  acceptance: "Kryteria akceptacji",
  assignee_email: "Osoba",
};

const PRIORITY_STYLE: Record<BacklogPriority, string> = {
  p1: "bg-rustsoft text-rust",
  p2: "bg-ambersoft text-amber",
  p3: "bg-paper text-inksoft border border-line",
};
const STATUS_STYLE: Record<BacklogStatus, string> = {
  backlog: "bg-paper text-inksoft border border-line",
  todo: "bg-ambersoft text-amber",
  in_progress: "bg-[#e3ecf9] text-[#2a6bb5]",
  review: "bg-[#efe6f8] text-[#7a3fb0]",
  done: "bg-tealsoft text-teal",
};
const TYPE_STYLE: Record<BacklogType, string> = {
  feature: "bg-tealsoft text-teal",
  improvement: "bg-[#e3ecf9] text-[#2a6bb5]",
  bug: "bg-rustsoft text-rust",
  task: "bg-paper text-inksoft border border-line",
};

const pill = (active: boolean) =>
  `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const btnPrimary = "bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50";
const inputCls = "w-full border border-line bg-white px-2 py-2 rounded text-sm";

function fmtDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Wartość pola w logu: etykieta zamiast klucza, długie teksty skrócone.
function logValue(field: keyof Patch, v: string | null, members: MemberLite[]): string | null {
  if (v === null || v === "") return null;
  if (field === "type") return backlogLabel(BACKLOG_TYPES, v);
  if (field === "priority") return backlogLabel(BACKLOG_PRIORITIES, v);
  if (field === "status") return backlogLabel(BACKLOG_STATUSES, v);
  if (field === "assignee_email") return displayNameForEmail(v, members);
  return v.length > 90 ? v.slice(0, 90) + "…" : v;
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
  const [adding, setAdding] = useState(false);

  // filtry
  const [statusFilter, setStatusFilter] = useState<"active" | "all" | BacklogStatus>("active");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [areaFilter, setAreaFilter] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState(""); // "" wszyscy, "__none" nieprzypisane, albo e-mail
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
        const { data, error: err } = await supabase.from("backlog_items").select("*, backlog_attachments(count)").order("id", { ascending: false }).range(from, from + 999);
        if (err) throw new Error(err.message);
        all.push(...((data as Item[]) || []));
        if (!data || data.length < 1000) break;
      }
      setItems(all);
      setError("");
    } catch (e: any) {
      setError(`Nie udało się wczytać zadań: ${e.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  // Zmiana pól zadania + wpis do logu (jedna transakcja w bazie). Zwraca true, gdy się udało.
  async function applyPatch(item: Item, patch: Patch): Promise<boolean> {
    const changes: FieldChange[] = [];
    for (const k of Object.keys(patch) as (keyof Patch)[]) {
      const before = (item[k] as string | null) ?? null;
      const after = patch[k] === undefined ? null : ((patch[k] as string | null) ?? null);
      if ((before ?? "") !== (after ?? "")) changes.push({ field: FIELD_LABEL[k], from: logValue(k, before, members), to: logValue(k, after, members) });
    }
    if (changes.length === 0) return true;
    const entry: HistoryEntry = { action: "edited", by_email: session.user.email ?? null, at: new Date().toISOString(), changes };
    const { error: err } = await supabase.rpc("backlog_apply", { p_id: item.id, p_patch: patch, p_entry: entry });
    if (err) {
      setError(`Nie udało się zapisać zmiany (${backlogCode(item.id)}): ${err.message}`);
      await load();
      return false;
    }
    setError("");
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...patch, history: [...(i.history || []), entry] } : i)));
    return true;
  }

  // Wpis do logu bez zmiany pól zadania (np. dodanie/usunięcie załącznika) — ta sama funkcja bazy, pusty patch.
  async function logChange(item: Item, changes: FieldChange[]) {
    const entry: HistoryEntry = { action: "edited", by_email: session.user.email ?? null, at: new Date().toISOString(), changes };
    const { error: err } = await supabase.rpc("backlog_apply", { p_id: item.id, p_patch: {}, p_entry: entry });
    if (err) setError(`Nie udało się zapisać wpisu w logu (${backlogCode(item.id)}): ${err.message}`);
    else await load();
  }

  const assignable = useMemo(() => members.filter((m) => m.email), [members]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const i of items) c[i.status] = (c[i.status] ?? 0) + 1;
    return c;
  }, [items]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((i) => (statusFilter === "active" ? i.status !== "done" : statusFilter === "all" ? true : i.status === statusFilter))
      .filter((i) => !priorityFilter || i.priority === priorityFilter)
      .filter((i) => !typeFilter || i.type === typeFilter)
      .filter((i) => !areaFilter || i.area === areaFilter)
      .filter((i) => !assigneeFilter || (assigneeFilter === "__none" ? !i.assignee_email : i.assignee_email === assigneeFilter))
      .filter((i) => !q || i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q) || backlogCode(i.id).toLowerCase().includes(q))
      .sort(compareBacklog);
  }, [items, statusFilter, priorityFilter, typeFilter, areaFilter, assigneeFilter, search]);

  const openItem = items.find((i) => i.id === openId) ?? null;
  const activeCount = items.filter((i) => i.status !== "done").length;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setStatusFilter("active")} className={pill(statusFilter === "active")}>Aktywne {activeCount}</button>
          {BACKLOG_STATUSES.map((s) => (
            <button key={s.key} onClick={() => setStatusFilter(s.key)} className={pill(statusFilter === s.key)}>
              {s.label} {counts[s.key] ?? 0}
            </button>
          ))}
          <button onClick={() => setStatusFilter("all")} className={pill(statusFilter === "all")}>Wszystkie {items.length}</button>
        </div>
        <button onClick={() => setAdding((a) => !a)} className={btnPrimary}>{adding ? "Zamknij formularz" : "+ Dodaj zadanie"}</button>
      </div>

      {adding && (
        <AddForm
          session={session}
          members={assignable}
          onCreated={async () => {
            setAdding(false);
            await load();
          }}
          onError={setError}
        />
      )}

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Szukaj w tytule, opisie lub numerze (ZAD-12)" className="w-80 border border-line bg-white px-3 py-2 rounded text-sm" />
        <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)} className="border border-line bg-white px-2 py-2 rounded text-sm">
          <option value="">Każdy priorytet</option>
          {BACKLOG_PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="border border-line bg-white px-2 py-2 rounded text-sm">
          <option value="">Każdy typ</option>
          {BACKLOG_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <select value={areaFilter} onChange={(e) => setAreaFilter(e.target.value)} className="border border-line bg-white px-2 py-2 rounded text-sm">
          <option value="">Każdy obszar</option>
          {BACKLOG_AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)} className="border border-line bg-white px-2 py-2 rounded text-sm">
          <option value="">Każda osoba</option>
          <option value="__none">Nieprzypisane</option>
          {assignable.map((m) => <option key={m.email} value={m.email}>{displayNameForEmail(m.email, members)}</option>)}
        </select>
        <span className="text-xs text-inksoft">{visible.length} z {items.length}</span>
      </div>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}

      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">ID</th>
              <th className="p-3">Zadanie</th>
              <th className="p-3">Typ</th>
              <th className="p-3">Priorytet</th>
              <th className="p-3">Status</th>
              <th className="p-3">Osoba</th>
              <th className="p-3">Obszar</th>
              <th className="p-3">Dodano</th>
            </tr>
          </thead>
          <tbody>
            {!loading && visible.length === 0 && (
              <tr><td colSpan={8} className="p-6 text-center text-inksoft text-sm">{items.length === 0 ? "Brak zadań — dodaj pierwsze przyciskiem powyżej." : "Nic nie pasuje do filtrów."}</td></tr>
            )}
            {visible.map((i) => (
              <tr key={i.id} className={`border-b border-line last:border-b-0 hover:bg-paper align-top ${i.status === "done" ? "text-inksoft" : ""}`}>
                <td className="p-3 font-mono text-xs whitespace-nowrap">{backlogCode(i.id)}</td>
                <td className="p-3 max-w-md">
                  <button onClick={() => setOpenId(i.id)} className={`text-left font-semibold hover:underline ${i.status === "done" ? "line-through" : "text-teal"}`}>{i.title}</button>
                  {i.description && <div className="text-xs text-inksoft truncate max-w-md">{i.description}</div>}
                  {(i.backlog_attachments?.[0]?.count ?? 0) > 0 && (
                    <div className="text-xs text-inksoft" title="Załączniki">📎 {i.backlog_attachments![0].count}</div>
                  )}
                </td>
                <td className="p-3 whitespace-nowrap">
                  <span className={`text-xs font-semibold px-2 py-1 rounded-full ${TYPE_STYLE[i.type]}`}>{backlogLabel(BACKLOG_TYPES, i.type)}</span>
                </td>
                <td className="p-3">
                  <select value={i.priority} onChange={(e) => applyPatch(i, { priority: e.target.value as BacklogPriority })} className={`text-xs font-semibold px-2 py-1 rounded-full border-none ${PRIORITY_STYLE[i.priority]}`}>
                    {BACKLOG_PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                  </select>
                </td>
                <td className="p-3">
                  <select value={i.status} onChange={(e) => applyPatch(i, { status: e.target.value as BacklogStatus })} className={`text-xs font-semibold px-2 py-1 rounded-full border-none ${STATUS_STYLE[i.status]}`}>
                    {BACKLOG_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                </td>
                <td className="p-3">
                  <select value={i.assignee_email ?? ""} onChange={(e) => applyPatch(i, { assignee_email: e.target.value || null })} className="text-xs border border-line bg-white px-2 py-1 rounded max-w-[10rem]">
                    <option value="">—</option>
                    {assignable.map((m) => <option key={m.email} value={m.email}>{displayNameForEmail(m.email, members)}</option>)}
                    {i.assignee_email && !assignable.some((m) => m.email === i.assignee_email) && <option value={i.assignee_email}>{i.assignee_email}</option>}
                  </select>
                </td>
                <td className="p-3 text-xs whitespace-nowrap">{i.area || "—"}</td>
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">
                  {fmtDateTime(i.created_at)}
                  <div>{displayNameForEmail(i.created_by_email, members)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {openItem && (
        <BacklogCard
          item={openItem}
          members={members}
          assignable={assignable}
          isAdmin={isAdmin}
          onClose={() => setOpenId(null)}
          onApply={applyPatch}
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

/* ---------------- dodawanie zadania ---------------- */

function AddForm({
  session,
  members,
  onCreated,
  onError,
}: {
  session: Session;
  members: MemberLite[];
  onCreated: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<BacklogType>("task");
  const [priority, setPriority] = useState<BacklogPriority>("p2");
  const [area, setArea] = useState("");
  const [assignee, setAssignee] = useState("");
  const [description, setDescription] = useState("");
  const [acceptance, setAcceptance] = useState("");
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
    if (!title.trim()) {
      setFormError("Podaj tytuł zadania.");
      return;
    }
    setSaving(true);
    const { data: created, error: err } = await supabase.from("backlog_items").insert({
      title: title.trim(),
      type,
      priority,
      status: "backlog",
      area: area || null,
      description: description.trim(),
      acceptance: acceptance.trim(),
      assignee_email: assignee || null,
      created_by_user_id: session.user.id,
      created_by_email: session.user.email,
      history: [{ action: "created", by_email: session.user.email ?? null, at: new Date().toISOString() }],
    }).select("id").single();
    if (err || !created) {
      setSaving(false);
      setFormError(`Nie udało się dodać zadania: ${err?.message ?? "brak odpowiedzi"}`);
      onError("");
      return;
    }
    // Zadanie już istnieje — załączniki dodajemy do niego; ewentualne porażki zgłaszamy, ale zadania nie cofamy.
    const { failed } = files.length > 0 ? await uploadFiles(session, created.id as number, files) : { failed: [] as string[] };
    setSaving(false);
    await onCreated();
    if (failed.length > 0) onError(`Zadanie dodano, ale nie wszystkie załączniki się wgrały: ${failed.join("; ")}. Dodaj je ponownie na karcie zadania.`);
  }

  return (
    <div
      className="border border-line bg-white p-4 mb-4"
      onPaste={(e) => {
        const pasted = collectFiles(e.clipboardData.files, true);
        if (pasted.length > 0) {
          e.preventDefault(); // wklejamy plik (zrzut ekranu), nie tekst
          addFiles(pasted);
        }
      }}
    >
      <h2 className="text-xs font-semibold text-inksoft mb-3">NOWE ZADANIE</h2>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-3">
        <div className="md:col-span-4">
          <label className="text-xs font-semibold text-inksoft block mb-1">Tytuł *</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="np. Automatyczne pobieranie zamówień" className={inputCls} autoFocus />
        </div>
        <div>
          <label className="text-xs font-semibold text-inksoft block mb-1">Typ</label>
          <select value={type} onChange={(e) => setType(e.target.value as BacklogType)} className={inputCls}>
            {BACKLOG_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-inksoft block mb-1">Priorytet</label>
          <select value={priority} onChange={(e) => setPriority(e.target.value as BacklogPriority)} className={inputCls}>
            {BACKLOG_PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-inksoft block mb-1">Obszar</label>
          <select value={area} onChange={(e) => setArea(e.target.value)} className={inputCls}>
            <option value="">—</option>
            {BACKLOG_AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-inksoft block mb-1">Osoba (opcjonalnie)</label>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={inputCls}>
            <option value="">—</option>
            {members.map((m) => <option key={m.email} value={m.email}>{displayNameForEmail(m.email, members)}</option>)}
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="text-xs font-semibold text-inksoft block mb-1">Opis</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Co dokładnie trzeba zrobić i dlaczego" className={inputCls} />
        </div>
        <div className="md:col-span-2">
          <label className="text-xs font-semibold text-inksoft block mb-1">Kryteria akceptacji</label>
          <textarea value={acceptance} onChange={(e) => setAcceptance(e.target.value)} rows={3} placeholder="Po czym poznamy, że to jest zrobione" className={inputCls} />
        </div>
      </div>
      <div className="mb-3">
        <label className="text-xs font-semibold text-inksoft block mb-1">Załączniki (opcjonalnie)</label>
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
      <button onClick={submit} disabled={saving} className={btnPrimary}>{saving ? (files.length > 0 ? "Zapisywanie i wgrywanie plików…" : "Zapisywanie…") : "Dodaj zadanie"}</button>
    </div>
  );
}

/* ---------------- karta zadania ---------------- */

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
  assignable,
  isAdmin,
  onClose,
  onApply,
  session,
  onLog,
  onDeleted,
  onError,
}: {
  item: Item;
  members: MemberLite[];
  assignable: MemberLite[];
  isAdmin: boolean;
  onClose: () => void;
  onApply: (item: Item, patch: Patch) => Promise<boolean>;
  session: Session;
  onLog: (item: Item, changes: FieldChange[]) => Promise<void>;
  onDeleted: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [attError, setAttError] = useState("");

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

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({ title: "", type: "task" as BacklogType, priority: "p2" as BacklogPriority, area: "", assignee: "", description: "", acceptance: "" });

  function startEdit() {
    setDraft({
      title: item.title,
      type: item.type,
      priority: item.priority,
      area: item.area ?? "",
      assignee: item.assignee_email ?? "",
      description: item.description,
      acceptance: item.acceptance,
    });
    setEditing(true);
  }

  async function save() {
    if (!draft.title.trim()) {
      onError("Tytuł nie może być pusty.");
      return;
    }
    setSaving(true);
    const ok = await onApply(item, {
      title: draft.title.trim(),
      type: draft.type,
      priority: draft.priority,
      area: draft.area || null,
      assignee_email: draft.assignee || null,
      description: draft.description.trim(),
      acceptance: draft.acceptance.trim(),
    });
    setSaving(false);
    if (ok) setEditing(false);
  }

  // Usuwanie tylko dla Admina (polityka w bazie: is_admin(); każde usunięcie trafia do deleted_records).
  async function remove() {
    if (!confirm(`Usunąć zadanie ${backlogCode(item.id)} „${item.title}”? Tej operacji nie można cofnąć.`)) return;
    // Pliki zadania usuwamy razem z nim (wiersze znikną kaskadowo, ale pliki w Storage same by zostały).
    if (attachments.length > 0) await supabase.storage.from(BACKLOG_BUCKET).remove(attachments.map((a) => a.path));
    const { data, error: err } = await supabase.from("backlog_items").delete().eq("id", item.id).select("id");
    if (err) onError(`Nie udało się usunąć: ${err.message}`);
    else if (!data?.length) onError("Nie usunięto — brak uprawnień (tylko Admin) albo zadanie już nie istnieje.");
    else await onDeleted();
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex justify-end z-50" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="w-full max-w-lg bg-paper h-full overflow-y-auto p-6 border-l border-line"
        onPaste={(e) => {
          if (editing) return;
          const pasted = collectFiles(e.clipboardData.files, true);
          if (pasted.length > 0) {
            e.preventDefault();
            addFiles(pasted);
          }
        }}
      >
        <div className="flex justify-between items-start mb-1">
          <div className="text-xs text-inksoft font-mono">{backlogCode(item.id)}</div>
          <button onClick={onClose} className="text-inksoft text-lg">✕</button>
        </div>

        {!editing ? (
          <>
            <h2 className="text-lg font-semibold mb-3">{item.title}</h2>
            <div className="flex flex-wrap gap-2 mb-4">
              <span className={`text-xs font-semibold px-2 py-1 rounded-full ${TYPE_STYLE[item.type]}`}>{backlogLabel(BACKLOG_TYPES, item.type)}</span>
              <span className={`text-xs font-semibold px-2 py-1 rounded-full ${PRIORITY_STYLE[item.priority]}`}>{backlogLabel(BACKLOG_PRIORITIES, item.priority)}</span>
              <span className={`text-xs font-semibold px-2 py-1 rounded-full ${STATUS_STYLE[item.status]}`}>{backlogLabel(BACKLOG_STATUSES, item.status)}</span>
            </div>

            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-inksoft">SZCZEGÓŁY</h3>
              <button onClick={startEdit} className="text-xs font-semibold text-teal hover:underline">Edytuj</button>
            </div>
            <div className="border border-line bg-white mb-6">
              <Row label="Osoba">{item.assignee_email ? displayNameForEmail(item.assignee_email, members) : "—"}</Row>
              <Row label="Obszar">{item.area || "—"}</Row>
              <Row label="Dodał">{displayNameForEmail(item.created_by_email, members)}</Row>
              <Row label="Dodano">{fmtDateTime(item.created_at)}</Row>
              <Row label="Zmieniono">{fmtDateTime(item.updated_at)}</Row>
              {item.done_at && <Row label="Zrobiono">{fmtDateTime(item.done_at)}</Row>}
            </div>

            <h3 className="text-xs font-semibold text-inksoft mb-2">OPIS</h3>
            <div className="border border-line bg-white mb-6 p-3 text-sm whitespace-pre-wrap">{item.description || <span className="text-inksoft">Brak opisu.</span>}</div>

            <h3 className="text-xs font-semibold text-inksoft mb-2">KRYTERIA AKCEPTACJI</h3>
            <div className="border border-line bg-white mb-6 p-3 text-sm whitespace-pre-wrap">{item.acceptance || <span className="text-inksoft">Brak kryteriów.</span>}</div>
          </>
        ) : (
          <div className="space-y-2 mb-6 mt-2">
            <div>
              <label className="text-xs font-semibold text-inksoft block mb-1">Tytuł *</label>
              <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className={inputCls} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-semibold text-inksoft block mb-1">Typ</label>
                <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as BacklogType })} className={inputCls}>
                  {BACKLOG_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-inksoft block mb-1">Priorytet</label>
                <select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value as BacklogPriority })} className={inputCls}>
                  {BACKLOG_PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-inksoft block mb-1">Obszar</label>
                <select value={draft.area} onChange={(e) => setDraft({ ...draft, area: e.target.value })} className={inputCls}>
                  <option value="">—</option>
                  {BACKLOG_AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
                  {draft.area && !(BACKLOG_AREAS as readonly string[]).includes(draft.area) && <option value={draft.area}>{draft.area}</option>}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-inksoft block mb-1">Osoba</label>
                <select value={draft.assignee} onChange={(e) => setDraft({ ...draft, assignee: e.target.value })} className={inputCls}>
                  <option value="">—</option>
                  {assignable.map((m) => <option key={m.email} value={m.email}>{displayNameForEmail(m.email, members)}</option>)}
                  {draft.assignee && !assignable.some((m) => m.email === draft.assignee) && <option value={draft.assignee}>{draft.assignee}</option>}
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-inksoft block mb-1">Opis</label>
              <textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={5} className={inputCls} />
            </div>
            <div>
              <label className="text-xs font-semibold text-inksoft block mb-1">Kryteria akceptacji</label>
              <textarea value={draft.acceptance} onChange={(e) => setDraft({ ...draft, acceptance: e.target.value })} rows={4} className={inputCls} />
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={save} disabled={saving} className={btnPrimary}>{saving ? "Zapisywanie…" : "Zapisz"}</button>
              <button onClick={() => setEditing(false)} className="px-4 py-2 border border-line rounded text-sm font-semibold">Anuluj</button>
            </div>
          </div>
        )}

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
          <button onClick={remove} className="text-xs font-semibold text-rust hover:underline">Usuń zadanie</button>
        )}
      </div>
    </div>
  );
}

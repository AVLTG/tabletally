"use client";

import { useState, useEffect, FormEvent } from "react";
import Link from "next/link";

interface DeckSummary { id: string; name: string; cardCount: number }
interface MissingCard { line: number; cardName: string; set: string | null; collectorNumber: string | null }
interface ImportError { line: number; raw: string; reason: string }

export default function DecksPage() {
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [isLegacyAdmin, setIsLegacyAdmin] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  // create form
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState("");

  // import flow: idle -> editing -> prompt (missing list) -> done
  const [showImport, setShowImport] = useState(false);
  const [importName, setImportName] = useState("");
  const [importFormat, setImportFormat] = useState("");
  const [importCommander, setImportCommander] = useState("");
  const [importText, setImportText] = useState("");
  const [importErrors, setImportErrors] = useState<ImportError[]>([]);
  const [missing, setMissing] = useState<MissingCard[] | null>(null);
  const [missingChoiceBoards, setMissingChoiceBoards] = useState<{ side: string; maybe: string } | null>(null);
  const [importStatus, setImportStatus] = useState("");
  const [isImporting, setIsImporting] = useState(false);

  // URL fetch state — a share link prefills name/format/commander + boards
  const [deckUrl, setDeckUrl] = useState("");
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  const [urlError, setUrlError] = useState("");

  // Moxfield account connection + deck auto-sync
  const [moxfieldUsername, setMoxfieldUsername] = useState<string | null>(null);
  const [connectInput, setConnectInput] = useState("");
  const [connectError, setConnectError] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSyncingMoxfield, setIsSyncingMoxfield] = useState(false);
  const [syncSummaryText, setSyncSummaryText] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/users/me/moxfield");
        if (res.ok) {
          const data = await res.json();
          setMoxfieldUsername(typeof data.moxfieldUsername === "string" ? data.moxfieldUsername : null);
        }
      } catch { /* connection status is best-effort */ }
    })();
  }, []);

  const connectMoxfield = async () => {
    setIsConnecting(true);
    setConnectError("");
    try {
      const res = await fetch("/api/users/me/moxfield", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moxfieldUsername: connectInput }),
      });
      const data = await res.json();
      if (!res.ok) {
        setConnectError(typeof data.error === "string" ? data.error : "Failed to connect");
        return;
      }
      setMoxfieldUsername(data.moxfieldUsername);
      setConnectInput("");
    } catch {
      setConnectError("Network error — try again");
    } finally {
      setIsConnecting(false);
    }
  };

  const disconnectMoxfield = async () => {
    setConnectError("");
    try {
      const res = await fetch("/api/users/me/moxfield", { method: "DELETE" });
      if (res.ok) setMoxfieldUsername(null);
    } catch { /* ignore */ }
  };

  const syncMoxfieldDecks = async () => {
    setIsSyncingMoxfield(true);
    setSyncSummaryText("");
    try {
      const res = await fetch("/api/decks/sync-moxfield", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setSyncSummaryText(typeof data.error === "string" ? data.error : "Sync failed");
        return;
      }
      const parts: string[] = [];
      if (data.imported?.length > 0) {
        parts.push(`Imported ${data.imported.length} deck${data.imported.length !== 1 ? "s" : ""}: ${data.imported.map((d: { name: string }) => d.name).join(", ")}`);
        const excluded = (data.imported as Array<{ name: string; excludedCards: string[] }>)
          .filter((d) => d.excludedCards.length > 0);
        if (excluded.length > 0) {
          parts.push(`${excluded.length} deck${excluded.length !== 1 ? "s" : ""} skipped cards not in your library (open the deck to see what's missing)`);
        }
        await loadDecks();
      } else {
        parts.push("No new public decks found");
      }
      if (data.skippedLinked?.length > 0) parts.push(`${data.skippedLinked.length} already imported`);
      if (data.skippedNameCollision?.length > 0) {
        parts.push(`${data.skippedNameCollision.length} skipped — you already have a deck with that name`);
      }
      if (data.failed?.length > 0) {
        parts.push(`${data.failed.length} failed: ${data.failed.map((f: { name: string; error: string }) => `${f.name} (${f.error})`).join("; ")}`);
      }
      setSyncSummaryText(parts.join(" · "));
    } catch {
      setSyncSummaryText("Network error — try again");
    } finally {
      setIsSyncingMoxfield(false);
    }
  };

  const fetchFromUrl = async () => {
    setIsFetchingUrl(true);
    setUrlError("");
    try {
      const res = await fetch("/api/decks/fetch-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: deckUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        setUrlError(typeof data.error === "string" ? data.error : "Failed to fetch deck");
        return;
      }
      const d = data.deck;
      setImportName(d.name ?? "");
      setImportFormat(d.format ?? "");
      setImportCommander(d.commander ?? "");
      setImportText(d.main ?? "");
      setMissing(null);
      setMissingChoiceBoards(
        d.side || d.maybe ? { side: d.side ?? "", maybe: d.maybe ?? "" } : null
      );
      setImportStatus(
        [d.side?.trim() ? "sideboard" : null, d.maybe?.trim() ? "maybeboard" : null].filter(Boolean).length > 0
          ? `Fetched “${d.name}” with ${[d.side?.trim() ? "sideboard" : null, d.maybe?.trim() ? "maybeboard" : null].filter(Boolean).join(" + ")} — they will import alongside the main deck.`
          : `Fetched “${d.name}” — review the list below and import.`
      );
    } finally {
      setIsFetchingUrl(false);
    }
  };

  const loadDecks = async () => {
    try {
      const res = await fetch("/api/decks");
      if (!res.ok) throw new Error("Failed to load decks");
      const data = await res.json();
      setDecks(Array.isArray(data.userDecks) ? data.userDecks : []);
      setIsLegacyAdmin(Boolean(data.isLegacyAdmin));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { loadDecks(); }, []);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setCreateError("");
    const res = await fetch("/api/decks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    const data = await res.json();
    if (!res.ok) {
      setCreateError(typeof data.error === "string" ? data.error : "Failed to create deck");
      return;
    }
    setNewName("");
    await loadDecks();
  };

  const dryRunBoard = async (text: string) => {
    const res = await fetch("/api/decks/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: importName || "dry-run", text, dryRun: true }),
    });
    return res.json();
  };

  const commitBoard = async (deckId: string | null, text: string, board: string | null, addMissing: boolean) => {
    const url = deckId ? `/api/decks/${deckId}/import` : "/api/decks/import";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(deckId
          ? { text, board, dryRun: false, addMissingToLibrary: addMissing }
          : {
              name: importName,
              text,
              dryRun: false,
              addMissingToLibrary: addMissing,
              ...(importFormat.trim() ? { format: importFormat.trim() } : {}),
              ...(importCommander.trim() ? { commander: importCommander.trim() } : {}),
            }),
      }),
    });
    return { res, data: await res.json() };
  };

  const runImport = async (body: Record<string, unknown>) => {
    setIsImporting(true);
    setImportStatus("");
    try {
      if (body.dryRun) {
        // Dry-run every non-empty board so the missing prompt covers all of them.
        const boards = [
          { key: "main", text: importText },
          ...(missingChoiceBoards?.side?.trim() ? [{ key: "side", text: missingChoiceBoards.side }] : []),
          ...(missingChoiceBoards?.maybe?.trim() ? [{ key: "maybe", text: missingChoiceBoards.maybe }] : []),
        ];
        const seen = new Map<string, MissingCard>();
        let errors: ImportError[] = [];
        for (const b of boards) {
          const data = await dryRunBoard(b.text);
          errors = errors.concat(Array.isArray(data.errors) ? data.errors : []);
          for (const m of data.missing ?? []) {
            const k = `${m.cardName.toLowerCase()}|${m.set}|${m.collectorNumber}`;
            if (!seen.has(k)) seen.set(k, m);
          }
        }
        setImportErrors(errors);
        const allMissing = Array.from(seen.values());
        if (allMissing.length > 0) {
          setMissing(allMissing); // show the yes/no prompt
        } else {
          // nothing missing — commit immediately
          await runImport({ dryRun: false, addMissingToLibrary: false });
        }
        return;
      }
      // ---- commit: main creates the deck, then side/maybe follow it ----
      const addMissing = body.addMissingToLibrary === true;
      const { res, data } = await commitBoard(null, importText, null, addMissing);
      if (!res.ok) {
        const detail = Array.isArray(data.cards) ? `: ${data.cards.join(", ")}` : "";
        setImportStatus(`${typeof data.error === "string" ? data.error : "Import failed"}${detail}`);
        return;
      }
      const deckId = data.deck?.id as string | undefined;
      const extra: string[] = [];
      if (deckId && missingChoiceBoards) {
        for (const [board, text] of [["side", missingChoiceBoards.side], ["maybe", missingChoiceBoards.maybe]] as const) {
          if (!text.trim()) continue;
          const r = await commitBoard(deckId, text, board, addMissing);
          if (!r.res.ok) {
            extra.push(`${board}: ${typeof r.data.error === "string" ? r.data.error : "failed"}`);
          }
        }
      }
      if (extra.length > 0) {
        setImportStatus(`Main deck imported, but ${extra.join("; ")} — add them from the deck page.`);
      }
      // committed
      resetImport();
      await loadDecks();
    } finally {
      setIsImporting(false);
    }
  };

  const resetImport = () => {
    setShowImport(false);
    setImportName("");
    setImportFormat("");
    setImportCommander("");
    setImportText("");
    setDeckUrl("");
    setUrlError("");
    setMissing(null);
    setMissingChoiceBoards(null);
    setImportErrors([]);
  };

  if (isLoading) return <div className="py-8 text-muted">Loading…</div>;

  return (
    <div className="py-8">
      <h1 className="text-3xl mb-2">My Decks</h1>
      <p className="text-muted mb-6">Create decks and fill them with cards from your library.</p>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 mb-6">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {isLegacyAdmin ? (
        <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted">
          The bootstrap admin has no library or decks — create your account via an invite first.
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-border bg-surface p-4 mb-8">
            {moxfieldUsername ? (
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="text-sm">
                  <span className="font-medium">Moxfield connected</span>{" "}
                  <span className="text-muted">as </span>
                  <a
                    href={`https://www.moxfield.com/users/${moxfieldUsername}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-accent hover:underline"
                  >
                    @{moxfieldUsername}
                  </a>
                  <span className="text-muted"> — public decks import automatically each night, or sync now.</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={syncMoxfieldDecks}
                    disabled={isSyncingMoxfield}
                    className="px-3 py-1.5 rounded-md bg-accent/10 text-accent text-sm font-medium hover:bg-accent/20 disabled:opacity-50 cursor-pointer"
                  >
                    {isSyncingMoxfield ? "Syncing…" : "Sync my decks"}
                  </button>
                  <button
                    onClick={disconnectMoxfield}
                    className="px-3 py-1.5 rounded-md border border-border text-sm text-muted hover:text-foreground hover:bg-surface-hover transition-colors cursor-pointer"
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="text-sm text-muted flex-1">
                  <span className="font-medium text-foreground">Connect your Moxfield account</span> — enter your
                  Moxfield username and your public decks import automatically each night.
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={connectInput}
                    onChange={(e) => setConnectInput(e.target.value)}
                    placeholder="Moxfield username"
                    maxLength={30}
                    className="w-44 px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                  />
                  <button
                    onClick={connectMoxfield}
                    disabled={isConnecting || connectInput.trim().length < 3}
                    className="px-4 py-2 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover disabled:opacity-50 cursor-pointer shrink-0"
                  >
                    {isConnecting ? "Checking…" : "Connect"}
                  </button>
                </div>
              </div>
            )}
            {connectError && <p className="text-sm text-red-400 mt-2">{connectError}</p>}
            {syncSummaryText && <p className="text-sm text-muted mt-2">{syncSummaryText}</p>}
          </div>

          <div className="flex flex-col sm:flex-row gap-3 mb-8">
            <form onSubmit={handleCreate} className="flex gap-2 flex-1">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New deck name"
                maxLength={100}
                className="flex-1 px-3 py-2 rounded-md border border-border bg-surface text-foreground"
              />
              <button
                type="submit"
                disabled={newName.trim().length === 0}
                className="px-4 py-2 rounded-md bg-accent text-white font-medium hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
              >
                Create
              </button>
            </form>
            <button
              onClick={() => setShowImport((v) => !v)}
              className="px-4 py-2 rounded-md border border-border text-foreground hover:bg-surface transition-colors cursor-pointer"
            >
              {showImport ? "Cancel import" : "Import from Moxfield"}
            </button>
          </div>
          {createError && <p className="text-sm text-red-400 -mt-6 mb-6">{createError}</p>}

          {showImport && (
            <div className="rounded-lg border border-border bg-surface p-4 mb-8 space-y-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={deckUrl}
                  onChange={(e) => setDeckUrl(e.target.value)}
                  placeholder="Or paste a Moxfield share link (moxfield.com/decks/…)"
                  className="flex-1 px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                />
                <button
                  onClick={fetchFromUrl}
                  disabled={isFetchingUrl || deckUrl.trim().length === 0}
                  className="px-4 py-2 rounded-md border border-border text-foreground text-sm font-medium hover:bg-surface-hover disabled:opacity-50 cursor-pointer shrink-0"
                >
                  {isFetchingUrl ? "Fetching…" : "Fetch"}
                </button>
              </div>
              {urlError && <p className="text-sm text-red-400">{urlError}</p>}
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={importName}
                  onChange={(e) => setImportName(e.target.value)}
                  placeholder="Deck name"
                  maxLength={100}
                  className="flex-1 px-3 py-2 rounded-md border border-border bg-background text-foreground"
                />
                <input
                  type="text"
                  value={importFormat}
                  onChange={(e) => setImportFormat(e.target.value)}
                  placeholder="Format (optional)"
                  maxLength={50}
                  className="sm:w-40 px-3 py-2 rounded-md border border-border bg-background text-foreground"
                />
                <input
                  type="text"
                  value={importCommander}
                  onChange={(e) => setImportCommander(e.target.value)}
                  placeholder="Commander (optional)"
                  maxLength={200}
                  className="flex-1 px-3 py-2 rounded-md border border-border bg-background text-foreground"
                />
              </div>
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={"1 Treasure Vault (AFR) 261 *F*\n1 Spikefield Hazard / Spikefield Cave (ZNR) 166 *F*\n1 Secluded Starforge (EOE) 257"}
                className="w-full h-48 p-3 rounded-md border border-border bg-background text-foreground font-mono text-sm"
              />
              {missing === null ? (
                <button
                  onClick={() => runImport({ dryRun: true })}
                  disabled={isImporting || importName.trim().length === 0 || importText.trim().length === 0}
                  className="px-4 py-2 rounded-md bg-accent text-white font-medium hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
                >
                  {isImporting ? "Checking…" : "Import"}
                </button>
              ) : (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
                  <p className="text-sm text-amber-400 font-medium">
                    {missing.length} card{missing.length !== 1 ? "s are" : " is"} not in your library:
                  </p>
                  <pre className="text-xs text-foreground/80 max-h-40 overflow-auto whitespace-pre-wrap">
                    {missing.map((m) => m.cardName).join("\n")}
                  </pre>
                  <p className="text-sm text-muted">Add them to your library?</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => runImport({ dryRun: false, addMissingToLibrary: true })}
                      disabled={isImporting}
                      className="px-3 py-1.5 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover disabled:opacity-50 cursor-pointer"
                    >
                      Yes — add to library
                    </button>
                    <button
                      onClick={() => runImport({ dryRun: false, addMissingToLibrary: false })}
                      disabled={isImporting}
                      className="px-3 py-1.5 rounded-md border border-border text-sm text-foreground hover:bg-surface-hover disabled:opacity-50 cursor-pointer"
                    >
                      No — import without them
                    </button>
                  </div>
                </div>
              )}
              {importStatus && <p className="text-sm text-red-400">{importStatus}</p>}
              {importErrors.length > 0 && (
                <div className="text-xs text-amber-400">
                  {importErrors.map((e) => (
                    <p key={e.line}>Line {e.line}: {e.reason} — &quot;{e.raw}&quot;</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {decks.length === 0 ? (
            <p className="text-muted text-sm">No decks yet — create one above or add one while logging a game.</p>
          ) : (
            <div className="space-y-2">
              {decks.map((deck) => (
                <Link
                  key={deck.id}
                  href={`/decks/${deck.id}`}
                  className="flex items-center justify-between rounded-lg border border-border px-4 py-3 hover:border-accent/40 hover:bg-surface transition-colors"
                >
                  <span className="font-semibold">{deck.name}</span>
                  <span className="text-xs text-muted bg-surface px-2 py-0.5 rounded-full">
                    {deck.cardCount} card{deck.cardCount !== 1 ? "s" : ""}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

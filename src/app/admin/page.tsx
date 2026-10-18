"use client";

import { useState, useEffect } from "react";
import InvitesSection from "./invites-section";
import DecksSection from "./decks-section";
import UnlinkedDecksSection from "./unlinked-decks-section";
import UnlinkedPlayersSection from "./unlinked-players-section";

function StatusDot({ status }: { status: "success" | "failure" | "unknown" }) {
  const color =
    status === "success"
      ? "bg-emerald-400"
      : status === "failure"
        ? "bg-red-400"
        : "bg-zinc-500";
  return <span className={`inline-block w-2 h-2 rounded-full ${color} flex-shrink-0`} />;
}

function relativeTime(date: Date | string): string {
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// No disabled stores: 401 Games was re-enabled with the fetch-based rewrite
const DISABLED_STORES = new Set<string>([]);

export default function AdminPage() {
  // Existing state for Update All Collections
  const [isUpdating, setIsUpdating] = useState(false);
  const [message, setMessage] = useState("");

  // User management state
  const [users, setUsers] = useState<Array<{ id: string; name: string; moxfieldCollectionId: string; moxfieldUsername: string | null }>>([]);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [addName, setAddName] = useState("");
  const [addCollectionId, setAddCollectionId] = useState("");
  const [addMoxfieldUsername, setAddMoxfieldUsername] = useState("");
  const [userMessage, setUserMessage] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  // Sync summary state (per-user last sync status dot)
  const [syncSummary, setSyncSummary] = useState<Record<string, { status: string; createdAt: string } | null>>({});

  // Inline collection ID edit state
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState("");

  // Inline Moxfield username edit state (drives nightly deck auto-sync)
  const [editingUsernameId, setEditingUsernameId] = useState<string | null>(null);
  const [usernameEditValue, setUsernameEditValue] = useState("");
  const [usernameEditError, setUsernameEditError] = useState("");

  // Expandable sync history state
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [syncLogs, setSyncLogs] = useState<Record<string, Array<{ id: string; status: string; errorMessage: string | null; source: string; createdAt: string }>>>({});

  // Per-user sync in-flight state
  const [syncingUsers, setSyncingUsers] = useState<Record<string, boolean>>({});

  // Scraper health state
  const [storeHealth, setStoreHealth] = useState<Record<string, { status: string; lastRun: string | null; error: string | null }>>({});
  const [scraperHealthWarning, setScraperHealthWarning] = useState("");
  const [expandedStore, setExpandedStore] = useState<string | null>(null);

  useEffect(() => {
    async function fetchScraperHealth() {
      try {
        setScraperHealthWarning("");
        const res = await fetch("/api/admin/scraper-health");
        if (!res.ok) {
          throw new Error(`Failed to fetch scraper health: ${res.status} ${res.statusText}`);
        }
        const data = await res.json();
        setStoreHealth(data);
      } catch (error) {
        console.error("Failed to load scraper health", error);
        setScraperHealthWarning("Unable to load scraper health data.");
      }
    }

    fetchUsers();
    fetchScraperHealth();
  }, []);

  async function fetchSyncSummary(userList: Array<{ id: string }>) {
    const summaries: Record<string, { status: string; createdAt: string } | null> = {};
    await Promise.all(
      userList.map(async (u) => {
        try {
          const res = await fetch(`/api/admin/users/${u.id}/sync-logs`);
          if (res.ok) {
            const logs = await res.json();
            summaries[u.id] = logs.length > 0 ? { status: logs[0].status, createdAt: logs[0].createdAt } : null;
          }
        } catch { /* ignore — summary is best-effort */ }
      })
    );
    setSyncSummary(summaries);
  }

  async function fetchUsers() {
    const res = await fetch("/api/admin/users");
    if (res.ok) {
      const data = await res.json();
      setUsers(data);
      fetchSyncSummary(data);
    }
  }

  async function handleDelete(userId: string) {
    if (deleteConfirm !== userId) {
      setDeleteConfirm(userId);
      return;
    }
    // Second click — fire delete
    setDeleteConfirm(null);
    const res = await fetch(`/api/admin/users/${userId}`, { method: "DELETE" });
    if (res.ok) {
      setUserMessage("User deleted successfully!");
      fetchUsers();
    } else {
      const data = await res.json();
      setUserMessage(`Error: ${data.error}`);
    }
  }

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    setIsAdding(true);
    setUserMessage("");
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: addName,
          moxfieldCollectionId: addCollectionId,
          ...(addMoxfieldUsername.trim() ? { moxfieldUsername: addMoxfieldUsername.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setUserMessage("User added successfully!");
        setAddName("");
        setAddCollectionId("");
        setAddMoxfieldUsername("");
        fetchUsers();
      } else {
        setUserMessage(`Error: ${data.error}`);
      }
    } catch (err) {
      setUserMessage(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setIsAdding(false);
    }
  }

  async function handleSaveCollectionId(userId: string) {
    const trimmed = editValue.trim();
    if (!trimmed) return;
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moxfieldCollectionId: trimmed }),
      });
      if (res.ok) {
        const updated = await res.json();
        setUsers(prev => prev.map(u => u.id === userId ? { ...u, moxfieldCollectionId: updated.moxfieldCollectionId } : u));
        setEditingUserId(null);
        setEditError("");
      } else {
        const data = await res.json();
        setEditError(data.error || "Failed to save");
      }
    } catch {
      setEditError("Network error");
    }
  }

  async function handleSaveUsername(userId: string) {
    const trimmed = usernameEditValue.trim();
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(trimmed ? { moxfieldUsername: trimmed } : { moxfieldUsername: null }),
      });
      if (res.ok) {
        const updated = await res.json();
        setUsers(prev => prev.map(u => u.id === userId ? { ...u, moxfieldUsername: updated.moxfieldUsername } : u));
        setEditingUsernameId(null);
        setUsernameEditError("");
      } else {
        const data = await res.json();
        setUsernameEditError(data.error || "Failed to save");
      }
    } catch {
      setUsernameEditError("Network error");
    }
  }

  async function handleToggleExpand(userId: string) {
    if (expandedUserId === userId) {
      setExpandedUserId(null);
      return;
    }
    setExpandedUserId(userId);
    if (!syncLogs[userId]) {
      try {
        const res = await fetch(`/api/admin/users/${userId}/sync-logs`);
        if (res.ok) {
          const logs = await res.json();
          setSyncLogs(prev => ({ ...prev, [userId]: logs }));
        }
      } catch { /* ignore */ }
    }
  }

  async function handleSyncUser(userId: string) {
    setSyncingUsers(prev => ({ ...prev, [userId]: true }));
    try {
      await fetch(`/api/admin/users/${userId}/sync`, { method: "POST" });
    } finally {
      setSyncingUsers(prev => ({ ...prev, [userId]: false }));
      // Refresh the status dot for this user only
      fetchSyncSummary([{ id: userId }]);
      // Invalidate cached sync logs so next expand re-fetches fresh data
      setSyncLogs(prev => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
    }
  }

  const handleUpdate = async () => {
    setIsUpdating(true);
    setMessage("Updating collections...");

    try {
      const response = await fetch("/api/admin/updateCollections", {
        method: "POST",
      });

      if (!response.ok) {
        const text = await response.text();
        try {
          const data = JSON.parse(text);
          setMessage(`Error: ${data.error || data.message || "Sync failed"}`);
        } catch {
          setMessage(`Error: ${response.status === 504 ? "Sync timed out — try again or check Vercel logs" : `HTTP ${response.status}`}`);
        }
        return;
      }

      const data = await response.json();
      setMessage(data.success ? "Collections updated successfully!" : `Sync completed with errors: ${data.message}`);
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto py-8" onClick={() => setDeleteConfirm(null)}>
      <h1 className="text-3xl mb-8">Admin Panel</h1>

      {/* Users section */}
      <div className="rounded-lg border border-border bg-surface p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">Users</h2>
        {users.length === 0 ? (
          <p className="text-muted text-sm">No users found.</p>
        ) : (
          <div className="space-y-2">
            {users.map((user) => (
              <div
                key={user.id}
                className="flex flex-col gap-2 p-3 rounded-lg bg-background border border-border cursor-pointer"
                onClick={() => handleToggleExpand(user.id)}
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <span className="font-medium">{user.name}</span>
                    {editingUserId === user.id ? (
                      <span className="block sm:inline sm:ml-2">
                        <input
                          autoFocus
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); handleSaveCollectionId(user.id); }
                            if (e.key === "Escape") { setEditingUserId(null); setEditError(""); }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="font-mono text-sm px-1 py-0.5 rounded border border-accent bg-background text-foreground focus:outline-none w-48"
                        />
                        {editError && <span className="text-xs text-red-400 ml-1">{editError}</span>}
                      </span>
                    ) : (
                      <span
                        className="block sm:inline text-sm text-muted sm:ml-2 font-mono truncate cursor-pointer hover:text-foreground transition-colors"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingUserId(user.id);
                          setEditValue(user.moxfieldCollectionId);
                          setEditError("");
                        }}
                        title="Click to edit"
                      >
                        {user.moxfieldCollectionId}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0">
                    {editingUsernameId === user.id ? (
                      <span className="inline-flex items-center gap-1">
                        <input
                          autoFocus
                          value={usernameEditValue}
                          onChange={(e) => setUsernameEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); handleSaveUsername(user.id); }
                            if (e.key === "Escape") { setEditingUsernameId(null); setUsernameEditError(""); }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          placeholder="username"
                          maxLength={30}
                          className="font-mono text-sm px-1 py-0.5 rounded border border-accent bg-background text-foreground focus:outline-none w-40"
                        />
                        <button
                          onClick={(e) => { e.stopPropagation(); handleSaveUsername(user.id); }}
                          className="text-xs px-2 py-0.5 rounded bg-accent/10 text-accent hover:bg-accent/20 cursor-pointer"
                        >
                          Save
                        </button>
                        {usernameEditError && <span className="text-xs text-red-400">{usernameEditError}</span>}
                      </span>
                    ) : (
                      <span
                        className={`inline-block text-sm sm:ml-2 truncate cursor-pointer hover:text-foreground transition-colors ${
                          user.moxfieldUsername ? "text-accent/80" : "text-muted/60"
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingUsernameId(user.id);
                          setUsernameEditValue(user.moxfieldUsername ?? "");
                          setUsernameEditError("");
                        }}
                        title="Moxfield account — click to edit. Enables nightly public-deck auto-sync."
                      >
                        {user.moxfieldUsername ? `@${user.moxfieldUsername}` : "+ Moxfield username"}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5 text-xs text-muted">
                      <StatusDot status={(syncSummary[user.id]?.status as "success" | "failure") ?? "unknown"} />
                      <span>{syncSummary[user.id] ? relativeTime(syncSummary[user.id]!.createdAt) : "no syncs"}</span>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSyncUser(user.id);
                      }}
                      disabled={syncingUsers[user.id] ?? false}
                      className="flex-shrink-0 px-3 py-1.5 text-sm font-medium rounded-md transition-colors cursor-pointer bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {syncingUsers[user.id] ? "Syncing..." : "Sync"}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(user.id);
                      }}
                      className={`self-end sm:self-auto flex-shrink-0 px-3 py-1.5 text-sm font-medium rounded-md transition-colors cursor-pointer ${
                        deleteConfirm === user.id
                          ? "bg-destructive text-white"
                          : "bg-destructive/10 text-red-400 hover:bg-destructive/20"
                      }`}
                    >
                      {deleteConfirm === user.id ? "Confirm?" : "Delete"}
                    </button>
                  </div>
                </div>
                {expandedUserId === user.id && (
                  <div className="mt-2 border-t border-border pt-2 space-y-1">
                    {(!syncLogs[user.id] || syncLogs[user.id].length === 0) ? (
                      <p className="text-xs text-muted">No sync history</p>
                    ) : (
                      syncLogs[user.id].map((log) => (
                        <div key={log.id} className="flex items-center gap-2 text-xs">
                          <StatusDot status={log.status as "success" | "failure" | "unknown"} />
                          <span className="text-muted">{relativeTime(log.createdAt)}</span>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${log.source === "manual" ? "bg-blue-500/20 text-blue-300" : "bg-zinc-500/20 text-zinc-400"}`}>
                            {log.source}
                          </span>
                          {log.errorMessage && (
                            <span className="text-red-400 truncate" title={log.errorMessage}>
                              {log.errorMessage.slice(0, 60)}{log.errorMessage.length > 60 ? "..." : ""}
                            </span>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add User form */}
      <div className="rounded-lg border border-border bg-surface p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">Add User</h2>
        <form onSubmit={handleAddUser} className="space-y-3">
          <input
            type="text"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            placeholder="Name"
            required
            className="block w-full px-3 py-2.5 rounded-lg border border-border bg-background text-foreground placeholder:text-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-colors"
          />
          <input
            type="text"
            value={addCollectionId}
            onChange={(e) => setAddCollectionId(e.target.value)}
            placeholder="Moxfield Collection ID"
            required
            className="block w-full px-3 py-2.5 rounded-lg border border-border bg-background text-foreground placeholder:text-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-colors"
          />
          <input
            type="text"
            value={addMoxfieldUsername}
            onChange={(e) => setAddMoxfieldUsername(e.target.value)}
            placeholder="Moxfield username (optional — enables public-deck auto-sync)"
            maxLength={30}
            className="block w-full px-3 py-2.5 rounded-lg border border-border bg-background text-foreground placeholder:text-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-colors"
          />
          <button
            type="submit"
            disabled={isAdding || !addName.trim() || !addCollectionId.trim()}
            className="px-5 py-2.5 bg-accent text-white rounded-lg font-medium hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {isAdding ? "Adding..." : "Add User"}
          </button>
        </form>

        {userMessage && (
          <p className={`mt-4 text-sm font-medium ${userMessage.startsWith("Error") ? "text-red-400" : "text-emerald-400"}`}>
            {userMessage}
          </p>
        )}
      </div>

      {/* Invites section */}
      <InvitesSection />

      {/* Decks section */}
      <DecksSection />

      {/* Unlinked game decks */}
      <UnlinkedDecksSection />

      {/* Unregistered players */}
      <UnlinkedPlayersSection />

      {/* Update All Collections section */}
      <div className="rounded-lg border border-border bg-surface p-6">
        <h2 className="text-lg font-semibold mb-4">Sync Collections</h2>
        <p className="text-sm text-muted mb-4">Re-scrape all Moxfield collections and update the database.</p>
        <button
          onClick={handleUpdate}
          disabled={isUpdating}
          className="px-5 py-2.5 bg-accent text-white rounded-lg font-medium hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {isUpdating ? "Updating..." : "Update All Collections"}
        </button>

        {message && (
          <p className={`mt-4 text-sm font-medium ${message.startsWith("Error") ? "text-red-400" : "text-emerald-400"}`}>
            {message}
          </p>
        )}
      </div>

      {/* Scraper Health section */}
      <div className="rounded-lg border border-border bg-surface p-6 mt-6">
        <h2 className="text-lg font-semibold mb-4">Scraper Health</h2>
        <p className="text-xs text-muted mb-3">Status resets on cold start. Updated when users search for cards.</p>
        <div className="space-y-1">
          {Object.entries(storeHealth).length === 0 ? (
            <p className="text-sm text-muted">No scraper data available.</p>
          ) : (
            Object.entries(storeHealth).map(([name, health]) => {
              const isDisabled = DISABLED_STORES.has(name);
              const displayStatus = isDisabled ? "unknown" : (health.status as "success" | "failure" | "unknown");
              const isFailed = !isDisabled && health.status === "failure";
              return (
                <div key={name}>
                  <div
                    className={`flex items-center gap-2 p-2 rounded ${isFailed ? "cursor-pointer hover:bg-background" : ""}`}
                    onClick={() => isFailed && setExpandedStore((prev) => (prev === name ? null : name))}
                  >
                    <StatusDot status={displayStatus} />
                    <span className={`text-sm ${isDisabled ? "text-muted line-through" : "text-foreground"}`}>{name}</span>
                    {isDisabled && <span className="text-xs text-muted">(disabled)</span>}
                    {health.lastRun && !isDisabled && (
                      <span className="text-xs text-muted ml-auto">{relativeTime(health.lastRun)}</span>
                    )}
                    {isFailed && (
                      <span className="text-xs text-muted ml-auto">{expandedStore === name ? "▲" : "▼"}</span>
                    )}
                  </div>
                  {expandedStore === name && isFailed && health.error && (
                    <div className="ml-6 p-2 text-xs text-red-400 bg-red-500/5 rounded">
                      {health.error.slice(0, 200)}{health.error.length > 200 ? "..." : ""}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

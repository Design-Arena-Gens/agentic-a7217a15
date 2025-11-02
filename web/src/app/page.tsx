'use client';

import { useEffect, useMemo, useState } from "react";
import {
  decryptText,
  encryptText,
  generateAesKey,
  importAesKey,
} from "@/lib/crypto";

type Profile = {
  id: string;
  name: string;
  remember: boolean;
};

type EncryptedPost = {
  id: string;
  authorId: string;
  authorName: string;
  ciphertext: string;
  iv: string;
  createdAt: number;
};

type PersistedSpace = {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  ownerId: string;
  secret: string;
  posts: EncryptedPost[];
};

type VisiblePost = EncryptedPost & {
  content: string;
  failed?: boolean;
};

const PROFILE_STORAGE_KEY = "ciphermesh/profile";
const SPACE_STORAGE_KEY = "ciphermesh/spaces";

export default function Home() {
  const [hydrated, setHydrated] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileDraft, setProfileDraft] = useState("");
  const [rememberProfile, setRememberProfile] = useState(true);

  const [spaces, setSpaces] = useState<Record<string, PersistedSpace>>({});
  const [keys, setKeys] = useState<Record<string, CryptoKey>>({});
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [visiblePosts, setVisiblePosts] = useState<VisiblePost[]>([]);

  const [createState, setCreateState] = useState({
    name: "",
    description: "",
    busy: false,
    error: "",
  });

  const [joinState, setJoinState] = useState({
    code: "",
    busy: false,
    error: "",
  });

  const [composer, setComposer] = useState({
    value: "",
    busy: false,
    error: "",
  });

  const activeSpace = useMemo(() => {
    if (!activeSpaceId) return null;
    return spaces[activeSpaceId] ?? null;
  }, [activeSpaceId, spaces]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let cancelled = false;

    const initialize = async () => {
      try {
        const storedProfile = window.localStorage.getItem(PROFILE_STORAGE_KEY);
        if (storedProfile) {
          const parsed = JSON.parse(storedProfile) as Profile;
          if (!cancelled) {
            setProfile(parsed);
            setProfileDraft(parsed.name);
            setRememberProfile(true);
          }
        }
      } catch (error) {
        console.error("Failed to read profile", error);
      }

      try {
        const rawSpaces = window.localStorage.getItem(SPACE_STORAGE_KEY);
        if (rawSpaces) {
          const parsed = JSON.parse(rawSpaces) as PersistedSpace[];
          const nextSpaces: Record<string, PersistedSpace> = {};
          const entries = await Promise.all(
            parsed.map(async (space) => {
              nextSpaces[space.id] = {
                ...space,
                posts: space.posts ?? [],
              };
              try {
                const key = await importAesKey(space.secret);
                return [space.id, key] as const;
              } catch (error) {
                console.warn("Unable to import key for space", space.id, error);
                return null;
              }
            }),
          );

          const filtered = entries.filter(Boolean) as [string, CryptoKey][];

          if (!cancelled) {
            setSpaces(nextSpaces);
            setKeys(Object.fromEntries(filtered));
            if (parsed.length) {
              setActiveSpaceId(parsed[0].id);
            }
          }
        }
      } catch (error) {
        console.error("Failed to read spaces", error);
      }

      if (!cancelled) {
        setHydrated(true);
      }
    };

    void initialize();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !hydrated) {
      return;
    }

    if (profile && profile.remember) {
      window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
    } else {
      window.localStorage.removeItem(PROFILE_STORAGE_KEY);
    }
  }, [profile, hydrated]);

  useEffect(() => {
    if (typeof window === "undefined" || !hydrated) {
      return;
    }

    const serialized = JSON.stringify(Object.values(spaces));
    window.localStorage.setItem(SPACE_STORAGE_KEY, serialized);
  }, [spaces, hydrated]);

  useEffect(() => {
    let cancelled = false;

    const syncPosts = async () => {
      if (!activeSpaceId) {
        if (!cancelled) {
          setVisiblePosts([]);
        }
        return;
      }

      const space = spaces[activeSpaceId];
      const key = keys[activeSpaceId];

      if (!space || !key) {
        if (!cancelled) {
          setVisiblePosts([]);
        }
        return;
      }

      const list = await Promise.all(
        space.posts.map(async (post) => {
          try {
            const content = await decryptText(key, post.ciphertext, post.iv);
            return { ...post, content } satisfies VisiblePost;
          } catch (error) {
            console.warn("Failed to decrypt post", post.id, error);
            return {
              ...post,
              content: "Unable to decrypt message",
              failed: true,
            } satisfies VisiblePost;
          }
        }),
      );

      list.sort((a, b) => b.createdAt - a.createdAt);

      if (!cancelled) {
        setVisiblePosts(list);
      }
    };

    void syncPosts();

    return () => {
      cancelled = true;
    };
  }, [activeSpaceId, spaces, keys]);

  const handleProfileSave = () => {
    if (!profileDraft.trim()) {
      return;
    }

    const nextProfile: Profile = {
      id: profile?.id ?? crypto.randomUUID(),
      name: profileDraft.trim(),
      remember: rememberProfile,
    };
    setProfile(nextProfile);
  };

  const handleCreateSpace = async () => {
    if (!createState.name.trim()) {
      setCreateState((prev) => ({
        ...prev,
        error: "Choose a name to create a space.",
      }));
      return;
    }

    setCreateState((prev) => ({ ...prev, busy: true, error: "" }));

    try {
      const { key, secret } = await generateAesKey();
      const id = crypto.randomUUID();
      const space: PersistedSpace = {
        id,
        name: createState.name.trim(),
        description: createState.description.trim() || undefined,
        createdAt: Date.now(),
        ownerId: profile?.id ?? "anonymous",
        secret,
        posts: [],
      };

      setSpaces((prev) => ({
        ...prev,
        [space.id]: space,
      }));

      setKeys((prev) => ({
        ...prev,
        [space.id]: key,
      }));

      setActiveSpaceId(space.id);
      setCreateState({
        name: "",
        description: "",
        busy: false,
        error: "",
      });
    } catch (error) {
      console.error(error);
      setCreateState((prev) => ({
        ...prev,
        busy: false,
        error: "We could not generate a new space. Try again.",
      }));
    }
  };

  const handleJoinSpace = async () => {
    if (!joinState.code.trim()) {
      setJoinState((prev) => ({
        ...prev,
        error: "Paste the invite code to continue.",
      }));
      return;
    }

    setJoinState((prev) => ({ ...prev, busy: true, error: "" }));

    try {
      const normalized = joinState.code.trim();
      const [spacePart, secretPart] = normalized.includes(":")
        ? normalized.split(":")
        : normalized.split(".");

      if (!spacePart || !secretPart) {
        throw new Error("Invalid invite code");
      }

      const key = await importAesKey(secretPart);
      const existing = spaces[spacePart];
      const draftSpace: PersistedSpace =
        existing ?? {
          id: spacePart,
          name: `Joined Space ${spacePart.slice(0, 4)}`,
          createdAt: Date.now(),
          ownerId: "external",
          secret: secretPart,
          posts: [],
        };

      draftSpace.secret = secretPart;

      setSpaces((prev) => ({
        ...prev,
        [draftSpace.id]: draftSpace,
      }));

      setKeys((prev) => ({
        ...prev,
        [draftSpace.id]: key,
      }));

      setActiveSpaceId(draftSpace.id);
      setJoinState({ code: "", busy: false, error: "" });
    } catch (error) {
      console.error(error);
      setJoinState((prev) => ({
        ...prev,
        busy: false,
        error: "That invite could not be verified. Check the code and retry.",
      }));
    }
  };

  const handleCreatePost = async () => {
    if (!activeSpaceId) {
      setComposer((prev) => ({
        ...prev,
        error: "Select a space before posting.",
      }));
      return;
    }

    if (!profile) {
      setComposer((prev) => ({
        ...prev,
        error: "Set your profile and display name before posting.",
      }));
      return;
    }

    const message = composer.value.trim();
    if (!message) {
      setComposer((prev) => ({ ...prev, error: "Write something first." }));
      return;
    }

    const key = keys[activeSpaceId];
    if (!key) {
      setComposer((prev) => ({
        ...prev,
        error: "Missing space key. Try re-joining the space.",
      }));
      return;
    }

    setComposer((prev) => ({ ...prev, busy: true, error: "" }));

    try {
      const { ciphertext, iv } = await encryptText(key, message);
      const post: EncryptedPost = {
        id: crypto.randomUUID(),
        authorId: profile.id,
        authorName: profile.name,
        ciphertext,
        iv,
        createdAt: Date.now(),
      };

      setSpaces((prev) => {
        const next = { ...prev };
        const space = next[activeSpaceId];
        if (!space) return prev;
        next[activeSpaceId] = {
          ...space,
          posts: [...space.posts, post],
        };
        return next;
      });

      setComposer({ value: "", busy: false, error: "" });
    } catch (error) {
      console.error(error);
      setComposer((prev) => ({
        ...prev,
        busy: false,
        error: "We could not encrypt that message. Try again.",
      }));
    }
  };

  const handleCopy = async (value: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
    } catch (error) {
      console.error("Clipboard write failed", error);
    }
  };

  const handleExportSnapshot = () => {
    if (!activeSpace) return;
    const payload = JSON.stringify({
      meta: {
        id: activeSpace.id,
        name: activeSpace.name,
        description: activeSpace.description,
      },
      posts: activeSpace.posts,
    });
    const encoded = btoa(payload);
    void handleCopy(encoded);
  };

  const handleImportSnapshot = (encoded: string) => {
    if (!activeSpaceId) {
      return;
    }

    try {
      const payload = JSON.parse(atob(encoded));
      if (!payload || !Array.isArray(payload.posts)) {
        throw new Error("Invalid snapshot");
      }
      setSpaces((prev) => {
        const next = { ...prev };
        const target = next[activeSpaceId];
        if (!target) return prev;

        const existingIds = new Set(target.posts.map((post) => post.id));
        const merged = [...target.posts];

        for (const item of payload.posts as EncryptedPost[]) {
          if (!existingIds.has(item.id)) {
            merged.push(item);
          }
        }

        next[activeSpaceId] = {
          ...target,
          posts: merged,
        };

        return next;
      });
    } catch (error) {
      console.error("Snapshot import failed", error);
    }
  };

  const shareCode = useMemo(() => {
    if (!activeSpace) return "";
    return `${activeSpace.id}:${activeSpace.secret}`;
  }, [activeSpace]);

  const shareUrl = useMemo(() => {
    if (typeof window === "undefined" || !shareCode) return "";
    const url = new URL(window.location.href);
    url.searchParams.set("space", shareCode);
    return url.toString();
  }, [shareCode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const paramSpace = params.get("space");
    if (!paramSpace) return;
    setJoinState((prev) => ({
      ...prev,
      code: paramSpace,
    }));
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-3 py-6 md:flex-row md:gap-6 md:px-8">
        <aside className="flex w-full flex-none flex-col gap-6 rounded-3xl border border-white/10 bg-slate-900/50 p-6 backdrop-blur md:max-w-xs">
          <div>
            <h1 className="text-xl font-semibold text-white">CipherMesh</h1>
            <p className="mt-1 text-sm text-slate-400">
              A private social feed secured with end-to-end encryption.
            </p>
          </div>

          <section className="rounded-2xl border border-white/5 bg-slate-900/70 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
              Your identity
            </h2>

            {profile ? (
              <div className="mt-3 space-y-3">
                <div>
                  <p className="text-base font-medium text-white">{profile.name}</p>
                  <p className="text-xs text-slate-400">Local user id {profile.id.slice(0, 8)}</p>
                </div>
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={profile.remember}
                    onChange={(event) =>
                      setProfile((prev) =>
                        prev ? { ...prev, remember: event.target.checked } : prev,
                      )
                    }
                    className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-slate-200 focus:ring-emerald-500"
                  />
                  Remember on this device
                </label>
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                <input
                  value={profileDraft}
                  onChange={(event) => setProfileDraft(event.target.value)}
                  placeholder="Display name"
                  className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
                />
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={rememberProfile}
                    onChange={(event) => setRememberProfile(event.target.checked)}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-slate-200 focus:ring-emerald-500"
                  />
                  Remember on this device
                </label>
                <button
                  type="button"
                  onClick={handleProfileSave}
                  className="w-full rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-300"
                >
                  Save profile
                </button>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-white/5 bg-slate-900/70 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
              Create a space
            </h2>

            <div className="mt-3 space-y-3">
              <input
                value={createState.name}
                onChange={(event) =>
                  setCreateState((prev) => ({ ...prev, name: event.target.value }))
                }
                placeholder="Space name"
                className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
              />
              <textarea
                value={createState.description}
                onChange={(event) =>
                  setCreateState((prev) => ({ ...prev, description: event.target.value }))
                }
                placeholder="Short description (optional)"
                rows={2}
                className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
              />
              {createState.error ? (
                <p className="text-xs text-rose-400">{createState.error}</p>
              ) : null}
              <button
                type="button"
                onClick={handleCreateSpace}
                disabled={createState.busy}
                className="w-full rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {createState.busy ? "Creating…" : "Create secure space"}
              </button>
            </div>
          </section>

          <section className="rounded-2xl border border-white/5 bg-slate-900/70 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
              Join a space
            </h2>

            <div className="mt-3 space-y-3">
              <input
                value={joinState.code}
                onChange={(event) =>
                  setJoinState((prev) => ({ ...prev, code: event.target.value }))
                }
                placeholder="Invite code (spaceId:secret)"
                className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
              />
              {joinState.error ? <p className="text-xs text-rose-400">{joinState.error}</p> : null}
              <button
                type="button"
                onClick={handleJoinSpace}
                disabled={joinState.busy}
                className="w-full rounded-xl border border-emerald-500/60 px-4 py-2 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {joinState.busy ? "Verifying…" : "Join securely"}
              </button>
            </div>
          </section>

          <section className="rounded-2xl border border-white/5 bg-slate-900/70 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
              Spaces
            </h2>
            <div className="mt-3 space-y-2">
              {Object.values(spaces).length === 0 ? (
                <p className="text-xs text-slate-500">
                  Create or join a space to start sharing encrypted posts.
                </p>
              ) : (
                Object.values(spaces)
                  .sort((a, b) => b.createdAt - a.createdAt)
                  .map((space) => (
                    <button
                      key={space.id}
                      onClick={() => setActiveSpaceId(space.id)}
                      className={`w-full rounded-xl border px-3 py-2 text-left text-sm transition ${
                        activeSpaceId === space.id
                          ? "border-emerald-500 bg-emerald-500/10 text-emerald-100"
                          : "border-white/10 bg-slate-950/50 text-slate-200 hover:border-emerald-500/60 hover:text-emerald-100"
                      }`}
                    >
                      <p className="font-medium">{space.name}</p>
                      <p className="text-xs text-slate-400">{space.id.slice(0, 8)}…</p>
                    </button>
                  ))
              )}
            </div>
          </section>
        </aside>

        <main className="mt-6 flex w-full flex-1 flex-col gap-6 md:mt-0">
          {!activeSpace ? (
            <div className="flex flex-1 flex-col items-center justify-center rounded-3xl border border-dashed border-white/10 bg-slate-900/40 text-center">
              <div className="max-w-md space-y-4 px-6 py-12">
                <h2 className="text-3xl font-semibold text-white">Encrypted by design</h2>
                <p className="text-sm text-slate-400">
                  Create a secure space and invite trusted friends with a single secret link.
                  Posts are encrypted in your browser before they ever touch storage.
                </p>
                <p className="text-sm text-slate-500">
                  Generate an invite, share it out-of-band, and optionally export encrypted
                  snapshots to keep everyone in sync.
                </p>
              </div>
            </div>
          ) : (
            <>
              <section className="rounded-3xl border border-white/10 bg-slate-900/60 p-6">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div>
                    <h2 className="text-2xl font-semibold text-white">{activeSpace.name}</h2>
                    {activeSpace.description ? (
                      <p className="mt-1 text-sm text-slate-400">{activeSpace.description}</p>
                    ) : null}
                    <p className="mt-2 text-xs uppercase tracking-wide text-emerald-300">
                      Secure feed · {visiblePosts.length} posts
                    </p>
                  </div>
                  <div className="flex flex-col gap-2 text-xs text-slate-300 md:text-right">
                    <div className="flex items-center gap-2 md:justify-end">
                      <span className="rounded-lg bg-emerald-500/10 px-2 py-1 text-emerald-200">
                        Invite code
                      </span>
                      <code className="rounded-lg border border-emerald-500/40 bg-slate-950/60 px-2 py-1">
                        {shareCode}
                      </code>
                      <button
                        type="button"
                        onClick={() => handleCopy(shareCode)}
                        className="rounded-lg border border-emerald-500/40 px-2 py-1 text-emerald-200 hover:bg-emerald-500/10"
                      >
                        Copy
                      </button>
                    </div>
                    {shareUrl ? (
                      <div className="flex items-center gap-2 md:justify-end">
                        <span className="rounded-lg bg-emerald-500/10 px-2 py-1 text-emerald-200">
                          Direct link
                        </span>
                        <button
                          type="button"
                          onClick={() => handleCopy(shareUrl)}
                          className="rounded-lg border border-white/10 px-2 py-1 hover:border-emerald-500/40 hover:text-emerald-200"
                        >
                          Copy link
                        </button>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2 md:justify-end">
                      <button
                        type="button"
                        onClick={handleExportSnapshot}
                        className="rounded-lg border border-white/10 px-2 py-1 hover:border-emerald-500/40 hover:text-emerald-200"
                      >
                        Copy encrypted snapshot
                      </button>
                      <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-white/10 px-2 py-1 text-left hover:border-emerald-500/40 hover:text-emerald-200">
                        <span>Import snapshot</span>
                        <input
                          type="file"
                          accept="text/plain"
                          className="hidden"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (!file) return;
                            file.text().then((value) => handleImportSnapshot(value.trim()));
                            event.target.value = "";
                          }}
                        />
                      </label>
                    </div>
                  </div>
                </div>
              </section>

              <section className="rounded-3xl border border-white/10 bg-slate-900/70 p-6">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                  Compose
                </h3>
                <textarea
                  value={composer.value}
                  onChange={(event) =>
                    setComposer((prev) => ({ ...prev, value: event.target.value }))
                  }
                  placeholder="Share your thoughts securely…"
                  rows={4}
                  className="mt-3 w-full rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
                />
                {composer.error ? (
                  <p className="mt-2 text-xs text-rose-400">{composer.error}</p>
                ) : null}
                <div className="mt-3 flex items-center justify-between">
                  <p className="text-xs text-slate-500">
                    Messages are encrypted locally with AES-256 before leaving your browser.
                  </p>
                  <button
                    type="button"
                    onClick={handleCreatePost}
                    disabled={composer.busy}
                    className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {composer.busy ? "Encrypting…" : "Post securely"}
                  </button>
                </div>
              </section>

              <section className="flex-1 rounded-3xl border border-white/10 bg-slate-900/70 p-6">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                  Encrypted timeline
                </h3>
                <div className="mt-4 space-y-4">
                  {visiblePosts.length === 0 ? (
                    <p className="rounded-2xl border border-dashed border-white/10 bg-slate-950/40 p-6 text-center text-sm text-slate-500">
                      No posts yet. Break the silence with a secure update.
                    </p>
                  ) : (
                    visiblePosts.map((post) => (
                      <article
                        key={post.id}
                        className="rounded-2xl border border-white/10 bg-slate-950/60 p-5"
                      >
                        <header className="flex items-center justify-between text-sm text-slate-400">
                          <span className="font-medium text-emerald-200">
                            {post.authorName}
                          </span>
                          <span>
                            {new Intl.DateTimeFormat("en", {
                              hour: "numeric",
                              minute: "2-digit",
                              month: "short",
                              day: "numeric",
                            }).format(post.createdAt)}
                          </span>
                        </header>
                        <p
                          className={`mt-4 whitespace-pre-wrap text-base ${
                            post.failed ? "text-rose-300" : "text-slate-100"
                          }`}
                        >
                          {post.content}
                        </p>
                        <footer className="mt-4 space-y-2 text-xs text-slate-500">
                          <p>Encrypted payload: {post.ciphertext.slice(0, 32)}…</p>
                          <p>IV: {post.iv}</p>
                        </footer>
                      </article>
                    ))
                  )}
                </div>
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}


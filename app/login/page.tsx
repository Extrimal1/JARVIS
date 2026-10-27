"use client";

import { Suspense, useEffect, useState } from "react";
import { Command, LogIn } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";

/** Email+password login (cloud mode only; unused in local mode). */

export default function LoginPage() { 
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-[#080b12] text-sm text-slate-500">
          Sitzung wird geprüft …
        </main>
      }
    >
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth/session")
      .then((res) => {
        if (!cancelled && res.ok) {
          router.replace(next.startsWith("/") ? next : "/");
        }
      })
      .catch(() => {
        // Stay on the login page when the check itself fails.
      })
      .finally(() => {
        if (!cancelled) {
          setChecking(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [router, next]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    if (busy) return;

    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const parsed: unknown = await res.json().catch(() => null);

      if (!res.ok) {
        const message =
          typeof parsed === "object" &&
          parsed !== null &&
          "error" in parsed &&
          typeof (parsed as { error: { message?: unknown } }).error.message ===
            "string"
            ? (parsed as { error: { message: string } }).error.message
            : "Anmeldung fehlgeschlagen.";
        setError(message);
        return;
      }

      router.replace(next.startsWith("/") ? next : "/");
    } catch {
      setError("Keine Verbindung zum Server.");
    } finally {
      setBusy(false);
    }
  }

  if (checking) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#080b12] text-sm text-slate-500">
        Sitzung wird geprüft …
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#080b12] px-5 text-slate-100">
      <div className="w-full max-w-sm rounded-3xl border border-white/[0.08] bg-[#0d111b] p-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-400/30 bg-cyan-400/10 text-cyan-300">
            <Command size={22} />
          </div>
          <div>
            <div className="font-semibold tracking-[0.18em]">J.A.R.V.I.S.</div>
            <div className="text-[10px] tracking-[0.22em] text-slate-500">
              ANMELDUNG
            </div>
          </div>
        </div>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <label className="block text-xs text-slate-400">
            E-Mail
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="email"
              className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
            />
          </label>

          <label className="block text-xs text-slate-400">
            Passwort
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete="current-password"
              className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
            />
          </label>

          {error !== null && (
            <p role="alert" className="text-xs text-rose-300">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-300 px-4 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <LogIn size={16} />
            {busy ? "Wird angemeldet …" : "Anmelden"}
          </button>
        </form>

        <p className="mt-5 text-xs leading-5 text-slate-600">
          Das Konto wird einmalig in Supabase angelegt (siehe docs/SETUP.md).
          Es gibt keine öffentliche Registrierung.
        </p>
      </div>
    </main>
  );
}

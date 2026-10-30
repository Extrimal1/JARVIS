"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CLOUD_ENABLED } from "@/src/lib/db/mode";
import {
  Activity,
  BookOpen,
  Brain,
  CalendarDays,
  Command,
  Compass,
  LogOut,
  Menu,
  Mic,
  Sparkles,
  Wallet,
  X,
} from "lucide-react";
import { useLockBodyScroll } from "@/src/hooks/useLockBodyScroll";

const links = [
  { href: "/", label: "Übersicht", icon: Activity },
  { href: "/assistant", label: "Assistent", icon: Sparkles },
  { href: "/study", label: "Studium & Wissen", icon: BookOpen },
  { href: "/calendar", label: "Terminplaner", icon: CalendarDays },
  { href: "/finance", label: "Finanzen", icon: Wallet },
  { href: "/lifestyle", label: "Freizeit", icon: Compass },
  { href: "/memory", label: "Gedächtnis", icon: Brain },
  { href: "/lecture", label: "Vorlesungen", icon: Mic },
];

function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link href="/" onClick={onNavigate} className="flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-400/30 bg-cyan-400/10 text-cyan-300">
        <Command size={22} />
      </div>

      <div>
        <div className="font-semibold tracking-[0.18em]">J.A.R.V.I.S.</div>
        <div className="text-[10px] tracking-[0.22em] text-slate-500">
          PERSONAL AI
        </div>
      </div>
    </Link>
  );
}

function NavLinks({
  isActive,
  onNavigate,
}: {
  isActive: (href: string) => boolean;
  onNavigate?: () => void;
}) {
  return (
    <>
      {links.map(({ href, label, icon: Icon }) => {
        const active = isActive(href);

        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`relative flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm transition ${
              active
                ? "jarvis-nav-active border border-cyan-300/10 bg-cyan-300/10 text-cyan-200"
                : "text-slate-400 hover:bg-white/[0.04] hover:text-white"
            }`}
          >
            <Icon size={18} />
            {label}
          </Link>
        );
      })}
    </>
  );
}

function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!CLOUD_ENABLED) return null;

  async function signOut() {
    if (busy) return;

    setBusy(true);
    setFailed(false);

    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });

      if (!res.ok) {
        setFailed(true);
        return;
      }

      router.replace("/login");
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <button
        onClick={() => void signOut()}
        disabled={busy}
        className="jarvis-press flex w-full items-center gap-3 rounded-xl border border-white/10 px-3 py-3 text-sm text-slate-400 transition hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        <LogOut size={18} />
        {busy ? "Wird abgemeldet …" : "Abmelden"}
      </button>

      {failed && (
        <p role="alert" className="mt-2 text-xs text-rose-300">
          Abmelden fehlgeschlagen. Bitte versuche es erneut.
        </p>
      )}
    </div>
  );
}

function StatusCard() {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
        System aktiv
      </div>

      <p className="mt-2 text-xs leading-5 text-slate-500">
        Oberfläche bereit. KI-Dienste sind noch nicht verbunden.
      </p>
    </div>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [lastPathname, setLastPathname] = useState(pathname);

  // Close the mobile drawer after navigation (render adjustment, no effect).
  if (lastPathname !== pathname) {
    setLastPathname(pathname);
    setOpen(false);
  }

  useLockBodyScroll(open);

  useEffect(() => {
    if (!open) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    window.addEventListener("keydown", closeOnEscape);

    return () => {
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open ]);

  const isActive = (href: string) =>
    href === "/"
      ? pathname === "/"
      : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-white/[0.07] bg-[#080b12]/95 px-4 py-3 backdrop-blur md:hidden">
        <Brand />

        <button
          onClick={() => setOpen(true)}
          aria-expanded={open}
          aria-label="Menü öffnen"
          className="rounded-xl border border-white/10 p-2.5 text-slate-300 transition hover:border-cyan-300/30 hover:text-white"
        >
          <Menu size={20} />
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            aria-label="Menü schließen"
            onClick={() => setOpen(false)}
            className="jarvis-fade absolute inset-0 h-full w-full cursor-default bg-black/70"
          />

          <div className="jarvis-drawer absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-white/10 bg-[#0d111b] p-6">
            <div className="flex items-center justify-between gap-3">
              <Brand onNavigate={() => setOpen(false)} />

              <button
                onClick={() => setOpen(false)}
                aria-label="Menü schließen"
                className="rounded-xl border border-white/10 p-2 text-slate-300 transition hover:border-cyan-300/30 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            <nav aria-label="Hauptnavigation" className="mt-10 space-y-2">
              <p className="mb-4 text-[10px] uppercase tracking-[0.2em] text-slate-500">
                Arbeitsbereich
              </p>

              <NavLinks isActive={isActive} onNavigate={() => setOpen(false)} />
            </nav>

            <div className="mt-auto">
              <StatusCard />
              <SignOutButton />
            </div>
          </div>
        </div>
      )}

      <aside className="hidden w-64 shrink-0 border-r border-white/[0.07] p-6 md:flex md:flex-col">
        <Brand />

        <nav aria-label="Hauptnavigation" className="mt-12 space-y-2">
          <p className="mb-4 text-[10px] uppercase tracking-[0.2em] text-slate-500">
            Arbeitsbereich
          </p>

          <NavLinks isActive={isActive} />
        </nav>

        <div className="mt-auto">
          <StatusCard />
        </div>
        <SignOutButton />
      </aside>
    </>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Receipt,
  Wallet,
  Target,
  Sparkles,
  LogOut,
  Menu,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/gastos", label: "Gastos", icon: Receipt },
  { href: "/patrimonio", label: "Patrimonio", icon: Wallet },
  { href: "/objetivos", label: "Objetivos", icon: Target },
] as const;

export function AppShell({
  email,
  children,
}: {
  email: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  const nav = (
    <nav className="flex flex-col gap-1">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={() => setOpen(false)}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );

  const brand = (
    <Link href="/" className="flex items-center gap-2 px-3" onClick={() => setOpen(false)}>
      <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <Sparkles className="size-4" />
      </div>
      <span className="text-lg font-semibold tracking-tight">Maquinita</span>
    </Link>
  );

  const footer = (
    <div className="border-t border-border p-3">
      <div className="truncate px-3 pb-2 text-xs text-muted-foreground" title={email}>
        {email}
      </div>
      <form action="/auth/signout" method="post">
        <Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground">
          <LogOut className="size-4" />
          Cerrar sesión
        </Button>
      </form>
    </div>
  );

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-border bg-card md:flex">
        <div className="flex h-16 items-center">{brand}</div>
        <div className="flex-1 px-3 py-2">{nav}</div>
        {footer}
      </aside>

      {/* Mobile top bar */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-card px-3 md:hidden">
        {brand}
        <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="Menú">
          <Menu className="size-5" />
        </Button>
      </header>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-border bg-card">
            <div className="flex h-16 items-center justify-between pr-3">
              {brand}
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label="Cerrar">
                <X className="size-5" />
              </Button>
            </div>
            <div className="flex-1 px-3 py-2">{nav}</div>
            {footer}
          </aside>
        </div>
      )}

      {/* Content */}
      <main className="flex-1 md:pl-60">
        <div className="mx-auto max-w-6xl px-4 pb-16 pt-20 md:px-8 md:pt-8">{children}</div>
      </main>
    </div>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Receipt,
  Wallet,
  Target,
  CalendarCheck,
  Sparkles,
  LogOut,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PushNotificationToggle } from "@/components/push-notification-toggle";
import { PendingConfirmations } from "@/components/pending-confirmations";

const NAV = [
  { href: "/", label: "Dashboard", short: "Inicio", icon: LayoutDashboard },
  { href: "/gastos", label: "Gastos", short: "Gastos", icon: Receipt },
  { href: "/patrimonio", label: "Patrimonio", short: "Cuentas", icon: Wallet },
  { href: "/objetivos", label: "Objetivos", short: "Metas", icon: Target },
  { href: "/cierre", label: "Cierre mensual", short: "Cierre", icon: CalendarCheck },
] as const;

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function AppShell({
  email,
  children,
}: {
  email: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  const brand = (
    <Link href="/" className="flex items-center gap-2">
      <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <Sparkles className="size-4" />
      </div>
      <span className="text-lg font-semibold tracking-tight">Maquinita</span>
    </Link>
  );

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-border bg-card md:flex">
        <div className="flex h-16 items-center px-5">{brand}</div>
        <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
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
        <div className="border-t border-border p-3">
          <div className="flex items-center justify-between px-3 pb-2">
            <span className="truncate text-xs text-muted-foreground" title={email}>
              {email}
            </span>
            <PushNotificationToggle />
          </div>
          <form action="/auth/signout" method="post">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-muted-foreground"
            >
              <LogOut className="size-4" />
              Cerrar sesión
            </Button>
          </form>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header
        className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-card/95 px-4 backdrop-blur md:hidden"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        {brand}
        <div className="flex items-center gap-1">
          <PushNotificationToggle />
          <form action="/auth/signout" method="post">
            <Button variant="ghost" size="icon" aria-label="Cerrar sesión" className="text-muted-foreground">
              <LogOut className="size-5" />
            </Button>
          </form>
        </div>
      </header>

      {/* Mobile bottom tab bar */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-card/95 backdrop-blur md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {NAV.map(({ href, short, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex min-w-0 flex-col items-center justify-center gap-1 py-2.5 text-[11px] font-medium transition-colors",
                active ? "text-primary" : "text-muted-foreground",
              )}
            >
              <Icon className={cn("size-5", active && "scale-110 transition-transform")} />
              <span className="max-w-full truncate">{short}</span>
            </Link>
          );
        })}
      </nav>

      {/* Content */}
      <main className="min-w-0 flex-1 md:pl-60">
        <div className="mx-auto w-full max-w-6xl px-4 pb-28 pt-[4.5rem] md:px-8 md:pb-16 md:pt-8">
          <PendingConfirmations />
          {children}
        </div>
      </main>
    </div>
  );
}

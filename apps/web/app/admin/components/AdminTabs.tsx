"use client";

import { cn } from "@/lib/utils";
import { ADMIN_TAB_ACTIVE, ADMIN_TAB_IDLE, ADMIN_TAB_LIST } from "../admin-theme";

type Tab = { id: string; label: string };

export default function AdminTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className={ADMIN_TAB_LIST}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cn(active === t.id ? ADMIN_TAB_ACTIVE : ADMIN_TAB_IDLE)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

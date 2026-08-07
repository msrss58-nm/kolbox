import { useState, type ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface TabDef {
  id: string;
  label: string;
  content: ReactNode;
}

/**
 * Tabs - simple single-active-tab switcher for a page with 2+ views over the
 * same domain (e.g. "משתמשים" / "תפקידים" both under one "הרשאות ומשתמשים"
 * screen). Not a router - state is local and resets on remount, matching
 * this app's existing `Accordion` primitive's scope (page-level UI, not
 * URL-addressable sub-state).
 */
export function Tabs({ tabs, defaultTabId }: { tabs: TabDef[]; defaultTabId?: string }) {
  const [activeId, setActiveId] = useState(defaultTabId ?? tabs[0]?.id);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  if (!active) return null;

  return (
    <div>
      <div role="tablist" className="flex gap-1 border-b border-slate-200">
        {tabs.map((tab) => {
          const isActive = tab.id === active.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveId(tab.id)}
              className={cn(
                "touch-target -mb-px rounded-t-lg px-4 text-sm font-semibold transition-colors",
                isActive
                  ? "border-b-2 border-primary-600 text-primary-600"
                  : "border-b-2 border-transparent text-slate-500 hover:text-slate-700",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" className="pt-4">
        {active.content}
      </div>
    </div>
  );
}

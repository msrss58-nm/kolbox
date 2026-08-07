import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Card } from "./Card";
import { cn } from "../../lib/utils";

export interface AccordionSection {
  id: string;
  icon: string;
  label: string;
  content: ReactNode;
}

/**
 * Accordion - single-open-section collapsible list, wrapped in one `Card` so
 * it reads as one cohesive block. Clicking an open section's header collapses
 * it back; clicking a different one switches to it - only one section is
 * ever open at a time.
 */
export function Accordion({ sections }: { sections: AccordionSection[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <Card className="divide-y divide-slate-100 space-y-1.5 p-0">
      {sections.map((section) => {
        const isOpen = section.id === openId;
        const headerId = `accordion-header-${section.id}`;
        const contentId = `accordion-content-${section.id}`;

        return (
          <div key={section.id}>
            <button
              type="button"
              id={headerId}
              aria-expanded={isOpen}
              aria-controls={contentId}
              onClick={() => setOpenId(isOpen ? null : section.id)}
              className={cn(
                "touch-target flex w-full items-center gap-3 px-5 py-4 text-start font-semibold text-slate-800 hover:bg-slate-50",
                isOpen && "bg-primary-50 hover:bg-primary-50",
              )}
            >
              <span className="text-lg">{section.icon}</span>
              <span className="flex-1">{section.label}</span>
              <ChevronDown
                className={cn(
                  "size-6 shrink-0 text-slate-400 transition-transform duration-200",
                  isOpen && "rotate-180",
                )}
              />
            </button>
            {isOpen && (
              <div
                id={contentId}
                role="region"
                aria-labelledby={headerId}
                className="animate-fade-in px-5 pb-4"
              >
                {section.content}
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}

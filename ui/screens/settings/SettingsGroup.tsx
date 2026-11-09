// One collapsible row of the Settings page (the Mac's SettingsSectionCard): icon, UPPERCASE title, chevron.
// The header is a real button inside an h2 (Enter and Space toggle it, aria-expanded, aria-controls). The body is not
// rendered (so its code is not fetched) until the parent says it must be mounted (`mounted`, see keepMounted in
// groups.ts); once mounted it is only hidden when closed, so unsaved input and in-progress flows survive collapsing.
import type { ReactNode } from "react";
import { ChevronIcon, Icon, type IconName } from "@llmide/ui-kit";

export interface SettingsGroupProps {
  id: string;
  title: string;
  icon: IconName | undefined;
  open: boolean;
  /** The body exists in the DOM. False for a group never opened by the user (and not shown by a search). */
  mounted: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export function SettingsGroup({ id, title, icon, open, mounted, onToggle, children }: SettingsGroupProps) {
  const headerId = `st-group-h-${id}`;
  const bodyId = `st-group-b-${id}`;
  return (
    <section className="ui-settings-section st-group" id={`st-group-${id}`} data-group={id} data-open={open}>
      <h2 className="st-group-h" id={headerId}>
        <button type="button" className="ui-settings-header st-group-btn" aria-expanded={open} aria-controls={bodyId} title={open ? `Collapse ${title}` : `Expand ${title}`} onClick={onToggle}>
          <span className="ui-settings-icon" aria-hidden="true">{icon ? <Icon name={icon} size={13} /> : null}</span>
          <span className="ui-settings-title">{title}</span>
          <span className="ui-settings-spacer" />
          <span className="ui-settings-chevron" data-open={open} aria-hidden="true"><ChevronIcon /></span>
        </button>
      </h2>
      {mounted ? <div className="ui-card" id={bodyId} role="region" aria-labelledby={headerId} hidden={!open}>{children}</div> : null}
    </section>
  );
}

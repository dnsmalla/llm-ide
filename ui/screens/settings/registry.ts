// Section registry (the web counterpart of the Mac SettingsSectionRegistry). Settings
// owns the built-in sections; any other screen can contribute a CARD to a section by id
// without editing Settings. Components are loaded lazily (code-split), so a section's code
// is fetched only when it is first opened.

import type { IconName } from "@llmide/ui-kit";

export type Loader<C> = () => Promise<{ default: C }>;

export interface SectionDef<C> {
  id: string;
  title: string;
  /** Lower first. Ties break by id so the order is stable. */
  order: number;
  load: Loader<C>;
  /** Header glyph (kit Lucide set). Optional so a test registry can omit it. */
  icon?: IconName;
  /** "app" (default) always shows; "project" only while a project is open, like the Mac's Project block. */
  band?: "app" | "project";
}

export interface CardDef<C> {
  id: string;
  title: string;
  order: number;
  load: Loader<C>;
}

export class SettingsRegistry<C = unknown> {
  readonly #sections = new Map<string, SectionDef<C>>();
  readonly #cards = new Map<string, Map<string, CardDef<C>>>();
  readonly #listeners = new Set<() => void>();
  #version = 0;

  /** Registers a section. A second registration with the same id is a programming error. */
  registerSection(def: SectionDef<C>): void {
    if (this.#sections.has(def.id)) throw new Error(`settings section "${def.id}" is already registered`);
    this.#sections.set(def.id, def);
    this.#changed();
  }

  /** Adds a card to a section (which may be registered later). Same id twice is an error. */
  registerCard(sectionId: string, def: CardDef<C>): void {
    const m = this.#cards.get(sectionId) ?? new Map<string, CardDef<C>>();
    if (m.has(def.id)) throw new Error(`settings card "${sectionId}/${def.id}" is already registered`);
    m.set(def.id, def);
    this.#cards.set(sectionId, m);
    this.#changed();
  }

  /** The groups of one band, in order. */
  sectionsIn(band: "app" | "project"): SectionDef<C>[] {
    return this.sections().filter((s) => (s.band ?? "app") === band);
  }

  sections(): SectionDef<C>[] {
    return [...this.#sections.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  section(id: string): SectionDef<C> | undefined {
    return this.#sections.get(id);
  }

  cardsFor(sectionId: string): CardDef<C>[] {
    return [...(this.#cards.get(sectionId)?.values() ?? [])].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  /** Cards aimed at a section id nobody registered (a typo shows up here, and in tests). */
  orphanCards(): string[] {
    return [...this.#cards.keys()].filter((id) => !this.#sections.has(id));
  }

  subscribe = (l: () => void): (() => void) => {
    this.#listeners.add(l);
    return () => {
      this.#listeners.delete(l);
    };
  };

  /** Changes on every registration; for useSyncExternalStore. */
  version = (): number => this.#version;

  #changed(): void {
    this.#version++;
    for (const l of [...this.#listeners]) l();
  }
}

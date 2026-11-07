// Adds the Notifications card to Settings > General through the registry's card slot. Imported once by the Settings
// entry (ui/screens/settings/index.tsx), so the card loads only with Settings.
import { settingsRegistry, type SectionComponent } from "../../settings/registry-default.ts";

settingsRegistry.registerCard("general", {
  id: "notifications",
  title: "Notifications",
  order: 10,
  load: () => import("./NotificationsCard.tsx") as unknown as Promise<{ default: SectionComponent }>,
});

settingsRegistry.registerCard("general", {
  id: "push",
  title: "Phone and web push",
  order: 11,
  load: () => import("./PushCard.tsx") as unknown as Promise<{ default: SectionComponent }>,
});

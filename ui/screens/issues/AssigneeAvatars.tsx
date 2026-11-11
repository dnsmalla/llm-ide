// Small initials avatars for issue assignees. Provider avatar URLs are remote images and the desktop CSP blocks
// them, so this uses a deterministic palette + initials: no network, no privacy leak, and always available.
const COLORS = [
  "var(--tok-color-accent2)",
  "var(--tok-color-accent3)",
  "var(--tok-color-accent4)",
  "var(--tok-color-category-purple)",
  "var(--tok-color-category-teal)",
  "var(--tok-color-category-amber)",
];

const initials = (name: string): string => name.trim().split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";
const colorFor = (name: string): string => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return COLORS[h % COLORS.length]!;
};

export function AssigneeAvatars({ names, size = 20, max = 3, label = true }: { names: readonly string[]; size?: number; max?: number; label?: boolean }) {
  if (names.length === 0) return null;
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return (
    <span className="iss-avatars" aria-label={names.join(", ")} style={{ display: "inline-flex", alignItems: "center" }}>
      {shown.map((n) => (
        <span
          key={n}
          className="iss-avatar"
          title={n}
          style={{ width: size, height: size, fontSize: Math.max(8, size * 0.4), background: colorFor(n) }}
        >
          {initials(n)}
        </span>
      ))}
      {rest > 0 ? <span className="iss-avatar iss-avatar-more" style={{ width: size, height: size, fontSize: Math.max(8, size * 0.38) }}>+{rest}</span> : null}
      {label ? <span className="iss-avatar-names">{names.join(", ")}</span> : null}
    </span>
  );
}

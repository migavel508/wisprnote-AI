/**
 * Derives a clean human display name from an email address.
 *
 * Strips digits, dots, underscores, hyphens, and plus-tags from the local part,
 * then capitalises the first letter. `migaveld589@gmail.com` → `Migaveld`,
 * `jane.doe+work@x.com` → `Jane`.
 *
 * If a Cognito `name` attribute is provided and it is not just an email
 * fallback (i.e. doesn't contain `@`), that name is preferred unchanged.
 */
export function formatDisplayName(
  email?: string | null,
  name?: string | null,
  fallback = 'User'
): string {
  const trimmedName = name?.trim();
  if (trimmedName && !trimmedName.includes('@')) {
    return trimmedName;
  }

  if (!email) return fallback;
  const localPart = email.split('@')[0] ?? '';
  // Stop at first separator (`.`, `_`, `-`, `+`) — common email conventions.
  const head = localPart.split(/[._\-+]/)[0] ?? localPart;
  // Strip digits.
  const letters = head.replace(/[^a-zA-Z]/g, '');
  if (!letters) return fallback;
  return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
}

/**
 * Two-letter initials derived from `formatDisplayName`.
 * Single-word names use the first two characters; multi-word names use the
 * first letter of the first two parts.
 */
export function formatDisplayInitials(
  email?: string | null,
  name?: string | null,
  fallback = 'U'
): string {
  const display = formatDisplayName(email, name, '');
  if (!display) return fallback;
  const parts = display.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0] + parts[1]![0]).toUpperCase();
  }
  return display.substring(0, 2).toUpperCase();
}

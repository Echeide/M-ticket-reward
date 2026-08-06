export type AdminRole = 'SUPERADMIN' | 'ADMIN';

export function normalizeAdminEmail(value: unknown): string {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error('ADMIN_EMAIL_INVALID');
  }
  return email;
}

export type AdminRole = 'SUPERADMIN' | 'ADMIN' | 'OPERATOR';
export type AssignableAdminRole = Exclude<AdminRole, 'SUPERADMIN'>;

export function normalizeAdminEmail(value: unknown): string {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error('ADMIN_EMAIL_INVALID');
  }
  return email;
}

export function normalizeAssignableAdminRole(value: unknown): AssignableAdminRole {
  if (value === 'ADMIN' || value === 'OPERATOR') return value;
  throw new Error('ADMIN_ROLE_INVALID');
}

export function canCreateAdminRole(currentRole: AdminRole, targetRole: AssignableAdminRole): boolean {
  if (currentRole === 'SUPERADMIN') return true;
  return currentRole === 'ADMIN' && targetRole === 'OPERATOR';
}

export function canDeleteAdminRole(currentRole: AdminRole, targetRole: AdminRole): boolean {
  if (targetRole === 'SUPERADMIN') return false;
  if (currentRole === 'SUPERADMIN') return true;
  return currentRole === 'ADMIN' && targetRole === 'OPERATOR';
}

export function adminRouteAllowed(role: AdminRole, method: string, pathname: string): boolean {
  if (role !== 'OPERATOR') return true;
  if (method === 'GET') {
    if (['/api/admin/session', '/api/admin/receipts', '/api/admin/receipts.csv', '/api/admin/spaces',
      '/api/admin/stores', '/api/admin/settings'].includes(pathname)) return true;
    if (/^\/api\/admin\/receipts\/[^/]+(?:\/image)?$/.test(pathname)) return true;
    if (/^\/api\/admin\/stores\/[^/]+\/(?:logo|ocr-profile|training)$/.test(pathname)) return true;
    if (/^\/api\/admin\/stores\/[^/]+\/training\/[^/]+\/image$/.test(pathname)) return true;
  }
  if (method === 'POST' && /^\/api\/admin\/receipts\/[^/]+\/(?:reprocess|review)$/.test(pathname)) {
    return true;
  }
  return false;
}

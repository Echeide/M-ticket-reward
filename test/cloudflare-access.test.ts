import assert from 'node:assert/strict';
import test from 'node:test';
import { PENDING_CONFIGURATION_VALUE } from '../src/configuration';
import { adminAccessSyncConfigured } from '../src/integrations/cloudflare-access';
import type { Env } from '../src/types';

test('Cloudflare Access sync ignores pending configuration placeholders', () => {
  assert.equal(adminAccessSyncConfigured({
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_ACCESS_EMAIL_LIST_ID: 'list-id',
    CLOUDFLARE_ACCESS_API_TOKEN: 'api-token',
  } as Env), true);
  assert.equal(adminAccessSyncConfigured({
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_ACCESS_EMAIL_LIST_ID: PENDING_CONFIGURATION_VALUE,
    CLOUDFLARE_ACCESS_API_TOKEN: PENDING_CONFIGURATION_VALUE,
  } as Env), false);
});

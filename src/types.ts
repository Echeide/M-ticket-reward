export type JobMessage =
  | { kind: 'OCR_RECEIPT'; receiptId: string }
  | { kind: 'DELIVER_REWARD'; outboxId: string };

export interface Env {
  ASSETS: Fetcher;
  TICKETS: R2Bucket;
  JOBS: Queue<JobMessage>;
  HYPERDRIVE: Hyperdrive;
  AI: Ai;
  RTALES_BASE_URL: string;
  RTALES_PARENT_ORIGINS: string;
  RTALES_EXTERNAL_GAME_TOKEN: string;
  DATA_ENCRYPTION_KEY: string;
  OCR_MODEL: string;
  OCR_MODE: string;
  ALLOW_DEV_ADMIN: string;
  DEV_ADMIN_TOKEN?: string;
  MAX_TICKET_BYTES: string;
}

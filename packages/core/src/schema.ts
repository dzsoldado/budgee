// Valibot schemas shared by the server, the web app and CSV import. Every object is strict:
// unknown fields are rejected.
import * as v from "valibot";
import { DEVICE_ID_PATTERN, HLC_PATTERN } from "./hlc";

// ─── Primitives ─────────────────────────────────────────────────────────────

export const SYNCED_TABLES = ["transactions", "categories", "settings", "chart_configs"] as const;
export type TableName = (typeof SYNCED_TABLES)[number];

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` that names a real day of the (proleptic Gregorian) calendar. */
export function isValidDate(text: string): boolean {
  const match = DATE_PATTERN.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= daysInMonth;
}

export const uuidSchema = v.pipe(v.string(), v.uuid());
export const hlcSchema = v.pipe(v.string(), v.regex(HLC_PATTERN, "Invalid hlc"));
export const deviceIdSchema = v.pipe(v.string(), v.regex(DEVICE_ID_PATTERN, "Invalid device id"));
export const isoDateSchema = v.pipe(v.string(), v.check(isValidDate, "Invalid date"));
/** ISO 4217 shape: three uppercase letters. */
export const currencySchema = v.pipe(v.string(), v.regex(/^[A-Z]{3}$/, "Invalid currency code"));
/** Tags are trimmed, non-empty and never contain `;` (the CSV tag separator). */
export const tagSchema = v.pipe(
  v.string(),
  v.nonEmpty("Tag is empty"),
  v.check((tag) => !tag.includes(";"), "A tag cannot contain ';'"),
  v.check((tag) => tag.trim() === tag, "Tag is not trimmed"),
);
const nameSchema = v.pipe(v.string(), v.nonEmpty("Name is empty"));
const sortSchema = v.pipe(v.number(), v.safeInteger());
const countSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
/** Hundredths of a currency unit. */
const positiveAmountSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const typeSchema = v.picklist(["income", "expense"]);

// ─── Sync columns and tombstones ────────────────────────────────────────────

const syncEntries = { id: uuidSchema, hlc: hlcSchema, device: deviceIdSchema };
const liveSyncEntries = { ...syncEntries, deleted: v.literal(false) };

/** A deleted row: only the sync columns, like a tombstone envelope (which has no blob). */
export const tombstoneSchema = v.strictObject({ ...syncEntries, deleted: v.literal(true) });
export type Tombstone = v.InferOutput<typeof tombstoneSchema>;

// ─── transactions ───────────────────────────────────────────────────────────

const transactionEntries = {
  type: typeSchema,
  amount: positiveAmountSchema,
  date: isoDateSchema,
  category: nameSchema,
  detail: v.optional(v.string(), ""),
  note: v.optional(v.string(), ""),
  tags: v.optional(v.array(tagSchema), () => []),
  /** In hundredths of `original_currency`; null when paid in the main currency. */
  original_amount: v.optional(v.nullable(positiveAmountSchema), null),
  original_currency: v.optional(v.nullable(currencySchema), null),
  created_at: v.pipe(v.string(), v.isoTimestamp()),
};

interface TransactionShape {
  original_amount: number | null;
  original_currency: string | null;
}

// Cross-field invariants, each reported on the field to fix. Valibot types an action by the
// exact object it validates, so both pipes below spell the actions out around these.
const hasAmountIfCurrency = (t: TransactionShape) =>
  t.original_amount !== null || t.original_currency === null;
const AMOUNT_MESSAGE = "Original currency is set without an original amount";
const hasCurrencyIfAmount = (t: TransactionShape) =>
  t.original_currency !== null || t.original_amount === null;
const CURRENCY_MESSAGE = "Original amount is set without an original currency";

export const transactionFieldsSchema = v.pipe(
  v.strictObject(transactionEntries),
  v.forward(
    v.check((t) => hasAmountIfCurrency(t), AMOUNT_MESSAGE),
    ["original_amount"],
  ),
  v.forward(
    v.check((t) => hasCurrencyIfAmount(t), CURRENCY_MESSAGE),
    ["original_currency"],
  ),
);
const liveTransactionSchema = v.pipe(
  v.strictObject({ ...liveSyncEntries, ...transactionEntries }),
  v.forward(
    v.check((t) => hasAmountIfCurrency(t), AMOUNT_MESSAGE),
    ["original_amount"],
  ),
  v.forward(
    v.check((t) => hasCurrencyIfAmount(t), CURRENCY_MESSAGE),
    ["original_currency"],
  ),
);
export const transactionRowSchema = v.union([liveTransactionSchema, tombstoneSchema]);

export type TransactionFields = v.InferOutput<typeof transactionFieldsSchema>;
export type TransactionFieldsInput = v.InferInput<typeof transactionFieldsSchema>;
export type LiveTransaction = v.InferOutput<typeof liveTransactionSchema>;
export type TransactionRow = v.InferOutput<typeof transactionRowSchema>;

// ─── categories ─────────────────────────────────────────────────────────────

const categoryEntries = {
  type: typeSchema,
  name: nameSchema,
  sort: sortSchema,
  archived: v.boolean(),
};
export const categoryFieldsSchema = v.strictObject(categoryEntries);
const liveCategorySchema = v.strictObject({ ...liveSyncEntries, ...categoryEntries });
export const categoryRowSchema = v.union([liveCategorySchema, tombstoneSchema]);
export type CategoryFields = v.InferOutput<typeof categoryFieldsSchema>;
export type LiveCategory = v.InferOutput<typeof liveCategorySchema>;
export type CategoryRow = v.InferOutput<typeof categoryRowSchema>;

// ─── chart configs ──────────────────────────────────────────────────────────

export const compareSchema = v.picklist([
  "none",
  "previous_period",
  "same_period_last_year",
  "avg_12_months",
]);
export type Compare = v.InferOutput<typeof compareSchema>;

/** Excluded category and tag names. */
export const exclusionsSchema = v.optional(
  v.strictObject({
    categories: v.optional(v.array(nameSchema), () => []),
    tags: v.optional(v.array(tagSchema), () => []),
  }),
  () => ({ categories: [], tags: [] }),
);
export type Exclusions = v.InferOutput<typeof exclusionsSchema>;

export const chartConfigSchema = v.strictObject({
  kind: v.picklist(["bar", "line", "doughnut", "table"]),
  metric: v.picklist(["expenses", "income", "difference", "kept_ratio", "count"]),
  groupBy: v.picklist(["day", "month", "year", "weekday", "category", "detail", "tag"]),
  period: v.picklist(["dashboard", "last_12_months", "this_year", "all_time", "month", "year"]),
  /** `YYYY-MM`: the month a `month` period shows; a `year` period shows its year. */
  periodRef: v.optional(v.pipe(v.string(), v.regex(/^\d{4}-(0[1-9]|1[0-2])$/))),
  compare: v.optional(compareSchema, "none"),
  /** Running total within the period. */
  cumulative: v.optional(v.boolean(), false),
  /** When not empty, counts only entries carrying one of these tags. */
  onlyTags: v.optional(v.array(tagSchema), () => []),
  exclude: exclusionsSchema,
  useDashboardExclusions: v.optional(v.boolean(), true),
  /** Top N groups; the rest are folded into "Other". */
  limit: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
});
export type ChartConfig = v.InferOutput<typeof chartConfigSchema>;
export type ChartConfigInput = v.InferInput<typeof chartConfigSchema>;

const chartConfigEntries = { name: nameSchema, sort: sortSchema, config: chartConfigSchema };
export const chartConfigFieldsSchema = v.strictObject(chartConfigEntries);
const liveChartConfigSchema = v.strictObject({ ...liveSyncEntries, ...chartConfigEntries });
export const chartConfigRowSchema = v.union([liveChartConfigSchema, tombstoneSchema]);
export type ChartConfigFields = v.InferOutput<typeof chartConfigFieldsSchema>;
export type LiveChartConfig = v.InferOutput<typeof liveChartConfigSchema>;
export type ChartConfigRow = v.InferOutput<typeof chartConfigRowSchema>;

// ─── settings ───────────────────────────────────────────────────────────────

export const dashboardSettingsSchema = v.strictObject({
  period: v.picklist(["month", "year"]),
  compare: compareSchema,
  exclude: exclusionsSchema,
});
export type DashboardSettings = v.InferOutput<typeof dashboardSettingsSchema>;

/**
 * One row per key. Each key has a fixed id, so two devices that write the same setting
 * converge on one row by hlc instead of creating duplicates.
 */
export const SETTING_IDS = {
  currency: "00000000-0000-4000-8000-000300000001",
  decimals: "00000000-0000-4000-8000-000300000002",
  locale: "00000000-0000-4000-8000-000300000003",
  theme: "00000000-0000-4000-8000-000300000004",
  dashboard: "00000000-0000-4000-8000-000300000005",
} as const;
export type SettingKey = keyof typeof SETTING_IDS;

const settingEntries = {
  currency: { key: v.literal("currency"), value: currencySchema },
  decimals: { key: v.literal("decimals"), value: v.picklist([0, 1, 2]) },
  locale: {
    key: v.literal("locale"),
    value: v.pipe(v.string(), v.regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Invalid locale")),
  },
  theme: { key: v.literal("theme"), value: v.picklist(["system", "light", "dark"]) },
  dashboard: { key: v.literal("dashboard"), value: dashboardSettingsSchema },
};

export const settingFieldsSchema = v.variant("key", [
  v.strictObject(settingEntries.currency),
  v.strictObject(settingEntries.decimals),
  v.strictObject(settingEntries.locale),
  v.strictObject(settingEntries.theme),
  v.strictObject(settingEntries.dashboard),
]);
const liveSettingSchema = v.pipe(
  v.variant("key", [
    v.strictObject({ ...liveSyncEntries, ...settingEntries.currency }),
    v.strictObject({ ...liveSyncEntries, ...settingEntries.decimals }),
    v.strictObject({ ...liveSyncEntries, ...settingEntries.locale }),
    v.strictObject({ ...liveSyncEntries, ...settingEntries.theme }),
    v.strictObject({ ...liveSyncEntries, ...settingEntries.dashboard }),
  ]),
  v.check((row) => row.id === SETTING_IDS[row.key], "Setting id does not match its key"),
);
export const settingRowSchema = v.union([liveSettingSchema, tombstoneSchema]);
export type SettingFields = v.InferOutput<typeof settingFieldsSchema>;
export type LiveSetting = v.InferOutput<typeof liveSettingSchema>;
export type SettingRow = v.InferOutput<typeof settingRowSchema>;
/** The value type stored under each settings key. */
export type SettingValues = { [K in SettingKey]: Extract<SettingFields, { key: K }>["value"] };

// ─── table registries ───────────────────────────────────────────────────────

/** The user fields of each table: what a live envelope's blob decrypts to. */
export const fieldSchemas = {
  transactions: transactionFieldsSchema,
  categories: categoryFieldsSchema,
  settings: settingFieldsSchema,
  chart_configs: chartConfigFieldsSchema,
} as const satisfies Record<TableName, v.GenericSchema>;

/** Sync columns plus fields for live rows, or a tombstone. */
export const rowSchemas = {
  transactions: transactionRowSchema,
  categories: categoryRowSchema,
  settings: settingRowSchema,
  chart_configs: chartConfigRowSchema,
} as const satisfies Record<TableName, v.GenericSchema>;

// ─── envelopes ──────────────────────────────────────────────────────────────

const envelopeEntries = {
  table: v.picklist(SYNCED_TABLES),
  id: uuidSchema,
  hlc: hlcSchema,
  device: deviceIdSchema,
  /** Server sequence; set by the server, absent on push. */
  seq: v.optional(countSchema),
};

/** Longest accepted blob, in base64 characters (about 48 KiB of encrypted row). */
export const BLOB_MAX_LENGTH = 65_536;

/** base64(IV + AES-GCM ciphertext). */
const blobSchema = v.pipe(v.string(), v.nonEmpty(), v.maxLength(BLOB_MAX_LENGTH), v.base64());

/** What the server stores: row contents only as an encrypted blob; tombstones carry none. */
export const envelopeSchema = v.variant("deleted", [
  v.strictObject({ ...envelopeEntries, deleted: v.literal(false), blob: blobSchema }),
  v.strictObject({ ...envelopeEntries, deleted: v.literal(true) }),
]);
export type Envelope = v.InferOutput<typeof envelopeSchema>;

// ─── backups ────────────────────────────────────────────────────────────────

const backupRecordEntries = {
  table: envelopeEntries.table,
  id: envelopeEntries.id,
  hlc: envelopeEntries.hlc,
};

/** One line of a backup file: an envelope's `table`, `id`, `hlc`, `deleted` and `blob`. */
export const backupRecordSchema = v.variant("deleted", [
  v.strictObject({ ...backupRecordEntries, deleted: v.literal(false), blob: blobSchema }),
  v.strictObject({ ...backupRecordEntries, deleted: v.literal(true) }),
]);
export type BackupRecord = v.InferOutput<typeof backupRecordSchema>;

// ─── API payloads (all under /api/v1) ───────────────────────────────────────

/** Every API path starts with this. */
export const API_BASE = "/api/v1";

export const PUSH_MAX = 500;
export const PULL_LIMIT = 500;
/** Largest push request body; the server answers 413 above it. Split pushes below this size. */
export const PUSH_MAX_BYTES = 4 * 1024 * 1024;

/** Every error response: a stable `code` to branch on and a human-readable `message`. */
export const errorResponseSchema = v.strictObject({
  error: v.strictObject({ code: v.string(), message: v.string() }),
});
export type ErrorResponse = v.InferOutput<typeof errorResponseSchema>;

const tokenSchema = v.pipe(v.string(), v.nonEmpty());
const deviceNameSchema = v.pipe(v.string(), v.nonEmpty(), v.maxLength(100));
const deviceTokenResponseSchema = v.strictObject({ token: tokenSchema, serverId: tokenSchema });

/** GET /health */
export const healthResponseSchema = v.strictObject({
  serverId: v.pipe(v.string(), v.nonEmpty()),
  version: v.pipe(v.string(), v.nonEmpty()),
  /** Milliseconds since the Unix epoch. */
  serverTime: countSchema,
});
export type HealthResponse = v.InferOutput<typeof healthResponseSchema>;

/** POST /setup: only while no device exists. */
export const setupRequestSchema = v.strictObject({
  secret: tokenSchema,
  deviceName: deviceNameSchema,
});
export const setupResponseSchema = deviceTokenResponseSchema;
export type SetupRequest = v.InferOutput<typeof setupRequestSchema>;
export type SetupResponse = v.InferOutput<typeof setupResponseSchema>;

/** How long a pairing code from POST /devices/invite stays valid. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/** POST /devices/invite (no body): a one-time pairing code, valid 10 minutes. */
export const inviteResponseSchema = v.strictObject({
  code: tokenSchema,
  /** Milliseconds since the Unix epoch. */
  expiresAt: countSchema,
});
export type InviteResponse = v.InferOutput<typeof inviteResponseSchema>;

/** POST /devices/pair */
export const pairRequestSchema = v.strictObject({
  code: tokenSchema,
  deviceName: deviceNameSchema,
});
export const pairResponseSchema = deviceTokenResponseSchema;
export type PairRequest = v.InferOutput<typeof pairRequestSchema>;
export type PairResponse = v.InferOutput<typeof pairResponseSchema>;

/** One entry of GET /devices. Times are milliseconds since the Unix epoch. */
export const deviceSchema = v.strictObject({
  id: v.pipe(v.string(), v.nonEmpty()),
  name: deviceNameSchema,
  createdAt: countSchema,
  lastSeen: v.nullable(countSchema),
  revoked: v.boolean(),
  /** The device that made the request. */
  current: v.boolean(),
});
export type Device = v.InferOutput<typeof deviceSchema>;

/** GET /devices */
export const deviceListResponseSchema = v.strictObject({ devices: v.array(deviceSchema) });
export type DeviceListResponse = v.InferOutput<typeof deviceListResponseSchema>;

/** PATCH /devices/:id (rename); responds with the updated device. */
export const renameDeviceRequestSchema = v.strictObject({ name: deviceNameSchema });
export type RenameDeviceRequest = v.InferOutput<typeof renameDeviceRequestSchema>;

/**
 * POST /devices/:id/revoke (body optional); responds with the updated device. Revoking the
 * calling device itself needs `confirmSelf: true`.
 */
export const revokeDeviceRequestSchema = v.strictObject({
  confirmSelf: v.optional(v.literal(true)),
});
export type RevokeDeviceRequest = v.InferOutput<typeof revokeDeviceRequestSchema>;

/** POST /sync/push */
export const pushRequestSchema = v.strictObject({
  envelopes: v.pipe(v.array(envelopeSchema), v.maxLength(PUSH_MAX)),
});
export const pushResponseSchema = v.strictObject({
  accepted: countSchema,
  /** Older than (or equal to) what the server holds. */
  ignored: countSchema,
});
export type PushRequest = v.InferOutput<typeof pushRequestSchema>;
export type PushResponse = v.InferOutput<typeof pushResponseSchema>;

const queryIntSchema = v.pipe(
  v.string(),
  v.regex(/^\d{1,15}$/, "Expected a non-negative integer"),
  v.transform(Number),
);

/** GET /sync/pull?since=<seq>&limit=500 (query values arrive as strings). */
export const pullQuerySchema = v.strictObject({
  since: queryIntSchema,
  limit: v.optional(
    v.pipe(queryIntSchema, v.minValue(1), v.maxValue(PULL_LIMIT)),
    String(PULL_LIMIT),
  ),
});
export const pullResponseSchema = v.strictObject({
  envelopes: v.array(envelopeSchema),
  nextSeq: countSchema,
  hasMore: v.boolean(),
  resetRequired: v.boolean(),
});
export type PullQuery = v.InferOutput<typeof pullQuerySchema>;
export type PullResponse = v.InferOutput<typeof pullResponseSchema>;

/**
 * What kind of failure a backup error is, for Settings to explain in its own words (the message
 * is detail for admins). `reconnect`: access revoked or expired. `refused`: the destination
 * refused the change (storage full, no permission). `not_found`: the folder or file is gone.
 * `unavailable`: the destination failed or could not be reached. `other`: anything else.
 */
export const BACKUP_ERROR_CODES = [
  "reconnect",
  "refused",
  "not_found",
  "unavailable",
  "other",
] as const;
export type BackupErrorCode = (typeof BACKUP_ERROR_CODES)[number];

/**
 * A BackupErrorCode as sent: any short code, so a client meets codes newer than it knows (and
 * treats them as `other`); null when there is no error or the server predates codes.
 */
const errorCodeSchema = v.optional(v.nullable(v.pipe(v.string(), v.maxLength(64))), null);

/** One backup attempt, daily or "back up now". Times are milliseconds since the Unix epoch. */
export const backupRunSchema = v.strictObject({
  at: countSchema,
  /** `not_configured`: no backup destination is connected, so nothing was written. */
  status: v.picklist(["ok", "error", "not_configured"]),
  /** What went wrong, without secrets; null unless `status` is `error`. */
  error: v.nullable(v.string()),
  /** The kind of `error` (BackupErrorCode). */
  errorCode: errorCodeSchema,
  /** The file written, e.g. `budgee-2026-11-17.jsonl.gz`; null when none was. */
  file: v.nullable(v.string()),
  /** Envelopes in that file; null when no file was written. */
  envelopes: v.nullable(countSchema),
  durationMs: countSchema,
  /**
   * Why removing old backups failed after the file was saved, without secrets; null when it
   * did not fail. The backup itself still counts as done. Absent in records from before it.
   */
  retentionError: v.optional(v.nullable(v.string()), null),
  /** The kind of `retentionError` (BackupErrorCode). */
  retentionErrorCode: errorCodeSchema,
});
export type BackupRun = v.InferOutput<typeof backupRunSchema>;

/** One tombstone cleanup, part of the daily run. */
export const cleanupRunSchema = v.strictObject({
  at: countSchema,
  ok: v.boolean(),
  /** What went wrong, without secrets; null when `ok`. */
  error: v.nullable(v.string()),
  /** Tombstones deleted. */
  purged: countSchema,
  durationMs: countSchema,
});
export type CleanupRun = v.InferOutput<typeof cleanupRunSchema>;

/** GET /backups/status */
export const backupStatusResponseSchema = v.strictObject({
  destination: v.strictObject({
    /** The destination, e.g. `google-drive`; null when the server has none. */
    kind: v.nullable(v.string()),
    /**
     * Whether the server has the settings the destination needs (for Google Drive:
     * GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CONFIG_KEY and PUBLIC_ORIGIN).
     */
    configured: v.boolean(),
    /** A destination is connected, so backups go to it. */
    connected: v.boolean(),
    /** The connection stopped working (access revoked or expired): connect it again. */
    reconnectNeeded: v.boolean(),
  }),
  lastRun: v.nullable(backupRunSchema),
  lastCleanup: v.nullable(cleanupRunSchema),
  /** Backup files at the destination, newest first. */
  files: v.array(v.string()),
  /** Why the file list could not be read, without secrets; null when it could. */
  filesError: v.nullable(v.string()),
  /** The kind of `filesError` (BackupErrorCode). */
  filesErrorCode: errorCodeSchema,
  /** When the next daily run is scheduled, ms since the Unix epoch; absent from older servers. */
  nextRunAt: v.optional(countSchema),
});
export type BackupStatusResponse = v.InferOutput<typeof backupStatusResponseSchema>;

/** GET /backups/google/connect: the Google consent page to open; it returns to Settings. */
export const googleConnectResponseSchema = v.strictObject({ url: v.pipe(v.string(), v.url()) });
export type GoogleConnectResponse = v.InferOutput<typeof googleConnectResponseSchema>;

/** POST /backups/run (no body): backs up now (no cleanup) and answers with the attempt. */
export const backupRunResponseSchema = backupRunSchema;
export type BackupRunResponse = v.InferOutput<typeof backupRunResponseSchema>;

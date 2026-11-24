// Setup, pairing and the device list over HTTP (spec "Pairing and auth"). Setup and pair need no
// token; the rest send this device's. Throws SyncError, whose `code` is the server's error code.
import {
  type Device,
  deviceListResponseSchema,
  deviceSchema,
  type InviteResponse,
  inviteResponseSchema,
  type PairRequest,
  type PairResponse,
  pairResponseSchema,
  type RevokeDeviceRequest,
  type SetupRequest,
  type SetupResponse,
  setupResponseSchema,
} from "./schema";
import { createApiRequest, type HttpFetch } from "./sync-client";

export interface DeviceApi {
  /** Claims a server that has no device yet with its setup secret. */
  setup(request: SetupRequest): Promise<SetupResponse>;
  /** Pairs with a one-time code from a paired device. */
  pair(request: PairRequest): Promise<PairResponse>;
  /** A one-time pairing code, valid 10 minutes. */
  invite(): Promise<InviteResponse>;
  list(): Promise<Device[]>;
  rename(id: string, name: string): Promise<Device>;
  /** Revoking the calling device itself needs `confirmSelf: true`. */
  revoke(id: string, request?: RevokeDeviceRequest): Promise<Device>;
}

export interface DeviceApiOptions {
  /** Absolute server origin (http or https). */
  serverUrl: string;
  /** This device's token; only setup and pair work without one. */
  token?: string | undefined;
  fetch: HttpFetch;
  timeoutMs?: number;
}

export function createDeviceApi(options: DeviceApiOptions): DeviceApi {
  const request = createApiRequest(options);
  const devicePath = (id: string) => `/devices/${encodeURIComponent(id)}`;
  return {
    setup: (body) => request(setupResponseSchema, "POST", "/setup", { auth: false, body }),
    pair: (body) => request(pairResponseSchema, "POST", "/devices/pair", { auth: false, body }),
    invite: () => request(inviteResponseSchema, "POST", "/devices/invite"),
    list: async () => (await request(deviceListResponseSchema, "GET", "/devices")).devices,
    rename: (id, name) => request(deviceSchema, "PATCH", devicePath(id), { body: { name } }),
    revoke: (id, body = {}) => request(deviceSchema, "POST", `${devicePath(id)}/revoke`, { body }),
  };
}

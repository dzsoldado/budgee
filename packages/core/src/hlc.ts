// Hybrid logical clock: `<wall ms, 15 digits>:<counter, 5 digits>:<device id>`.
// Fixed-width numbers make plain string comparison match (wall, counter, device) order.

const WALL_DIGITS = 15;
const COUNTER_DIGITS = 5;
const MAX_WALL = 10 ** WALL_DIGITS - 1;
const MAX_COUNTER = 10 ** COUNTER_DIGITS - 1;

/** Device ids are part of the hlc text, so they may not contain `:`. */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const HLC_PATTERN = /^(\d{15}):(\d{5}):([A-Za-z0-9_-]{1,64})$/;

export interface HlcParts {
  wall: number;
  counter: number;
  device: string;
}

export function formatHlc({ wall, counter, device }: HlcParts): string {
  if (!Number.isInteger(wall) || wall < 0 || wall > MAX_WALL) {
    throw new RangeError(`hlc wall time out of range: ${wall}`);
  }
  if (!Number.isInteger(counter) || counter < 0 || counter > MAX_COUNTER) {
    throw new RangeError(`hlc counter out of range: ${counter}`);
  }
  if (!DEVICE_ID_PATTERN.test(device)) throw new RangeError(`invalid device id: ${device}`);
  return `${String(wall).padStart(WALL_DIGITS, "0")}:${String(counter).padStart(COUNTER_DIGITS, "0")}:${device}`;
}

export function parseHlc(text: string): HlcParts {
  const match = HLC_PATTERN.exec(text);
  if (!match) throw new SyntaxError(`invalid hlc: ${text}`);
  const [, wall, counter, device] = match as unknown as [string, string, string, string];
  return { wall: Number(wall), counter: Number(counter), device };
}

export function compareHlc(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface HlcClock {
  /** Stamp a local edit: `max(now, last)` plus one on the counter. */
  tick(): string;
  /** Advance past a received row's hlc, so the next local edit sorts after it. */
  receive(remote: string): string;
  /** The latest value issued or adopted, for persisting; undefined before the first one. */
  last(): string | undefined;
}

/**
 * `now` returns wall time in ms. `last` restores a persisted clock value (its wall time and
 * counter are kept; its device part is ignored).
 */
export function createClock(
  deviceId: string,
  now: () => number = Date.now,
  last?: string,
): HlcClock {
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new RangeError(`invalid device id: ${deviceId}`);
  const restored = last === undefined ? undefined : parseHlc(last);
  let wall = restored?.wall ?? 0;
  let counter = restored?.counter ?? 0;
  let current = last;

  const commit = (nextWall: number, nextCounter: number) => {
    // Counter overflow carries into the wall time, which keeps the clock monotonic.
    if (nextCounter > MAX_COUNTER) {
      nextWall += 1;
      nextCounter = 0;
    }
    current = formatHlc({ wall: nextWall, counter: nextCounter, device: deviceId });
    wall = nextWall;
    counter = nextCounter;
    return current;
  };

  return {
    tick() {
      const physical = Math.floor(now());
      return physical > wall ? commit(physical, 0) : commit(wall, counter + 1);
    },
    receive(remote) {
      const r = parseHlc(remote);
      const physical = Math.floor(now());
      const next = Math.max(physical, wall, r.wall);
      if (next === wall && next === r.wall) return commit(next, Math.max(counter, r.counter) + 1);
      if (next === wall) return commit(next, counter + 1);
      if (next === r.wall) return commit(next, r.counter + 1);
      return commit(next, 0);
    },
    last: () => current,
  };
}

/**
 * How far ahead of local time a received hlc may pull the local clock. A row from a device whose
 * clock is days fast still wins by its hlc, but adopting its wall time would stamp every later
 * edit here days into the future; past this cap the clock follows only up to now + 24 hours.
 * The cost: until real time catches up, a local edit of that one row sorts below it and loses.
 */
export const MAX_CLOCK_DRIFT_MS = 24 * 60 * 60 * 1000;

/** `remote`, or when its wall time is more than MAX_CLOCK_DRIFT_MS past `now`, an hlc at that cap. */
export function capClockDrift(remote: string, now: number): string {
  const parts = parseHlc(remote);
  const limit = Math.floor(now) + MAX_CLOCK_DRIFT_MS;
  return parts.wall <= limit
    ? remote
    : formatHlc({ wall: limit, counter: 0, device: parts.device });
}

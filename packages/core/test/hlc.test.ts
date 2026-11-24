import { describe, expect, test } from "bun:test";
import { compareHlc, createClock, formatHlc, parseHlc } from "../src/hlc";

/** A controllable wall clock for tests. */
function fakeNow(start: number) {
  let t = start;
  const now = () => t;
  return {
    now,
    set: (ms: number) => {
      t = ms;
    },
  };
}

describe("format and parse", () => {
  test("pads wall time to 15 digits and the counter to 5", () => {
    expect(formatHlc({ wall: 1762250000000, counter: 3, device: "a1b2c3" })).toBe(
      "001762250000000:00003:a1b2c3",
    );
  });

  test("parse inverts format", () => {
    const parts = { wall: 1762250000000, counter: 42, device: "dev-1" };
    expect(parseHlc(formatHlc(parts))).toEqual(parts);
  });

  test("rejects malformed text", () => {
    for (const bad of [
      "",
      "1762250000000:00003:a1b2c3", // wall not padded
      "001762250000000:3:a1b2c3", // counter not padded
      "001762250000000:00003:", // no device
      "001762250000000:00003:a:b", // ':' inside device id
      "00176225000000x:00003:a1b2c3",
    ]) {
      expect(() => parseHlc(bad)).toThrow();
    }
  });

  test("rejects out-of-range parts", () => {
    expect(() => formatHlc({ wall: 10 ** 15, counter: 0, device: "d" })).toThrow();
    expect(() => formatHlc({ wall: -1, counter: 0, device: "d" })).toThrow();
    expect(() => formatHlc({ wall: 0, counter: 100000, device: "d" })).toThrow();
    expect(() => formatHlc({ wall: 1.5, counter: 0, device: "d" })).toThrow();
    expect(() => formatHlc({ wall: 0, counter: 0, device: "" })).toThrow();
  });
});

describe("ordering as text", () => {
  test("plain string comparison matches (wall, counter, device) order", () => {
    const ordered = [
      formatHlc({ wall: 9, counter: 99999, device: "zzz" }),
      formatHlc({ wall: 10, counter: 0, device: "aaa" }),
      formatHlc({ wall: 10, counter: 2, device: "aaa" }),
      formatHlc({ wall: 10, counter: 10, device: "aaa" }),
      formatHlc({ wall: 10, counter: 10, device: "aab" }),
      formatHlc({ wall: 1762250000000, counter: 0, device: "aaa" }),
      formatHlc({ wall: 10 ** 14, counter: 0, device: "aaa" }),
    ];
    const shuffled = [...ordered].reverse();
    expect(shuffled.sort()).toEqual(ordered);
    expect(ordered.toSorted(compareHlc)).toEqual(ordered);
  });

  test("compareHlc returns -1, 0 or 1", () => {
    const a = formatHlc({ wall: 1, counter: 0, device: "a" });
    const b = formatHlc({ wall: 2, counter: 0, device: "a" });
    expect(compareHlc(a, b)).toBe(-1);
    expect(compareHlc(b, a)).toBe(1);
    expect(compareHlc(a, a)).toBe(0);
  });
});

describe("counter increments", () => {
  test("ticks within the same millisecond increment the counter", () => {
    const clock = createClock("dev", () => 5000);
    expect(clock.tick()).toBe("000000000005000:00000:dev");
    expect(clock.tick()).toBe("000000000005000:00001:dev");
    expect(clock.tick()).toBe("000000000005000:00002:dev");
  });

  test("the counter resets when wall time moves forward", () => {
    const time = fakeNow(5000);
    const clock = createClock("dev", time.now);
    clock.tick();
    clock.tick();
    time.set(6000);
    expect(clock.tick()).toBe("000000000006000:00000:dev");
  });

  test("every tick is strictly greater than the previous one", () => {
    const clock = createClock("dev", () => 5000);
    let previous = clock.tick();
    for (let i = 0; i < 1000; i++) {
      const next = clock.tick();
      expect(next > previous).toBe(true);
      previous = next;
    }
  });

  test("counter overflow carries into the wall time and stays monotonic", () => {
    const clock = createClock("dev", () => 5000, "000000000005000:99999:dev");
    const next = clock.tick();
    expect(next).toBe("000000000005001:00000:dev");
    expect(next > "000000000005000:99999:dev").toBe(true);
  });
});

describe("clock skew between devices", () => {
  test("a wall clock going backwards never makes the hlc go backwards", () => {
    const time = fakeNow(10_000);
    const clock = createClock("dev", time.now);
    const before = clock.tick();
    time.set(4_000); // NTP correction, or the user changed the time
    const after = clock.tick();
    expect(after > before).toBe(true);
    expect(parseHlc(after).wall).toBe(10_000);
  });

  test("a device whose clock is behind still orders its edit after a row it has seen", () => {
    const fast = createClock("fast", () => 1_000_000 + 5 * 60_000); // 5 minutes ahead
    const slow = createClock("slow", () => 1_000_000);
    const remote = fast.tick();
    slow.receive(remote);
    const local = slow.tick();
    expect(local > remote).toBe(true);
    expect(parseHlc(local).device).toBe("slow");
  });

  test("receive takes the larger counter when local and remote share the wall time", () => {
    const clock = createClock("b", () => 100, "000000000000100:00007:b");
    clock.receive("000000000000100:00012:a");
    expect(clock.tick()).toBe("000000000000100:00014:b");
  });

  test("receive from a peer in the past leaves the local clock ahead", () => {
    const clock = createClock("b", () => 9_000);
    const mine = clock.tick();
    clock.receive("000000000001000:00050:a");
    const next = clock.tick();
    expect(next > mine).toBe(true);
    expect(parseHlc(next).wall).toBe(9_000);
  });

  test("receive rejects a malformed hlc without changing the clock", () => {
    const clock = createClock("b", () => 9_000);
    const before = clock.tick();
    expect(() => clock.receive("garbage")).toThrow();
    expect(clock.last()).toBe(before);
  });
});

describe("receiving a future timestamp", () => {
  test("the local clock jumps past a remote hlc from the future", () => {
    const now = 1_000_000;
    const future = formatHlc({ wall: now + 3_600_000, counter: 4, device: "a" });
    const clock = createClock("z", () => now);
    clock.receive(future);
    const next = clock.tick();
    expect(next > future).toBe(true);
    expect(parseHlc(next)).toEqual({ wall: now + 3_600_000, counter: 6, device: "z" });
  });

  test("a later tick, once real time passes the future wall, uses real time again", () => {
    const time = fakeNow(1_000);
    const clock = createClock("z", time.now);
    clock.receive("000000000002000:00000:a");
    time.set(3_000);
    expect(clock.tick()).toBe("000000000003000:00000:z");
  });

  test("the local clock beats the remote even when the remote device id sorts higher", () => {
    const clock = createClock("aaa", () => 500);
    const remote = "000000000000500:00000:zzz";
    clock.receive(remote);
    expect(clock.tick() > remote).toBe(true);
  });
});

describe("restoring a persisted clock", () => {
  test("continues after the stored hlc, keeping its own device id", () => {
    const clock = createClock("dev", () => 100, "000000000000900:00003:other");
    expect(clock.last()).toBe("000000000000900:00003:other");
    expect(clock.tick()).toBe("000000000000900:00004:dev");
  });

  test("last() is undefined before any tick and tracks every tick and receive", () => {
    const clock = createClock("dev", () => 100);
    expect(clock.last()).toBeUndefined();
    const t = clock.tick();
    expect(clock.last()).toBe(t);
    const r = clock.receive("000000000000200:00000:x");
    expect(clock.last()).toBe(r);
  });

  test("rejects an invalid device id", () => {
    expect(() => createClock("bad:id", () => 0)).toThrow();
    expect(() => createClock("", () => 0)).toThrow();
  });
});

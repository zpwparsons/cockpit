import { nextTick, reactive, ref } from "vue";
import { beforeEach, describe, expect, it } from "vitest";
import { persist, read } from "./persist";

describe("persist", () => {
  beforeEach(() => localStorage.clear());

  it("reads json or falls back", () => {
    localStorage.setItem("k", JSON.stringify({ a: 1 }));
    expect(read("k", null)).toEqual({ a: 1 });
    expect(read("missing", "x")).toBe("x");
    localStorage.setItem("bad", "{");
    expect(read("bad", 7)).toBe(7);
  });

  it("writes refs and deep changes to reactive objects", async () => {
    const r = ref("a");
    persist("r", r);
    r.value = "b";
    await nextTick();
    expect(localStorage.getItem("r")).toBe('"b"');

    const obj = reactive({ list: [{ n: 1 }] });
    persist("o", obj);
    obj.list[0].n = 2;
    await nextTick();
    expect(read("o", null)).toEqual({ list: [{ n: 2 }] });
  });
});

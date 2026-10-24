// Unit tests for the sandbox image freshness hash.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeImageHash, type ImageInput } from "./imageHash.mts";

const inputs = (): ImageInput[] => [
  { name: "package-lock.json", content: "root" },
  { name: "frontend/package-lock.json", content: "front" },
  { name: "uv.lock", content: "py" },
  { name: ".sandcastle/Dockerfile", content: "FROM node" },
];

/** Pins that same contents hash the same. */
test("same contents hash the same", () => {
  assert.equal(computeImageHash(inputs()), computeImageHash(inputs()));
});

/** Pins that order of the inputs does not matter. */
test("order of the inputs does not matter", () => {
  assert.equal(computeImageHash(inputs()), computeImageHash(inputs().reverse()));
});

/** Pins that changing any one input changes the hash. */
test("changing any one input changes the hash", () => {
  const base = computeImageHash(inputs());
  for (let i = 0; i < 4; i++) {
    const changed = inputs();
    changed[i]!.content += "x";
    assert.notEqual(computeImageHash(changed), base);
  }
});

/** Pins that moving content between files changes the hash. */
test("moving content between files changes the hash", () => {
  const a = [
    { name: "a", content: "xy" },
    { name: "b", content: "z" },
  ];
  const b = [
    { name: "a", content: "x" },
    { name: "b", content: "yz" },
  ];
  assert.notEqual(computeImageHash(a), computeImageHash(b));
});

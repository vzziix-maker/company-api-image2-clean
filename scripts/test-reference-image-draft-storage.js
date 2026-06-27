import assert from "node:assert/strict";

import {
  deserializeReferenceImageSlots,
  serializeReferenceImageSlots,
} from "../src/reference-image-draft-storage.js";

const first = new File(["first"], "first.png", { type: "image/png", lastModified: 1 });
const third = new File(["third"], "third.jpg", { type: "image/jpeg", lastModified: 3 });
const slots = [first, null, third, null, null];

const serialized = serializeReferenceImageSlots(slots);
assert.equal(serialized.length, 5);
assert.equal(serialized[0].name, "first.png");
assert.equal(serialized[1], null);
assert.equal(serialized[2].name, "third.jpg");

const restored = deserializeReferenceImageSlots(serialized, 5);
assert.equal(restored.length, 5);
assert.equal(restored[0].name, "first.png");
assert.equal(restored[1], null);
assert.equal(restored[2].name, "third.jpg");
assert.equal(restored[3], null);
assert.equal(restored[4], null);

console.log("reference image draft storage tests passed");

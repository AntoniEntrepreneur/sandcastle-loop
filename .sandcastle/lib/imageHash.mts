// Sandbox image freshness: a hash of everything the image bakes in.
//
// The image carries project dependencies, so it is stale exactly when a
// lockfile or the Dockerfile changes. The hash is stored as an image label and
// compared with the current one before each run. Pure; main.mts reads the files.

import { createHash } from "node:crypto";

/** One file that feeds the image build. */
export interface ImageInput {
  name: string;
  content: string;
}

/** Repo-relative files whose contents decide whether the image is current. */
export const IMAGE_INPUT_FILES = [
  "package.json",
  "package-lock.json",
  "frontend/package.json",
  "frontend/package-lock.json",
  "pyproject.toml",
  "uv.lock",
  ".sandcastle/Dockerfile",
];

/** Label the image carries its input hash under. */
export const IMAGE_HASH_LABEL = "sandcastle.deps-hash";

/** Hash of the inputs: stable for the same contents, different when any changes. */
export function computeImageHash(inputs: ImageInput[]): string {
  const hash = createHash("sha256");
  for (const { name, content } of [...inputs].sort((a, b) => a.name.localeCompare(b.name))) {
    // Length-prefixed so content cannot be shifted between neighbouring files.
    hash.update(`${name}\0${Buffer.byteLength(content)}\0${content}\0`);
  }
  return hash.digest("hex");
}

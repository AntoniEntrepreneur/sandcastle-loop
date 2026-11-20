// Own sandbox image inspection, input staging, building, and temporary cleanup.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeImageHash, IMAGE_HASH_LABEL, type ImageInput } from "./imageHash.mts";

interface ImageOptions {
  repoCwd: string;
  imageName: string;
  inputFiles: string[];
}

type ImageFreshness = "missing" | "stale" | "current";

/** Capture the configured input bytes under their logical hash names. */
function readInputs(options: ImageOptions): ImageInput[] {
  return options.inputFiles.map((name) => ({
    name,
    content: readFileSync(join(options.repoCwd, name)),
  }));
}

/** Compare the installed image label with the captured input hash. */
function inspectHash(imageName: string, hash: string): ImageFreshness {
  let label: string;
  try {
    label = execFileSync(
      "docker",
      ["image", "inspect", "--format", `{{ index .Config.Labels "${IMAGE_HASH_LABEL}" }}`, imageName],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    return "missing";
  }
  return label === hash ? "current" : "stale";
}

/** Inspect freshness without creating a build context or changing the image. */
export function inspectSandboxImage(options: ImageOptions): ImageFreshness {
  return inspectHash(options.imageName, computeImageHash(readInputs(options)));
}

/** Reuse a matching image or build captured bytes, throwing failures after cleanup. */
export function prepareSandboxImage(options: ImageOptions): "current" | "rebuilt" {
  const inputs = readInputs(options);
  const hash = computeImageHash(inputs);
  if (inspectHash(options.imageName, hash) === "current") return "current";
  const context = mkdtempSync(join(tmpdir(), "sandcastle-image-"));
  try {
    for (const { name, content } of inputs) {
      const target = join(context, name === ".sandcastle/Dockerfile" ? "Dockerfile" : name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const uid = execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
    const gid = execFileSync("id", ["-g"], { encoding: "utf8" }).trim();
    execFileSync(
      "docker",
      [
        "build", "-t", options.imageName, "--label", `${IMAGE_HASH_LABEL}=${hash}`,
        "--build-arg", `AGENT_UID=${uid}`, "--build-arg", `AGENT_GID=${gid}`, context,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 256 * 1024 * 1024,
        // The Dockerfile's cache mounts require BuildKit.
        env: { ...process.env, DOCKER_BUILDKIT: "1" },
      },
    );
    return "rebuilt";
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

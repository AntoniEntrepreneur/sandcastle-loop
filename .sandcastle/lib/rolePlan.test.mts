// Unit tests for the role plan: a command line's role flags in, each role's
// agent out.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGY_MEDIUM_MODEL,
  AGY_LOW_MODEL,
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_LARGE_REVIEW_MODEL,
  CODEX_MODEL,
  formatRoleBanner,
  isNonClaudeLabel,
  rolePlan,
} from "./rolePlan.mts";

/** Pins that a run with no role flags is all-Claude, on the shared effort ladder, spending only Claude's quota. */
test("no role flags gives all-Claude at each role's effort, Claude-only quota and no sign-in mounts", () => {
  const plan = rolePlan({});

  assert.deepEqual(
    [plan.implementer, plan.merger, plan.prWriter].map(({ kind, model, effort, label }) => ({ kind, model, effort, label })),
    [
      { kind: "claude", model: CLAUDE_DEFAULT_MODEL, effort: "medium", label: `${CLAUDE_DEFAULT_MODEL} medium` },
      { kind: "claude", model: CLAUDE_DEFAULT_MODEL, effort: "low", label: `${CLAUDE_DEFAULT_MODEL} low` },
      { kind: "claude", model: CLAUDE_DEFAULT_MODEL, effort: "low", label: `${CLAUDE_DEFAULT_MODEL} low` },
    ],
  );
  assert.equal(plan.reviewer.kind, "claude");
  assert.equal(plan.reviewer.effort, "medium");
  assert.equal(plan.reviewer.model(199).model, CLAUDE_DEFAULT_MODEL);
  assert.equal(plan.reviewer.model(200).model, CLAUDE_LARGE_REVIEW_MODEL);

  assert.deepEqual(plan.quotaProviders, ["claude"]);
  assert.equal(plan.needsAgySignIn, false);
  assert.deepEqual(plan.agyFlags, []);
  assert.equal(plan.needsCodexSignIn, false);
  assert.deepEqual(plan.codexFlags, []);
});

/** Pins what `--implementer agy` plans: Gemini implements, the rest is unchanged. */
test("--implementer agy gives the implementer gemini-3.8-flash-medium, Gemini quota and sign-in mounts", () => {
  const plan = rolePlan({ implementer: "agy" });

  assert.equal(plan.implementer.kind, "agy");
  assert.equal(plan.implementer.model, AGY_MEDIUM_MODEL);
  assert.equal(plan.implementer.label, `${AGY_MEDIUM_MODEL} (agy)`);
  assert.ok(isNonClaudeLabel(plan.implementer.label));

  assert.equal(plan.reviewer.kind, "claude");
  assert.equal(plan.merger.kind, "claude");
  assert.equal(plan.prWriter.kind, "claude");

  assert.deepEqual(plan.quotaProviders, ["claude", "gemini"]);
  assert.equal(plan.needsAgySignIn, true);
  assert.deepEqual(plan.agyFlags, ["--implementer agy"]);
});

/** Pins that an agy reviewer uses medium effort at every diff size. */
test("--reviewer agy alone switches on Gemini quota and sign-in mounts; flash-medium at any diff size", () => {
  const plan = rolePlan({ reviewer: "agy" });

  assert.equal(plan.reviewer.kind, "agy");
  assert.equal(plan.reviewer.model(199).model, AGY_MEDIUM_MODEL);
  assert.equal(plan.reviewer.model(200).model, AGY_MEDIUM_MODEL);

  assert.equal(plan.implementer.kind, "claude");
  assert.equal(plan.merger.kind, "claude");
  assert.equal(plan.prWriter.kind, "claude");

  assert.deepEqual(plan.quotaProviders, ["claude", "gemini"]);
  assert.equal(plan.needsAgySignIn, true);
  assert.deepEqual(plan.agyFlags, ["--reviewer agy"]);
});

/** Pins that --merger agy alone uses flash-low (#804). */
test("--merger agy alone switches on Gemini quota and sign-in mounts and gives the merger flash-low", () => {
  const plan = rolePlan({ merger: "agy" });

  assert.equal(plan.merger.kind, "agy");
  assert.equal(plan.merger.model, AGY_LOW_MODEL);
  assert.equal(plan.merger.label, `${AGY_LOW_MODEL} (agy)`);
  assert.ok(isNonClaudeLabel(plan.merger.label));

  assert.equal(plan.implementer.kind, "claude");
  assert.equal(plan.reviewer.kind, "claude");
  assert.equal(plan.prWriter.kind, "claude");

  assert.deepEqual(plan.quotaProviders, ["claude", "gemini"]);
  assert.equal(plan.needsAgySignIn, true);
  assert.deepEqual(plan.agyFlags, ["--merger agy"]);
});

/** Pins that `--pr-writer agy` uses flash-low (#805). */
test("--pr-writer agy alone switches on Gemini quota and sign-in mounts and gives the PR writer flash-low", () => {
  const plan = rolePlan({ prWriter: "agy" });

  assert.equal(plan.prWriter.kind, "agy");
  assert.equal(plan.prWriter.model, AGY_LOW_MODEL);
  assert.equal(plan.prWriter.label, `${AGY_LOW_MODEL} (agy)`);
  assert.ok(isNonClaudeLabel(plan.prWriter.label));

  assert.equal(plan.implementer.kind, "claude");
  assert.equal(plan.reviewer.kind, "claude");
  assert.equal(plan.merger.kind, "claude");

  assert.deepEqual(plan.quotaProviders, ["claude", "gemini"]);
  assert.equal(plan.needsAgySignIn, true);
  assert.deepEqual(plan.agyFlags, ["--pr-writer agy"]);
});

/** Pins each agy role's model. */
test("an agy reviewer, merger and PR writer each run their fixed agy model", () => {
  const plan = rolePlan({ reviewer: "agy", merger: "agy", prWriter: "agy" });

  assert.equal(plan.reviewer.kind, "agy");
  assert.equal(plan.reviewer.model(199).model, AGY_MEDIUM_MODEL);
  assert.equal(plan.reviewer.model(200).model, AGY_MEDIUM_MODEL);

  for (const role of [plan.merger, plan.prWriter]) {
    assert.equal(role.kind, "agy");
    assert.equal(role.model, AGY_LOW_MODEL);
    assert.equal(role.label, `${AGY_LOW_MODEL} (agy)`);
  }

  assert.equal(plan.implementer.kind, "claude");
  assert.deepEqual(plan.quotaProviders, ["claude", "gemini"]);
  assert.equal(plan.needsAgySignIn, true);
  assert.deepEqual(plan.agyFlags, ["--reviewer agy", "--merger agy", "--pr-writer agy"]);
});

/** Pins that a Claude label is not read as another agent's, so an all-Claude batch prints no by-agent lines. */
test("isNonClaudeLabel reads only an agy or Codex label as non-Claude", () => {
  assert.equal(isNonClaudeLabel(CLAUDE_DEFAULT_MODEL), false);
  assert.equal(isNonClaudeLabel(`${CLAUDE_DEFAULT_MODEL} medium`), false);
  assert.equal(isNonClaudeLabel(undefined), false);
  assert.equal(isNonClaudeLabel(`${AGY_MEDIUM_MODEL} (agy)`), true);
  assert.equal(isNonClaudeLabel(`${CODEX_MODEL.implementer} medium (codex)`), true);
});

/** Pins each Codex role's model and effort: Sol at medium to implement, Luna at low to merge and write the PR. */
test("every role on codex runs its own model at its role's effort, with Codex quota and sign-in", () => {
  const plan = rolePlan({ implementer: "codex", reviewer: "codex", merger: "codex", prWriter: "codex" });

  assert.deepEqual(
    [plan.implementer, plan.merger, plan.prWriter].map(({ kind, model, effort, label }) => ({
      kind,
      model,
      effort,
      label,
    })),
    [
      { kind: "codex", model: "gpt-6.1-sol", effort: "medium", label: "gpt-6.1-sol medium (codex)" },
      { kind: "codex", model: "gpt-6-luna", effort: "low", label: "gpt-6-luna low (codex)" },
      { kind: "codex", model: "gpt-6-luna", effort: "low", label: "gpt-6-luna low (codex)" },
    ],
  );
  assert.equal(plan.reviewer.kind, "codex");
  assert.equal(plan.reviewer.effort, "medium");
  assert.equal(plan.reviewer.model(199).model, "gpt-6.1-sol");
  assert.equal(plan.reviewer.model(200).model, "gpt-6-astra");

  assert.deepEqual(plan.quotaProviders, ["codex"]);
  assert.equal(plan.needsCodexSignIn, true);
  assert.equal(plan.needsAgySignIn, false);
  assert.deepEqual(plan.codexFlags, [
    "--implementer codex",
    "--reviewer codex",
    "--merger codex",
    "--pr-writer codex",
  ]);
});

/** Pins that an all-non-Claude run does not wait for or probe Claude's quota. */
test("an all-non-Claude run gates only the providers its roles use", () => {
  const plan = rolePlan({ implementer: "agy", reviewer: "codex", merger: "agy", prWriter: "codex" });

  assert.deepEqual(plan.quotaProviders, ["gemini", "codex"]);
});

/** Pins that agy and Codex roles mix in one run, each spending its own quota. */
test("an agy role and a Codex role in one run need both sign-ins and all three quotas", () => {
  const plan = rolePlan({ implementer: "codex", reviewer: "agy" });

  assert.equal(plan.implementer.kind, "codex");
  assert.equal(plan.reviewer.kind, "agy");
  assert.equal(plan.reviewer.effort, undefined);
  assert.equal(plan.merger.kind, "claude");
  assert.equal(plan.merger.effort, "low");
  assert.deepEqual(plan.quotaProviders, ["claude", "gemini", "codex"]);
  assert.deepEqual(plan.agyFlags, ["--reviewer agy"]);
  assert.deepEqual(plan.codexFlags, ["--implementer codex"]);
});

/** Pins that the banner names every role's agent and model. */
test("the banner names each role's agent and model", () => {
  const claudeBanner = formatRoleBanner(rolePlan({}));
  assert.match(claudeBanner, /Implementer:\s+claude claude-sonnet-5 \(medium effort\)/);
  assert.match(
    claudeBanner,
    /Reviewer:\s+claude claude-sonnet-5 \(medium effort\) \(under 200 changed lines\) \/ claude-opus-5 \(200 or more\)/,
  );
  assert.match(claudeBanner, /Merger:\s+claude claude-sonnet-5 \(low effort\)/);
  assert.match(claudeBanner, /PR writer:\s+claude claude-sonnet-5 \(low effort\)/);

  const agyBanner = formatRoleBanner(rolePlan({ implementer: "agy", reviewer: "agy" }));
  assert.match(agyBanner, /Implementer:\s+agy gemini-3\.8-flash-medium/);
  assert.match(agyBanner, /Reviewer:\s+agy gemini-3\.8-flash-medium at any diff size/);
  assert.match(agyBanner, /Merger:\s+claude claude-sonnet-5 \(low effort\)/);
  assert.match(agyBanner, /PR writer:\s+claude claude-sonnet-5 \(low effort\)/);

  const codexBanner = formatRoleBanner(rolePlan({ implementer: "codex", reviewer: "codex", prWriter: "codex" }));
  assert.match(codexBanner, /Implementer:\s+codex gpt-6\.1-sol \(medium effort\)/);
  assert.match(
    codexBanner,
    /Reviewer:\s+codex gpt-6\.1-sol \(medium effort\) \(under 200 changed lines\) \/ gpt-6-astra \(200 or more\)/,
  );
  assert.match(codexBanner, /Merger:\s+claude claude-sonnet-5 \(low effort\)/);
  assert.match(codexBanner, /PR writer:\s+codex gpt-6-luna \(low effort\)/);
});

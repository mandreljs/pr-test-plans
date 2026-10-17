import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  PLAN_FORMAT_VERSION,
  isExamplePlan,
  locationMismatches,
  normalizePlan,
  parsePlanRef,
  planPath,
  revisionsPath,
  sortRevisions,
  storageKey,
  toChecklistMarkdown,
  toResultsMarkdown,
  validatePlan,
} from "../lib/plan-format.js";

const examplePath = fileURLToPath(new URL("../plans/examples/weapon-wheel/example.json", import.meta.url));
const example = () => JSON.parse(readFileSync(examplePath, "utf8"));
const cli = fileURLToPath(new URL("../tools/plan.mjs", import.meta.url));

const prPlan = (number, commit, generatedAt) => ({
  ...example(),
  title: `Plan for ${commit}`,
  generatedAt,
  pr: {
    repo: "mandreljs/mandrel.js",
    number,
    url: `https://github.com/mandreljs/mandrel.js/pull/${number}`,
    commit,
  },
});

test("the example plan is valid", () => {
  assert.deepEqual(validatePlan(example()), []);
});

test("missing required fields are each reported", () => {
  const errors = validatePlan({ version: 1, sections: [] });
  for (const field of ["project", "title", "summary", "generatedAt", "sections"]) {
    assert.ok(
      errors.some((e) => e.startsWith(field)),
      `expected an error for ${field}, got ${JSON.stringify(errors)}`
    );
  }
});

test("generatedAt needs a date, a time and a time zone", () => {
  for (const ok of ["2026-10-07T18:04:00Z", "2026-10-07T18:04Z", "2026-10-07T18:04:00.123-05:00"]) {
    assert.deepEqual(validatePlan({ ...example(), generatedAt: ok }), [], ok);
  }
  for (const bad of ["2026-10-07", "2026-10-07T18:04:00", "2026-13-45T99:99:00Z", "yesterday"]) {
    assert.ok(
      validatePlan({ ...example(), generatedAt: bad }).some((e) => e.startsWith("generatedAt")),
      bad
    );
  }
});

test("a test without steps or expected results is invalid", () => {
  const plan = example();
  plan.sections[0].tests[0].steps = [];
  plan.sections[0].tests[0].expected = [""];
  const errors = validatePlan(plan);
  assert.ok(errors.includes("sections[0].tests[0].steps: needs at least one step"));
  assert.ok(errors.includes("sections[0].tests[0].expected: needs at least one expected result"));
});

test("sections can have their own setup, checked like the plan's", () => {
  const plan = example();
  assert.ok(plan.sections[0].setup?.length, "the example should show off section setup");
  plan.sections[1].setup = [{ title: "" }, { title: "Open a second browser", code: "" }];
  plan.sections[0].setup = "Sign in first";
  assert.deepEqual(
    validatePlan(plan).filter((e) => e.includes(".setup")),
    [
      "sections[0].setup: must be an array if given",
      "sections[1].setup[0].title: required",
      "sections[1].setup[1].code: must be a non-empty string if given",
    ]
  );
});

test("non-https links are rejected", () => {
  const plan = example();
  plan.links = [{ label: "Bad", url: "javascript:alert(1)" }];
  plan.preview = { url: "http://example.com" };
  const errors = validatePlan(plan);
  assert.ok(errors.some((e) => e.startsWith("links[0].url")));
  assert.ok(errors.some((e) => e.startsWith("preview.url")));
});

test("a plan from a newer format version gets one clear error", () => {
  const errors = validatePlan({ ...example(), version: PLAN_FORMAT_VERSION + 1 });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /only understands up to version/);
});

test("plan links name one revision or a whole pull request, without path tricks", () => {
  const exact = parsePlanRef("mandrel.js/1234/abc1234");
  assert.equal(exact.id, "mandrel.js/1234/abc1234");
  assert.equal(exact.subjectId, "mandrel.js/1234");
  assert.equal(planPath(exact), "plans/mandrel.js/1234/abc1234.json");
  assert.equal(revisionsPath(exact), "plans/mandrel.js/1234/revisions.json");

  const latest = parsePlanRef("mandrel.js/1234");
  assert.equal(latest.revision, null);
  assert.equal(latest.id, null);
  assert.equal(revisionsPath(latest), "plans/mandrel.js/1234/revisions.json");

  for (const bad of ["", "mandrel.js", "a/b/c/d", "../x", "a/../b", "a/b/..", ".hidden/1", "a/ b", "https://x/y", null]) {
    assert.equal(parsePlanRef(bad), null, String(bad));
  }
});

test("only plans under plans/examples/ count as examples", () => {
  assert.equal(isExamplePlan("examples/weapon-wheel"), true);
  assert.equal(isExamplePlan("examples/weapon-wheel/example-2"), true);
  assert.equal(isExamplePlan("mandrel.js/1234"), false);
  assert.equal(isExamplePlan("mandrel.js/examples/abc1234"), false);
  assert.equal(isExamplePlan("examples-old/1"), false);
  assert.equal(isExamplePlan("../examples/x"), false);
});

test("a plan stored somewhere that doesn't match its pull request is flagged", () => {
  const plan = prPlan(1234, "abc1234def", "2026-10-07T18:00:00Z");
  assert.deepEqual(locationMismatches(parsePlanRef("mandrel.js/1234/abc1234"), plan), []);
  const wrong = locationMismatches(parsePlanRef("other-repo/99/zzz"), plan);
  assert.equal(wrong.length, 3);
  assert.deepEqual(locationMismatches(parsePlanRef("examples/weapon-wheel/example"), example()), []);
});

test("revisions sort newest first by time, across time zones", () => {
  const sorted = sortRevisions([
    { revision: "a", generatedAt: "2026-10-07T10:00:00Z" },
    { revision: "b", generatedAt: "2026-10-07T09:00:00-05:00" }, // 14:00 UTC
    { revision: "c", generatedAt: "2026-10-06T23:00:00Z" },
  ]);
  assert.deepEqual(
    sorted.map((r) => r.revision),
    ["b", "a", "c"]
  );
});

test("each revision keeps its own saved results", () => {
  assert.notEqual(storageKey("mandrel.js/1234/aaaaaaa"), storageKey("mandrel.js/1234/bbbbbbb"));
});

test("tests are numbered T1..Tn across sections in reading order", () => {
  const plan = normalizePlan(example());
  assert.deepEqual(
    plan.tests.map((t) => [t.id, t.title]),
    [
      ["T1", "Scrolling up switches to the next weapon"],
      ["T2", "Scrolling down switches to the previous weapon"],
      ["T3", "The number keys still switch weapons"],
    ]
  );
});

test("copied results summarise, flag failures and keep multi-line notes", () => {
  const plan = normalizePlan(prPlan(1789, "0123456789abcdef", "2026-10-07T18:00:00Z"));
  const md = toResultsMarkdown(
    plan,
    {
      tester: " Sam ",
      env: "Firefox on Linux",
      results: {
        T1: { status: "pass", notes: "" },
        T2: { status: "fail", notes: "Stayed on the shotgun.\n\nOn Firefox." },
      },
    },
    { planUrl: "https://mandreljs.github.io/pr-test-plans/?plan=mandrel.js/1789/0123456", date: "2026-10-07" }
  );
  assert.match(md, /^### 🧪 Manual test results: Plan for 0123456789abcdef/);
  assert.match(
    md,
    /\[Test plan\]\(https:\/\/mandreljs\.github\.io\/pr-test-plans\/\?plan=mandrel\.js\/1789\/0123456\) · mandreljs\/mandrel\.js#1789 · Commit `0123456` · Tested by Sam · Firefox on Linux · 2026-10-07/
  );
  assert.match(md, /\*\*3 tests:\*\* 1 passed · 1 failed · 1 not tested/);
  assert.match(md, /❌ \*\*Failed:\*\* T2/);
  assert.match(md, /- ❌ \*\*T2 · Scrolling down switches to the previous weapon\*\*\n  > Stayed on the shotgun\.\n  >\n  > On Firefox\./);
  assert.match(md, /- ⬜ \*\*T3 · The number keys still switch weapons\*\* \(not tested\)/);
});

test("the checklist lists every test as a task", () => {
  const md = toChecklistMarkdown(normalizePlan(example()));
  assert.equal(md.match(/^- \[ \] /gm).length, 3);
  assert.match(md, /^Open the example game: https:\/\/mandreljs\.github\.io\/mandrel\.js\//);
  assert.match(md, /  First: You need the shotgun from the previous test\./);
  assert.match(
    md,
    /\*\*Switching with the wheel\*\*\n\n_Before these tests:_\n\n1\. \*\*Use a mouse with a scroll wheel\*\* These tests need a mouse wheel\..*\n\n- \[ \] \*\*T1 /
  );
});

test("CLI validate fails on a bad plan and passes on a good one", () => {
  const dir = mkdtempSync(join(tmpdir(), "plans-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ version: 1 }));
  const good = spawnSync(process.execPath, [cli, "validate", examplePath]);
  assert.equal(good.status, 0, good.stderr.toString());
  const res = spawnSync(process.execPath, [cli, "validate", bad]);
  assert.equal(res.status, 1);
  assert.match(res.stderr.toString(), /title: required/);
});

test("CLI index keeps every revision, points each PR at its newest, and skips bad files", () => {
  const dir = mkdtempSync(join(tmpdir(), "plans-"));
  const write = (rel, body) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), typeof body === "string" ? body : JSON.stringify(body));
  };
  write("mandrel.js/1234/aaaaaaa.json", prPlan(1234, "aaaaaaa", "2026-10-01T12:00:00Z"));
  write("mandrel.js/1234/bbbbbbb.json", prPlan(1234, "bbbbbbb", "2026-10-03T12:00:00Z"));
  write("mandrel.js/1300/ccccccc.json", prPlan(1300, "ccccccc", "2026-10-02T12:00:00Z"));
  write("mandrel.js/1300/ddddddd.json", prPlan(1300, "eeeeeee", "2026-10-02T13:00:00Z")); // wrong file name
  write("mandrel.js/1400/broken.json", "{ not json");
  write("mandrel.js/old-layout.json", prPlan(1, "fffffff", "2026-10-02T12:00:00Z"));

  const out = join(dir, "index.json");
  const res = spawnSync(process.execPath, [cli, "index", dir, out]);
  assert.equal(res.status, 0, res.stderr.toString());
  const log = res.stdout.toString();
  assert.match(log, /::warning file=.*broken\.json::Left out of the index/);
  assert.match(log, /::warning file=.*old-layout\.json::Left out of the index: plans must be stored at/);
  assert.match(log, /::warning file=.*ddddddd\.json::Stored in the wrong place\? file name "ddddddd" doesn't match pr\.commit/);

  const { plans } = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(
    plans.map((p) => [p.id, p.latest, p.revisionCount]),
    [
      ["mandrel.js/1234", "mandrel.js/1234/bbbbbbb", 2],
      ["mandrel.js/1300", "mandrel.js/1300/ddddddd", 2],
    ]
  );
  const { revisions } = JSON.parse(readFileSync(join(dir, "mandrel.js/1234/revisions.json"), "utf8"));
  assert.deepEqual(
    revisions.map((r) => r.id),
    ["mandrel.js/1234/bbbbbbb", "mandrel.js/1234/aaaaaaa"]
  );

  // Rebuilding over its own output must not treat revisions.json or index.json as plans.
  const again = spawnSync(process.execPath, [cli, "index", dir, out]);
  assert.equal(again.status, 0);
  assert.doesNotMatch(again.stdout.toString(), /revisions\.json|index\.json::/);
});

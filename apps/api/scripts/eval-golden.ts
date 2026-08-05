#!/usr/bin/env tsx
/**
 * The Sprint 67 CI gate. `npm run eval` fails the build on a broken context
 * invariant, a moved prompt/resolver digest, a metric regression, or an
 * adversarial golden case that stopped failing. `npm run eval:record` accepts
 * the current output as the new expectation — which is how an intentional
 * prompt change gets reviewed in a diff instead of slipping through.
 */
import { checkGolden, loadExpected, runGoldenSuite, writeExpected } from "../src/eval/golden";

const record = process.argv.includes("--record");

const outcome = await runGoldenSuite();

if (record) {
  writeExpected(outcome);
  console.log("Recorded apps/api/eval/golden/expected.json:");
  console.log(`  context digest   ${outcome.contextDigest.slice(0, 16)}…`);
  console.log(`  resolver digest  ${outcome.resolverDigest.slice(0, 16)}…`);
  console.log(
    `  hard checks      ${outcome.metrics.hardCheckPassRate}% passed over ${outcome.metrics.completed} case(s)`,
  );
  if (outcome.invariantFailures.length > 0) {
    console.error("\nRefusing to record with broken invariants:");
    for (const failure of outcome.invariantFailures) console.error(`  ✗ ${failure}`);
    process.exit(1);
  }
  process.exit(0);
}

const { ok, failures } = checkGolden(outcome, loadExpected());

console.log(`Golden eval — ${outcome.metrics.completed}/${outcome.metrics.cases} cases replayed`);
console.log(`  hard checks passed   ${outcome.metrics.hardCheckPassRate}%`);
console.log(`  reject recall        ${outcome.metrics.rejectRecall}%`);
console.log(`  approve pass rate    ${outcome.metrics.approvePassRate}%`);
console.log(`  agreement            ${outcome.metrics.agreementRate}%`);

if (ok) {
  console.log("\n✓ No regression.");
  process.exit(0);
}

console.error(`\n✗ ${failures.length} problem(s):`);
for (const failure of failures) console.error(`  • ${failure}`);
process.exit(1);

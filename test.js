#!/usr/bin/env node
/**
 * =========================================================================
 * TEST SUITE — engine.js
 * =========================================================================
 * Exercises RetirementEngine directly via require('./engine.js') — no
 * browser, no DOM mocking, no build step. Run with:
 *
 *   node test.js
 *
 * Exits 0 if every test passes, 1 if any fail (safe to use in CI). Every
 * expected value below was independently derived — either a hand-worked
 * tax calculation, or a known-good figure confirmed earlier against the
 * live calculator before this test suite existed — not just "whatever the
 * code currently returns," so a regression should actually fail these.
 * =========================================================================
 */

'use strict';

const assert = require('assert');
const engine = require('./engine.js');
const { CONSTANTS } = engine;

// -------------------------------------------------------------------------
// Tiny test runner
// -------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn){
  try {
    fn();
    passed++;
    console.log('  \u2713 ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  \u2717 ' + name);
    console.log('      ' + err.message);
  }
}

function section(title){
  console.log('\n' + title);
}

/** Assert two numbers are within `tolerance` of each other (for float/rounding-sensitive checks). */
function assertApprox(actual, expected, tolerance, message){
  const diff = Math.abs(actual - expected);
  if (diff > tolerance){
    throw new Error(
      (message ? message + ' — ' : '') +
      `expected ~${expected}, got ${actual} (off by ${diff.toFixed(2)}, tolerance ${tolerance})`
    );
  }
}

// A baseline set of projection inputs matching the calculator's own HTML
// defaults, so tests read as "default, but override X" rather than
// repeating every field every time.
const DEFAULT_INPUTS = Object.freeze({
  age: 22,
  retireAge: 60,
  salary0: 75000,
  balance0: 20000,
  inflationRate: 0.03,
  earlyStart: 0.05,
  earlyIncrement: 0.01,
  earlyGrowthSpread: 0.01,
  lateIncrement: 0.02,
  lateCap: 0.25,
  lateGrowthSpread: 0,
  capitalGainSpread: 0.04,
  dividendYield: 0.02,
  swrRate: 0.04,
  taxTreatment: CONSTANTS.TAX_TREATMENT_PRETAX,
  equalizeNetPay: false,
});

function withInputs(overrides){
  return Object.assign({}, DEFAULT_INPUTS, overrides);
}

// =========================================================================
// 401(k) CONTRIBUTION LIMITS
// =========================================================================
section('401(k) contribution limits (employee401kLimitForAge)');

test('under 50 gets the base limit only', () => {
  assert.strictEqual(engine.employee401kLimitForAge(45, 0, 0), 24500);
});

test('50-59 gets the standard catch-up', () => {
  assert.strictEqual(engine.employee401kLimitForAge(50, 0, 0), 32500);
  assert.strictEqual(engine.employee401kLimitForAge(59, 0, 0), 32500);
});

test('60-63 gets the SECURE 2.0 super catch-up (replaces, not stacks with, the standard one)', () => {
  assert.strictEqual(engine.employee401kLimitForAge(60, 0, 0), 35750);
  assert.strictEqual(engine.employee401kLimitForAge(63, 0, 0), 35750);
});

test('64+ reverts to the standard catch-up', () => {
  assert.strictEqual(engine.employee401kLimitForAge(64, 0, 0), 32500);
  assert.strictEqual(engine.employee401kLimitForAge(70, 0, 0), 32500);
});

test('limit inflates correctly over time', () => {
  const tenYearsOut = engine.employee401kLimitForAge(30, 10, 0.03);
  assertApprox(tenYearsOut, 24500 * Math.pow(1.03, 10), 1);
});

// =========================================================================
// FEDERAL INCOME TAX
// =========================================================================
section('Federal income tax (estimateFederalTax)');

test('$100,000 salary, single filer, 2026 brackets — known reference figure', () => {
  // Hand-verified against 2026 IRS single-filer brackets + $16,100 standard
  // deduction: taxable income $83,900, walking the brackets gives $13,170.
  assertApprox(engine.estimateFederalTax(100000, 0, 0), 13170, 1);
});

test('income at or below the standard deduction owes zero', () => {
  assert.strictEqual(engine.estimateFederalTax(15000, 0, 0), 0);
  assert.strictEqual(engine.estimateFederalTax(0, 0, 0), 0);
});

test('tax scales with inflated brackets: same real income, same real tax, at any horizon', () => {
  const inflation = 0.03;
  const years = 10;
  const factor = Math.pow(1 + inflation, years);
  const taxToday = engine.estimateFederalTax(100000, 0, inflation);
  const taxInflatedEquivalent = engine.estimateFederalTax(100000 * factor, years, inflation);
  // Same tax RATE on equivalent real income, so tax amount should also scale by `factor`.
  assertApprox(taxInflatedEquivalent, taxToday * factor, 1);
});

// =========================================================================
// FICA
// =========================================================================
section('FICA (estimateFicaTax)');

test('under the Social Security wage base: 6.2% + 1.45% on full salary', () => {
  assertApprox(engine.estimateFicaTax(75000, 0, 0), 75000 * (0.062 + 0.0145), 0.01);
});

test('above the SS wage base but below the additional-Medicare threshold: SS caps, Medicare does not', () => {
  const wageBase = CONSTANTS.FICA_SS_WAGE_BASE_2026;
  const salary = wageBase + 10000; // stays under the $200k additional-Medicare threshold, isolating just the SS cap
  const expected = wageBase * 0.062 + salary * 0.0145;
  assertApprox(engine.estimateFicaTax(salary, 0, 0), expected, 0.01);
});

test('above the additional Medicare threshold: extra 0.9% kicks in on the excess', () => {
  const threshold = CONSTANTS.FICA_ADDL_MEDICARE_THRESHOLD_2026;
  const salary = threshold + 50000;
  const wageBase = CONSTANTS.FICA_SS_WAGE_BASE_2026;
  const expected = Math.min(salary, wageBase) * 0.062 + salary * 0.0145 + 50000 * 0.009;
  assertApprox(engine.estimateFicaTax(salary, 0, 0), expected, 0.01);
});

// =========================================================================
// CAPITAL GAINS & NIIT
// =========================================================================
section('Capital gains tax + NIIT (estimateCapitalGainsTax, estimateNiit)');

test('LTCG on a $600,000 gain, single filer — known reference figure', () => {
  // $600,000 - $16,100 deduction = $583,900 taxable.
  // 0% up to $49,450 (=$0), 15% up to $545,500 (=$496,050*0.15=$74,407.50),
  // 20% on the remaining $38,400 (=$7,680). Total ~$82,087.50.
  assertApprox(engine.estimateCapitalGainsTax(600000, 0, 0), 82087.5, 1);
});

test('gain fully inside the 0% bracket owes nothing', () => {
  assert.strictEqual(engine.estimateCapitalGainsTax(40000, 0, 0), 0);
});

test('NIIT: 3.8% of the amount MAGI exceeds $200,000', () => {
  assertApprox(engine.estimateNiit(250000, 0), 1900, 0.01); // 3.8% of $50,000
});

test('NIIT: nothing owed below the threshold', () => {
  assert.strictEqual(engine.estimateNiit(150000, 0), 0);
});

test('NIIT threshold is NOT inflation-adjusted (fixed by statute since 2013)', () => {
  // Passing a large yearsFromNow has no effect since estimateNiit doesn't
  // take an inflation parameter at all — this documents that omission is
  // intentional, not a missing feature.
  assert.strictEqual(engine.estimateNiit.length, 2); // (netInvestmentIncome, otherMagi) only
});

// =========================================================================
// QUALIFIED DIVIDEND TAX (stacked on ordinary income)
// =========================================================================
section('Qualified dividend tax (estimateQualifiedDividendTax)');

test('dividends stacking on top of substantial ordinary income are NOT eligible for the 0% band', () => {
  // $100,000 of ordinary income already exceeds the $49,450 0% LTCG threshold,
  // so $10,000 of dividends stacked on top should be taxed at 15%. Kept both
  // total well under $200,000 so NIIT stays at zero — isolates the bracket
  // stacking behavior specifically, without a second tax mechanism mixed in.
  const tax = engine.estimateQualifiedDividendTax(10000, 100000, 0, 0);
  assertApprox(tax, 10000 * 0.15, 1);
});

test('dividends stacking on top of zero ordinary income DO get the 0% band', () => {
  const tax = engine.estimateQualifiedDividendTax(30000, 0, 0, 0);
  assert.strictEqual(tax, 0); // fully inside the $49,450 0% bracket
});

test('zero or negative dividend income owes zero tax', () => {
  assert.strictEqual(engine.estimateQualifiedDividendTax(0, 50000, 0, 0), 0);
  assert.strictEqual(engine.estimateQualifiedDividendTax(-100, 50000, 0, 0), 0);
});

test('dividend tax includes NIIT once combined income crosses $200,000 MAGI', () => {
  // $200,000 ordinary + $10,000 dividends = $210,000 MAGI, $10,000 over the
  // threshold. LTCG: fully in the 15% band (stacks above ordinary income) = $1,500.
  // NIIT: 3.8% of min($10,000 dividend income, $10,000 excess) = $380. Total $1,880.
  const tax = engine.estimateQualifiedDividendTax(10000, 200000, 0, 0);
  assertApprox(tax, 1500 + 380, 1);
});

// =========================================================================
// SAVINGS RATE & SALARY GROWTH SCHEDULE
// =========================================================================
section('Savings rate schedule (savingsRateForAge)');

test('starts at the early rate at PHASE_START', () => {
  const rate = engine.savingsRateForAge(22, 0.05, 0.01, 0.02, 0.25);
  assertApprox(rate, 0.05, 1e-9);
});

test('rises by the early increment each year before PHASE_SPLIT', () => {
  const rate = engine.savingsRateForAge(34, 0.05, 0.01, 0.02, 0.25);
  assertApprox(rate, 0.05 + 12 * 0.01, 1e-9); // 17%
});

test('switches to the late increment exactly at PHASE_SPLIT', () => {
  const rate = engine.savingsRateForAge(35, 0.05, 0.01, 0.02, 0.25);
  assertApprox(rate, 0.18, 1e-9); // 5% + 13*1%
});

test('caps at the late-career ceiling and does not exceed it', () => {
  const rate = engine.savingsRateForAge(60, 0.05, 0.01, 0.02, 0.25);
  assertApprox(rate, 0.25, 1e-9);
});

test('salaryGrowthForAge switches at PHASE_SPLIT', () => {
  assert.strictEqual(engine.salaryGrowthForAge(34, 0.05, 0.02), 0.05);
  assert.strictEqual(engine.salaryGrowthForAge(35, 0.05, 0.02), 0.02);
});

// =========================================================================
// FULL PROJECTION — INTEGRATION TESTS
// =========================================================================
section('runProjection — default scenario, each contribution type');

test('Pre-tax (Traditional): known reference outcome', () => {
  const result = engine.runProjection(withInputs({ taxTreatment: CONSTANTS.TAX_TREATMENT_PRETAX }));
  assertApprox(result.final, 5858100, 500);
  assertApprox(result.swrIncomeNet, 209923, 50);
  assertApprox(result.swrPctOfFinalSalary, 136, 1);
});

test('Roth: same balance as Pre-tax (same capped contribution), but tax-free withdrawal beats it', () => {
  const pretax = engine.runProjection(withInputs({ taxTreatment: CONSTANTS.TAX_TREATMENT_PRETAX }));
  const roth = engine.runProjection(withInputs({ taxTreatment: CONSTANTS.TAX_TREATMENT_ROTH }));
  assertApprox(roth.final, pretax.final, 1); // identical contribution schedule when not equalized
  assert.strictEqual(roth.swrTax, 0); // Roth withdrawals are always tax-free
  assert.ok(roth.swrIncomeNet > pretax.swrIncomeNet, 'Roth net income should exceed Pre-tax at identical balance');
  assertApprox(roth.final, 5858100, 500);
  assertApprox(roth.swrIncomeNet, 234324, 50);
});

test('Taxable: known reference outcome, and its final balance sits below Pre-tax/Roth (dividend tax drag)', () => {
  const result = engine.runProjection(withInputs({ taxTreatment: CONSTANTS.TAX_TREATMENT_TAXABLE }));
  assertApprox(result.final, 5488504, 500);
  assertApprox(result.swrIncomeNet, 219540, 50);
  assert.ok(result.final < 5858100, 'dividend tax drag should leave Taxable below Pre-tax/Roth');
});

test('Taxable, equalized: contribution and balance shrink relative to non-equalized', () => {
  const notEqualized = engine.runProjection(withInputs({ taxTreatment: CONSTANTS.TAX_TREATMENT_TAXABLE, equalizeNetPay: false }));
  const equalized = engine.runProjection(withInputs({ taxTreatment: CONSTANTS.TAX_TREATMENT_TAXABLE, equalizeNetPay: true }));
  assert.ok(equalized.yearRows[0].contribution < notEqualized.yearRows[0].contribution);
  assert.ok(equalized.final < notEqualized.final);
  assertApprox(equalized.final, 4421030, 1000);
  assertApprox(equalized.swrIncomeNet, 176841, 100);
});

test('Equalize net pay never changes Pre-tax (it is always the reference point)', () => {
  const off = engine.runProjection(withInputs({ taxTreatment: CONSTANTS.TAX_TREATMENT_PRETAX, equalizeNetPay: false }));
  const on = engine.runProjection(withInputs({ taxTreatment: CONSTANTS.TAX_TREATMENT_PRETAX, equalizeNetPay: true }));
  assert.strictEqual(off.final, on.final);
  assert.strictEqual(off.swrIncomeNet, on.swrIncomeNet);
});

section('runProjection — 401(k) cap interaction (high earner)');

test('a savings rate that would exceed the 401(k) limit gets clipped for Pre-tax', () => {
  const result = engine.runProjection(withInputs({
    salary0: 300000, earlyStart: 0.40, earlyIncrement: 0, lateIncrement: 0, lateCap: 0.40,
    taxTreatment: CONSTANTS.TAX_TREATMENT_PRETAX,
  }));
  // 40% of $300,000 = $120,000, far above the $24,500 base limit.
  assertApprox(result.yearRows[0].contribution, 24500, 1);
});

test('Roth (not equalized) shares the same 401(k) cap as Pre-tax', () => {
  const result = engine.runProjection(withInputs({
    salary0: 300000, earlyStart: 0.40, earlyIncrement: 0, lateIncrement: 0, lateCap: 0.40,
    taxTreatment: CONSTANTS.TAX_TREATMENT_ROTH, equalizeNetPay: false,
  }));
  assertApprox(result.yearRows[0].contribution, 24500, 1);
});

test('Taxable is NOT subject to the 401(k) cap — full schedule applies', () => {
  const result = engine.runProjection(withInputs({
    salary0: 300000, earlyStart: 0.40, earlyIncrement: 0, lateIncrement: 0, lateCap: 0.40,
    taxTreatment: CONSTANTS.TAX_TREATMENT_TAXABLE, equalizeNetPay: false,
  }));
  assertApprox(result.yearRows[0].contribution, 120000, 1);
});

test('the 401(k) catch-up correctly raises the cap at exactly age 50', () => {
  const result = engine.runProjection(withInputs({
    salary0: 300000, earlyStart: 0.40, earlyIncrement: 0, lateIncrement: 0, lateCap: 0.40,
    inflationRate: 0, // isolate the age-tier jump from inflation growth
    taxTreatment: CONSTANTS.TAX_TREATMENT_PRETAX,
  }));
  const at49 = result.yearRows.find(r => r.age === 49);
  const at50 = result.yearRows.find(r => r.age === 50);
  assertApprox(at49.contribution, 24500, 1);
  assertApprox(at50.contribution, 32500, 1);
});

section('runProjection — cost of buying a day/month of final salary');

test('cost to buy 1 day, known reference figure at the default scenario', () => {
  const result = engine.runProjection(DEFAULT_INPUTS);
  const first = result.yearRows[0];
  assertApprox(first.costToBuyOneDay, 658, 5);
});

test('cost to buy 1 month is exactly 365/12 times the cost to buy 1 day, for the same row', () => {
  const result = engine.runProjection(DEFAULT_INPUTS);
  result.yearRows.forEach(row => {
    assertApprox(row.costToBuyOneMonth, row.costToBuyOneDay * (365 / 12), 1);
  });
});

test('cost rises monotonically as retirement approaches (less time left to compound)', () => {
  const result = engine.runProjection(DEFAULT_INPUTS);
  for (let i = 1; i < result.yearRows.length; i++){
    assert.ok(
      result.yearRows[i].costToBuyOneDay > result.yearRows[i - 1].costToBuyOneDay,
      `expected cost to rise from age ${result.yearRows[i-1].age} to ${result.yearRows[i].age}`
    );
  }
});

test('the final working year costs meaningfully more than the first (illustrates time-in-market)', () => {
  const result = engine.runProjection(DEFAULT_INPUTS);
  const first = result.yearRows[0];
  const last = result.yearRows[result.yearRows.length - 1];
  assert.ok(last.costToBuyOneDay > first.costToBuyOneDay * 10, 'expected at least a 10x gap between first and last working year');
});

test('the first row\'s real (today\'s-dollars) cost equals its nominal cost (zero years of inflation to strip out)', () => {
  const result = engine.runProjection(DEFAULT_INPUTS);
  const first = result.yearRows[0];
  assertApprox(first.costToBuyOneDayReal, first.costToBuyOneDay, 1e-6);
});

test('later rows\' real cost is strictly less than their nominal cost (inflation has been stripped out)', () => {
  const result = engine.runProjection(DEFAULT_INPUTS);
  const last = result.yearRows[result.yearRows.length - 1];
  assert.ok(last.costToBuyOneDayReal < last.costToBuyOneDay);
});

test('real (today\'s-dollars) cost still rises with age, but by less than the nominal comparison suggests', () => {
  const result = engine.runProjection(DEFAULT_INPUTS);
  const first = result.yearRows[0];
  const last = result.yearRows[result.yearRows.length - 1];
  const nominalMultiple = last.costToBuyOneDay / first.costToBuyOneDay;
  const realMultiple = last.costToBuyOneDayReal / first.costToBuyOneDayReal;
  assert.ok(realMultiple > 1, 'time-in-market effect should still show up in real terms');
  assert.ok(realMultiple < nominalMultiple, 'real multiple should be smaller than the inflation-inflated nominal multiple');
  // Known reference figures at the default scenario: ~8.1x real vs ~24.3x nominal.
  assertApprox(realMultiple, 8.1, 0.2);
  assertApprox(nominalMultiple, 24.3, 0.5);
});

section('runProjection — configurable SWR rate');

test('SWR gross income scales exactly with swrRate (same balance, different withdrawal %)', () => {
  const at4pct = engine.runProjection(withInputs({ swrRate: 0.04 }));
  const at6pct = engine.runProjection(withInputs({ swrRate: 0.06 }));
  // Same accumulation inputs, so final balance should be identical...
  assertApprox(at4pct.final, at6pct.final, 1);
  // ...but gross SWR income should scale exactly with the rate (6% / 4% = 1.5x).
  assertApprox(at6pct.swrIncomeGross, at4pct.swrIncomeGross * 1.5, 1);
});

test('omitting swrRate falls back to the documented 4% default', () => {
  const inputsWithoutSwrRate = Object.assign({}, DEFAULT_INPUTS);
  delete inputsWithoutSwrRate.swrRate;
  const result = engine.runProjection(inputsWithoutSwrRate);
  assertApprox(result.swrRate, CONSTANTS.SWR_RATE, 1e-9);
  assertApprox(result.swrIncomeGross, result.final * CONSTANTS.SWR_RATE, 1);
});

test('the actual swrRate used is echoed back on the result object', () => {
  const result = engine.runProjection(withInputs({ swrRate: 0.055 }));
  assertApprox(result.swrRate, 0.055, 1e-9);
});

section('runProjection — salary in today\'s dollars (salaryReal)');

test('first row\'s real salary equals nominal (zero years of inflation elapsed)', () => {
  const result = engine.runProjection(DEFAULT_INPUTS);
  const first = result.yearRows[0];
  assertApprox(first.salaryReal, first.salary, 1e-6);
});

test('later rows\' real salary is strictly less than nominal (inflation stripped out)', () => {
  const result = engine.runProjection(DEFAULT_INPUTS);
  const last = result.yearRows[result.yearRows.length - 1];
  assert.ok(last.salaryReal < last.salary);
});

test('real salary matches direct deflation of nominal salary by elapsed inflation', () => {
  const result = engine.runProjection(DEFAULT_INPUTS);
  const row = result.yearRows.find(r => r.age === 40);
  const yearsElapsed = 40 - DEFAULT_INPUTS.age;
  const expected = row.salary / Math.pow(1 + DEFAULT_INPUTS.inflationRate, yearsElapsed);
  assertApprox(row.salaryReal, expected, 0.01);
});

section('runProjection — structural invariants');

test('% of pot column always sums to 100% across all years', () => {
  const result = engine.runProjection(DEFAULT_INPUTS);
  const total = result.yearRows.reduce((sum, r) => sum + r.pctOfPot, 0);
  assertApprox(total, 100, 0.01);
});

test('peakRow really is the row with the maximum future value', () => {
  const result = engine.runProjection(DEFAULT_INPUTS);
  const maxFv = Math.max(...result.yearRows.map(r => r.futureValue));
  assertApprox(result.peakRow.futureValue, maxFv, 0.01);
});

test('yearRows has exactly (retireAge - age) entries', () => {
  const result = engine.runProjection(DEFAULT_INPUTS);
  assert.strictEqual(result.yearRows.length, DEFAULT_INPUTS.retireAge - DEFAULT_INPUTS.age);
});

test('retireAge <= age is corrected to a single-year projection, not a crash', () => {
  const result = engine.runProjection(withInputs({ age: 60, retireAge: 60 }));
  assert.strictEqual(result.yearRows.length, 1);
});

test('dividend yield never affects Pre-tax or Roth balances (only Taxable pays the tax drag)', () => {
  const noDividend = engine.runProjection(withInputs({ dividendYield: 0, taxTreatment: CONSTANTS.TAX_TREATMENT_PRETAX }));
  const withDividend = engine.runProjection(withInputs({ dividendYield: 0.05, taxTreatment: CONSTANTS.TAX_TREATMENT_PRETAX }));
  // Raising dividend yield DOES change Pre-tax's balance (it's additive to total
  // return), but should do so identically to raising capital gain by the same
  // amount — i.e. Pre-tax has no dividend-specific tax drag at all.
  const equivalentCapGain = engine.runProjection(withInputs({
    dividendYield: 0, capitalGainSpread: DEFAULT_INPUTS.capitalGainSpread + 0.05,
    taxTreatment: CONSTANTS.TAX_TREATMENT_PRETAX,
  }));
  assertApprox(withDividend.final, equivalentCapGain.final, 1);
});

// =========================================================================
// SUMMARY
// =========================================================================

console.log('\n' + '-'.repeat(60));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0){
  console.log('\nFailed tests:');
  failures.forEach(({ name, err }) => console.log('  - ' + name + ': ' + err.message));
  process.exit(1);
} else {
  console.log('All tests passed.');
  process.exit(0);
}

/**
 * =======================================================================
 * RETIREMENT PROJECTION ENGINE
 * =======================================================================
 * This file is pure calculation logic: no `document`, no DOM reads/writes,
 * no Chart.js, nothing UI-related. Every function here is a plain function
 * of its arguments — same inputs always produce the same outputs, with no
 * hidden state.
 *
 * If you're reviewing the tax/investment math, this is the only file you
 * need to read. It has no dependency on index.html or the browser at all —
 * you can run it directly in Node (`node engine.js`, or `require('./engine.js')`
 * from a test file) with zero mocking of document/window/Chart.js required.
 *
 * Loaded by index.html via a plain <script src="engine.js"></script> tag
 * (classic script, not an ES module — this keeps it working when index.html
 * is opened directly via file://, which ES module imports do not reliably
 * support). ui.js, loaded after this file, consumes the RetirementEngine
 * global this file defines.
 *
 * Public surface: the RetirementEngine object at the bottom of this file,
 * primarily its runProjection(inputs) function — see that function's
 * header comment for the full input/output shape.
 * =======================================================================
 */
const RetirementEngine = (function(){
  'use strict';

  // =====================================================================
  // CONSTANTS
  // The single source of truth for every hardcoded value used below.
  // =====================================================================

  // Savings-rate schedule phase boundary (ages).
  const PHASE_START = 22;
  const PHASE_SPLIT = 35;

  // Safe withdrawal rate applied to the final balance at retirement.
  const SWR_RATE = 0.04;

  const MONTHS_PER_YEAR = 12;
  const DAYS_PER_YEAR = 365;

  // 2026 US federal income tax, single filer (IRS Rev. Proc. 2025-32).
  // Estimate only — see the disclaimer rendered above the table in the UI.
  const FEDERAL_STANDARD_DEDUCTION_2026_SINGLE = 16100;
  const FEDERAL_BRACKETS_2026_SINGLE = Object.freeze([
    { rate: 0.10, upTo: 12400 },
    { rate: 0.12, upTo: 50400 },
    { rate: 0.22, upTo: 105700 },
    { rate: 0.24, upTo: 201775 },
    { rate: 0.32, upTo: 256225 },
    { rate: 0.35, upTo: 640600 },
    { rate: 0.37, upTo: Infinity },
  ]);

  // FICA (Social Security + Medicare), 2026 employee-side rates. Applies to
  // gross wages regardless of contribution-type treatment — 401(k)/IRA
  // contributions reduce federal taxable income but not the FICA wage base.
  const FICA_SS_RATE = 0.062;
  const FICA_MEDICARE_RATE = 0.0145;
  const FICA_ADDL_MEDICARE_RATE = 0.009;
  const FICA_SS_WAGE_BASE_2026 = 184500;
  const FICA_ADDL_MEDICARE_THRESHOLD_2026 = 200000; // single filer

  // 2026 long-term capital gains brackets, single filer (IRS Rev. Proc. 2025-32).
  // These thresholds ARE inflation-adjusted each year, same as the ordinary brackets.
  const LTCG_BRACKETS_2026_SINGLE = Object.freeze([
    { rate: 0.00, upTo: 49450 },
    { rate: 0.15, upTo: 545500 },
    { rate: 0.20, upTo: Infinity },
  ]);

  // Net Investment Income Tax (IRC §1411): a flat 3.8% surtax on investment
  // income above this MAGI threshold. Unlike every other threshold here,
  // NIIT's $200,000 (single) threshold is fixed by statute and has never
  // been inflation-indexed since its 2013 enactment — so it is NOT scaled
  // by inflation below, on purpose.
  const NIIT_RATE = 0.038;
  const NIIT_THRESHOLD_SINGLE = 200000;

  // 2026 employee elective deferral limit for 401(k)/403(b) plans (IRC
  // §402(g), per IRS Notice 2025-67), plus catch-ups. Standard catch-up
  // applies at 50+; SECURE 2.0's "super catch-up" replaces it (doesn't
  // stack with it) for anyone who turns 60, 61, 62, or 63 during the year,
  // then reverts to the standard catch-up at 64+. All figures are
  // inflation-adjusted, same as in real life. Applies only to Pre-tax and
  // Roth (both are 401(k)-style employee deferrals); a Taxable brokerage
  // account has no such legal cap.
  const EMPLOYEE_401K_LIMIT_2026 = 24500;
  const CATCHUP_401K_LIMIT_2026 = 8000;
  const CATCHUP_401K_AGE = 50;
  const SUPER_CATCHUP_401K_LIMIT_2026 = 11250;
  const SUPER_CATCHUP_401K_AGE_MIN = 60;
  const SUPER_CATCHUP_401K_AGE_MAX = 63;

  // Contribution-type options.
  const TAX_TREATMENT_PRETAX = 'pretax';
  const TAX_TREATMENT_ROTH = 'roth';
  const TAX_TREATMENT_TAXABLE = 'taxable';

  // =====================================================================
  // SAVINGS RATE & SALARY GROWTH SCHEDULE
  // =====================================================================

  /**
   * Savings rate as a function of age: rises at the "early" increment from
   * a starting rate at PHASE_START through PHASE_SPLIT, then rises at the
   * "late" increment after that, capped.
   */
  function savingsRateForAge(age, earlyStart, earlyIncrement, lateIncrement, lateCap){
    const clampedAge = Math.max(age, PHASE_START);
    if (clampedAge < PHASE_SPLIT){
      return earlyStart + (clampedAge - PHASE_START) * earlyIncrement;
    }
    const rateAtSplit = earlyStart + (PHASE_SPLIT - PHASE_START) * earlyIncrement;
    const lateRate = rateAtSplit + (clampedAge - PHASE_SPLIT) * lateIncrement;
    return Math.min(lateRate, lateCap);
  }

  /** Salary growth rate for a given age — early-career rate before PHASE_SPLIT, late-career after. */
  function salaryGrowthForAge(age, earlyGrowth, lateGrowth){
    return age < PHASE_SPLIT ? earlyGrowth : lateGrowth;
  }

  /**
   * Employee 401(k)/403(b) elective deferral limit for a given age and year,
   * inflation-adjusted. Only meaningful for Pre-tax and Roth contributions.
   */
  function employee401kLimitForAge(age, yearsFromNow, inflationRate){
    const inflationFactor = Math.pow(1 + inflationRate, yearsFromNow);
    const base = EMPLOYEE_401K_LIMIT_2026 * inflationFactor;

    let catchup = 0;
    if (age >= SUPER_CATCHUP_401K_AGE_MIN && age <= SUPER_CATCHUP_401K_AGE_MAX){
      catchup = SUPER_CATCHUP_401K_LIMIT_2026 * inflationFactor; // replaces, doesn't stack with, the standard catch-up
    } else if (age >= CATCHUP_401K_AGE){
      catchup = CATCHUP_401K_LIMIT_2026 * inflationFactor;
    }

    return base + catchup;
  }

  // =====================================================================
  // TAX CALCULATIONS
  // =====================================================================

  /**
   * Tax owed on `amount` dollars of income that sit on top of `baseIncome`
   * dollars already taxed (baseIncome = 0 for a standalone calculation, or
   * a stacked amount for e.g. dividends sitting on top of salary). Shared
   * by every progressive-bracket calculation below so the bracket-walking
   * logic itself is written exactly once.
   */
  function taxOnStackedIncome(brackets, baseIncome, amount, inflationFactor){
    if (amount <= 0) return 0;
    const rangeLow = baseIncome;
    const rangeHigh = baseIncome + amount;
    let tax = 0;
    let prevCap = 0;
    for (const bracket of brackets){
      const cap = bracket.upTo === Infinity ? Infinity : bracket.upTo * inflationFactor;
      const segmentLow = Math.max(rangeLow, prevCap);
      const segmentHigh = Math.min(rangeHigh, cap);
      if (segmentHigh > segmentLow){
        tax += (segmentHigh - segmentLow) * bracket.rate;
      }
      prevCap = cap;
      if (prevCap >= rangeHigh) break;
    }
    return tax;
  }

  function inflatedStandardDeduction(yearsFromNow, inflationRate){
    return FEDERAL_STANDARD_DEDUCTION_2026_SINGLE * Math.pow(1 + inflationRate, yearsFromNow);
  }

  /** Federal ordinary-income tax on `grossSalary`, after the inflation-adjusted standard deduction. */
  function estimateFederalTax(grossSalary, yearsFromNow, inflationRate){
    const inflationFactor = Math.pow(1 + inflationRate, yearsFromNow);
    const taxableIncome = Math.max(grossSalary - inflatedStandardDeduction(yearsFromNow, inflationRate), 0);
    return taxOnStackedIncome(FEDERAL_BRACKETS_2026_SINGLE, 0, taxableIncome, inflationFactor);
  }

  /** FICA (Social Security + Medicare, including the additional Medicare surtax) on `grossSalary`. */
  function estimateFicaTax(grossSalary, yearsFromNow, inflationRate){
    const inflationFactor = Math.pow(1 + inflationRate, yearsFromNow);
    const ssWageBase = FICA_SS_WAGE_BASE_2026 * inflationFactor;
    const addlThreshold = FICA_ADDL_MEDICARE_THRESHOLD_2026 * inflationFactor;

    const socialSecurityTax = Math.min(grossSalary, ssWageBase) * FICA_SS_RATE;
    const medicareTax = grossSalary * FICA_MEDICARE_RATE;
    const additionalMedicareTax = Math.max(grossSalary - addlThreshold, 0) * FICA_ADDL_MEDICARE_RATE;

    return socialSecurityTax + medicareTax + additionalMedicareTax;
  }

  /**
   * Long-term capital gains tax on a realized gain, assuming (as this
   * simplified model does) it's the taxpayer's only income that year — so
   * the standard deduction offsets the gain before the 0/15/20% brackets apply.
   */
  function estimateCapitalGainsTax(realizedGain, yearsFromNow, inflationRate){
    const inflationFactor = Math.pow(1 + inflationRate, yearsFromNow);
    const taxableGain = Math.max(realizedGain - inflatedStandardDeduction(yearsFromNow, inflationRate), 0);
    return taxOnStackedIncome(LTCG_BRACKETS_2026_SINGLE, 0, taxableGain, inflationFactor);
  }

  /** Net Investment Income Tax: 3.8% on the lesser of net investment income or the amount MAGI exceeds the fixed threshold. */
  function estimateNiit(netInvestmentIncome, otherMagi){
    const magi = (otherMagi || 0) + netInvestmentIncome;
    const excessOverThreshold = Math.max(magi - NIIT_THRESHOLD_SINGLE, 0);
    return NIIT_RATE * Math.min(netInvestmentIncome, excessOverThreshold);
  }

  /**
   * Qualified dividends are taxed like long-term capital gains, but during
   * working years they stack on top of ordinary taxable income (salary net
   * of the standard deduction) rather than starting from zero — e.g.
   * someone already in the 22% ordinary bracket doesn't get to use the 0%
   * LTCG band. Applies only to the Taxable (Brokerage) option; Traditional
   * and Roth wrappers shield internal account activity from tax entirely.
   */
  function estimateQualifiedDividendTax(dividendIncome, ordinaryTaxableIncome, yearsFromNow, inflationRate){
    if (dividendIncome <= 0) return 0;
    const inflationFactor = Math.pow(1 + inflationRate, yearsFromNow);
    const ltcgTax = taxOnStackedIncome(LTCG_BRACKETS_2026_SINGLE, ordinaryTaxableIncome, dividendIncome, inflationFactor);
    const niit = estimateNiit(dividendIncome, ordinaryTaxableIncome);
    return ltcgTax + niit;
  }

  // =====================================================================
  // MAIN PROJECTION
  // =====================================================================

  /**
   * Run a full accumulation + withdrawal projection. Pure function: no
   * DOM access, no globals read, no side effects — every input it needs
   * is a field on the `inputs` object.
   *
   * @param {Object} inputs
   * @param {number} inputs.age                 Current age.
   * @param {number} inputs.retireAge            Retirement age (must be > age; caller should clamp).
   * @param {number} inputs.salary0              Current annual gross salary.
   * @param {number} inputs.balance0             Current retirement savings balance.
   * @param {number} inputs.inflationRate        Assumed annual inflation (decimal, e.g. 0.03).
   * @param {number} inputs.earlyStart           Starting savings rate at PHASE_START (decimal).
   * @param {number} inputs.earlyIncrement       Annual savings-rate increase, ages PHASE_START–PHASE_SPLIT (decimal).
   * @param {number} inputs.earlyGrowthSpread    Salary growth over inflation, early career (decimal).
   * @param {number} inputs.lateIncrement        Annual savings-rate increase, PHASE_SPLIT+ (decimal).
   * @param {number} inputs.lateCap              Savings-rate cap (decimal).
   * @param {number} inputs.lateGrowthSpread     Salary growth over inflation, late career (decimal).
   * @param {number} inputs.capitalGainSpread    Capital gain over inflation (decimal).
   * @param {number} inputs.dividendYield        Qualified dividend yield, additive to total return (decimal).
   * @param {number} inputs.swrRate              Safe withdrawal rate applied to the final balance (decimal, e.g. 0.04).
   * @param {string} inputs.taxTreatment         TAX_TREATMENT_PRETAX | TAX_TREATMENT_ROTH | TAX_TREATMENT_TAXABLE.
   * @param {boolean} inputs.equalizeNetPay      If true, Roth/Taxable contribution is solved to match Pre-tax net take-home.
   *
   * @returns {Object} Projection result — see the returned object literal
   *   at the end of this function for the full shape (yearRows, final
   *   balance, SWR income figures, etc).
   */
  function runProjection(inputs){
    const {
      salary0, balance0, inflationRate: inflation,
      earlyStart, earlyIncrement, earlyGrowthSpread,
      lateIncrement, lateCap, lateGrowthSpread,
      capitalGainSpread, dividendYield,
      taxTreatment, equalizeNetPay,
    } = inputs;
    // Defaults to the standard 4% rule if the caller doesn't specify one,
    // so existing callers/tests that predate this parameter still work.
    const swrRate = inputs.swrRate != null ? inputs.swrRate : SWR_RATE;

    const age = inputs.age;
    const retireAge = inputs.retireAge > age ? inputs.retireAge : age + 1;

    // Growth and return inputs are spreads over inflation — add inflation back
    // in to get the nominal rates the projection actually compounds at. This
    // mostly just makes the dollar figures look like real-world (nominal)
    // numbers; it has little effect on rate-based figures like the SWR % or
    // the peak age, since inflation appears in both salary growth and
    // investment return and largely cancels out of those ratios.
    const earlyGrowth = inflation + earlyGrowthSpread;
    const lateGrowth = inflation + lateGrowthSpread;
    // Total nominal return = inflation + capital gain over inflation + qualified
    // dividend yield. Dividend yield is additive — raising it increases total
    // return, it doesn't just reallocate an existing return between buckets.
    const returnRate = inflation + capitalGainSpread + dividendYield;

    const years = retireAge - age;
    const ages = [age];
    const balances = [balance0];
    const cumContrib = [0];
    const cumGrowth = [0];
    const yearRows = [];

    let balance = balance0;
    let salary = salary0;
    let totalContrib = 0;
    let totalGrowth = 0;
    let totalDividendsReinvested = 0; // after-tax dividends that stayed invested — counts toward cost basis
    let finalYearSalary = salary0;
    let finalYearContribution = 0;
    let finalYearRate = 0;

    // What share of a given period's total growth is the dividend portion,
    // vs. capital gain. Well-defined by construction since dividendYield is
    // part of returnRate's own definition above.
    const dividendShareOfReturn = returnRate > 0 ? dividendYield / returnRate : 0;

    for (let y = 1; y <= years; y++){
      const ageThisYear = age + y - 1;
      const rateThisYear = savingsRateForAge(ageThisYear, earlyStart, earlyIncrement, lateIncrement, lateCap);
      const growthRateThisYear = salaryGrowthForAge(ageThisYear, earlyGrowth, lateGrowth);
      const yearsFromNow = ageThisYear - age;

      // Nominal contribution = the savings-rate schedule applied to salary — the
      // "desired" amount before any legal deferral limit is applied.
      const nominalContribution = salary * rateThisYear;
      const contributionLimit401k = employee401kLimitForAge(ageThisYear, yearsFromNow, inflation);
      // What Pre-tax actually contributes: the IRS 401(k) elective deferral limit
      // (base + age-based catch-up, inflation-adjusted) caps this regardless of
      // what the savings-rate schedule would otherwise call for. This capped
      // amount is also the reference point for the "Equalize net pay" toggle,
      // since that's what Pre-tax genuinely does in real life.
      const pretaxContribution = Math.min(nominalContribution, contributionLimit401k);

      const fica = estimateFicaTax(salary, yearsFromNow, inflation);
      const taxPretaxRef = estimateFederalTax(Math.max(salary - pretaxContribution, 0), yearsFromNow, inflation);
      const taxRothRef = estimateFederalTax(salary, yearsFromNow, inflation);

      let contribution, federalTax;
      if (taxTreatment === TAX_TREATMENT_PRETAX){
        contribution = pretaxContribution;
        federalTax = taxPretaxRef;
      } else {
        // Roth and Taxable both contribute after-tax dollars: tax is always on the
        // full salary, independent of the contribution amount. They only diverge
        // from each other at withdrawal time (see the SWR tax calculation below).
        federalTax = taxRothRef;
        if (equalizeNetPay){
          // Solve the contribution so net take-home matches what Pre-tax would
          // give at the same nominal rate. Since this tax doesn't depend on the
          // contribution amount, there's a direct closed-form solution:
          // netPretax = salary - taxPretaxRef - fica - pretaxContribution
          // netThis(C) = salary - taxRothRef - fica - C  =>  C = pretaxContribution - (taxRothRef - taxPretaxRef)
          const equalized = pretaxContribution - (taxRothRef - taxPretaxRef);
          contribution = Math.max(0, Math.min(equalized, salary));
        } else if (taxTreatment === TAX_TREATMENT_ROTH){
          // Roth 401(k)/IRA deferrals share the same combined IRS limit as Traditional.
          contribution = pretaxContribution;
        } else {
          // Taxable (Brokerage) has no IRS deferral limit — the full schedule applies.
          contribution = nominalContribution;
        }
      }
      const actualRate = salary > 0 ? contribution / salary : 0;

      // Savings are actually deposited and compounded monthly: split the year's
      // contribution into equal monthly deposits and grow the balance at the
      // equivalent monthly rate, rather than adding one lump sum at year-end.
      const monthlyContribution = contribution / MONTHS_PER_YEAR;
      const monthlyReturn = Math.pow(1 + returnRate, 1 / MONTHS_PER_YEAR) - 1;
      let growthThisYear = 0;
      let dividendIncomeThisYear = 0;
      for (let m = 0; m < MONTHS_PER_YEAR; m++){
        const growthThisMonth = balance * monthlyReturn;
        balance = balance + growthThisMonth + monthlyContribution;
        growthThisYear += growthThisMonth;
        dividendIncomeThisYear += growthThisMonth * dividendShareOfReturn;
      }

      // Tax drag: in a Taxable (Brokerage) account, qualified dividends are taxed
      // in the year they're received, so only the after-tax portion actually stays
      // invested — the tax leaks out of the compounding rather than deferring like
      // price appreciation does. Traditional and Roth wrappers are unaffected.
      let dividendTaxThisYear = 0;
      if (taxTreatment === TAX_TREATMENT_TAXABLE && dividendIncomeThisYear > 0){
        const ordinaryTaxableIncome = Math.max(salary - inflatedStandardDeduction(yearsFromNow, inflation), 0);
        dividendTaxThisYear = estimateQualifiedDividendTax(dividendIncomeThisYear, ordinaryTaxableIncome, yearsFromNow, inflation);
        balance -= dividendTaxThisYear;
        totalDividendsReinvested += dividendIncomeThisYear - dividendTaxThisYear;
      }

      totalContrib += contribution;
      totalGrowth += growthThisYear - dividendTaxThisYear;

      finalYearSalary = salary;
      finalYearContribution = contribution;
      finalYearRate = actualRate;

      // Future value of this year's contribution alone, compounded at the
      // investment return rate for the remaining years until retirement.
      const yearsToRetirement = retireAge - ageThisYear;
      const contributionFutureValue = contribution * Math.pow(1 + returnRate, yearsToRetirement);

      const netTakeHome = salary - federalTax - fica - contribution;

      yearRows.push({
        age: ageThisYear,
        salary: salary,
        rate: actualRate,
        contribution: contribution,
        futureValue: contributionFutureValue,
        federalTax: federalTax,
        ficaTax: fica,
        netTakeHome: netTakeHome
      });

      salary = salary * (1 + growthRateThisYear);

      ages.push(age + y);
      balances.push(balance);
      cumContrib.push(totalContrib);
      cumGrowth.push(totalGrowth);
    }

    // Safe withdrawal rate applied to the final balance.
    const swrIncomeGross = balance * swrRate;
    const yearsToRetirementTotal = retireAge - age;

    // Pre-tax (Traditional) balances are withdrawn as ordinary taxable income in retirement,
    // taxed with the same inflation-adjusted brackets/deduction, projected out to the
    // retirement year. Roth balances were already taxed going in, so withdrawals are tax-free.
    // Taxable (Brokerage) withdrawals are taxed only on their gain portion, at long-term
    // capital gains rates plus NIIT if applicable.
    let swrTax = 0;
    let swrTaxableGainPortion = 0;
    if (taxTreatment === TAX_TREATMENT_PRETAX){
      swrTax = estimateFederalTax(swrIncomeGross, yearsToRetirementTotal, inflation);
    } else if (taxTreatment === TAX_TREATMENT_TAXABLE){
      // Cost basis = starting balance, everything contributed, and any
      // reinvested dividends (already taxed in the year received, so they
      // shouldn't be taxed again as gain here). Each withdrawal is assumed to
      // carry gain in the same proportion as the account's overall
      // gain-to-balance ratio (a pro-rata realization, not a specific-lot sale).
      const basis = balance0 + totalContrib + totalDividendsReinvested;
      const gainFraction = balance > 0 ? Math.max(0, (balance - basis) / balance) : 0;
      swrTaxableGainPortion = swrIncomeGross * gainFraction;
      const capitalGainsTax = estimateCapitalGainsTax(swrTaxableGainPortion, yearsToRetirementTotal, inflation);
      const niit = estimateNiit(swrTaxableGainPortion);
      swrTax = capitalGainsTax + niit;
    }
    const swrIncomeNet = swrIncomeGross - swrTax;

    // Once retired, you're no longer setting aside the savings-rate portion of pay —
    // compare net retirement income to what you actually took home in your final working year.
    const finalYearNetTakeHome = yearRows.length ? yearRows[yearRows.length - 1].netTakeHome : 0;
    const swrPctOfFinalSalary = finalYearNetTakeHome > 0 ? (swrIncomeNet / finalYearNetTakeHome) * 100 : null;

    let peakRow = null;
    let totalFutureValue = 0;
    for (const row of yearRows){
      totalFutureValue += row.futureValue;
      if (!peakRow || row.futureValue > peakRow.futureValue) peakRow = row;
    }
    for (const row of yearRows){
      row.pctOfPot = totalFutureValue > 0 ? (row.futureValue / totalFutureValue) * 100 : 0;
    }

    // "Cost to buy a day/month of final salary" — the lump sum that, contributed
    // at a given age and compounded at the assumed return, would grow to exactly
    // fund one day's (or one month's) worth of final-salary-equivalent income via
    // the SWR rule. Illustrates time-in-the-market directly: compounding has less
    // time to work in later years, so the same "day" of future income costs more
    // to buy the closer you are to retirement when you buy it.
    const dailyIncomeTarget = finalYearSalary / DAYS_PER_YEAR / swrRate;
    const monthlyIncomeTarget = finalYearSalary / MONTHS_PER_YEAR / swrRate;
    for (const row of yearRows){
      const yearsToRetirementForRow = retireAge - row.age;
      const discountFactor = Math.pow(1 + returnRate, yearsToRetirementForRow);
      row.costToBuyOneDay = dailyIncomeTarget / discountFactor;
      row.costToBuyOneMonth = monthlyIncomeTarget / discountFactor;

      // The nominal figures above are honest about what you'd actually pay in
      // that year's dollars, but they're NOT comparable to each other at a
      // glance: the age-22 figure is (coincidentally) already in today's
      // purchasing power, since it's discounted the full horizon, while the
      // age-59 figure is expressed in age-59 dollars, which have absorbed
      // decades of inflation. Deflate every row back to today's purchasing
      // power (same technique as "Final salary, in today's terms" elsewhere)
      // so the across-age comparison is actually apples-to-apples.
      const yearsFromNowForRow = row.age - age;
      const inflationFactorForRow = Math.pow(1 + inflation, yearsFromNowForRow);
      row.costToBuyOneDayReal = row.costToBuyOneDay / inflationFactorForRow;
      row.costToBuyOneMonthReal = row.costToBuyOneMonth / inflationFactorForRow;
    }

    return {
      ages, balances, cumContrib, cumGrowth, totalContrib, totalGrowth, final: balance, yearRows, peakRow, totalFutureValue,
      finalYearSalary, finalYearContribution, finalYearRate, finalYearNetTakeHome,
      swrRate, swrIncomeGross, swrTax, swrTaxableGainPortion, swrIncomeNet, swrPctOfFinalSalary
    };
  }

  // =====================================================================
  // PUBLIC API
  // =====================================================================

  return Object.freeze({
    CONSTANTS: Object.freeze({
      PHASE_START, PHASE_SPLIT, SWR_RATE, MONTHS_PER_YEAR, DAYS_PER_YEAR,
      FEDERAL_STANDARD_DEDUCTION_2026_SINGLE, FEDERAL_BRACKETS_2026_SINGLE,
      FICA_SS_RATE, FICA_MEDICARE_RATE, FICA_ADDL_MEDICARE_RATE,
      FICA_SS_WAGE_BASE_2026, FICA_ADDL_MEDICARE_THRESHOLD_2026,
      LTCG_BRACKETS_2026_SINGLE, NIIT_RATE, NIIT_THRESHOLD_SINGLE,
      EMPLOYEE_401K_LIMIT_2026, CATCHUP_401K_LIMIT_2026, CATCHUP_401K_AGE,
      SUPER_CATCHUP_401K_LIMIT_2026, SUPER_CATCHUP_401K_AGE_MIN, SUPER_CATCHUP_401K_AGE_MAX,
      TAX_TREATMENT_PRETAX, TAX_TREATMENT_ROTH, TAX_TREATMENT_TAXABLE,
    }),
    savingsRateForAge,
    salaryGrowthForAge,
    employee401kLimitForAge,
    estimateFederalTax,
    estimateFicaTax,
    estimateCapitalGainsTax,
    estimateNiit,
    estimateQualifiedDividendTax,
    runProjection,
  });
})();

// Works as a plain browser <script> (defines the RetirementEngine global
// above) and as a CommonJS module (`require('./engine.js')`) for Node-based
// testing — this line is a no-op in the browser, since `module` is undefined there.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = RetirementEngine;
}


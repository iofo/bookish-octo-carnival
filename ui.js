/**
 * =======================================================================
 * UI LAYER
 * =======================================================================
 * Everything in this file reads the DOM, writes the DOM, or talks to
 * Chart.js. No tax or investment math happens here — every number shown
 * on the page is computed by RetirementEngine (engine.js, loaded before
 * this file) and simply displayed here. If you're reviewing the
 * calculations, you don't need to read this file at all; nothing below
 * changes what gets computed, only how it's shown.
 *
 * Depends on the RetirementEngine global defined by engine.js — this file
 * must be loaded after engine.js in index.html.
 * =======================================================================
 */

// Convenience aliases into the engine's public constants, so this file
// doesn't need "RetirementEngine.CONSTANTS." on every line.
const { TAX_TREATMENT_PRETAX, TAX_TREATMENT_ROTH, TAX_TREATMENT_TAXABLE } = RetirementEngine.CONSTANTS;

// Colors read once from the CSS custom properties in :root, so Chart.js
// (which needs literal color strings, not CSS vars) never duplicates a
// hex value that's already defined in the stylesheet.
const rootStyle = getComputedStyle(document.documentElement);
const readCssVar = (name) => rootStyle.getPropertyValue(name).trim();
const hexToRgba = (hex, alpha) => {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
};
const CHART_FILL_ALPHA = 0.35;
const THEME = {
  teal: readCssVar('--teal'),
  gold: readCssVar('--gold'),
  paperDim: readCssVar('--paper-dim'),
  lineSoft: readCssVar('--line-soft'),
  panel2: readCssVar('--panel-2'),
  line: readCssVar('--line'),
};
THEME.tealFill = hexToRgba(THEME.teal, CHART_FILL_ALPHA);
THEME.goldFill = hexToRgba(THEME.gold, CHART_FILL_ALPHA);

// Shared Chart.js style fragments so the two chart configs below don't
// each redeclare the same font/tooltip styling.
const CHART_MONO_FONT_AXIS = { family: 'IBM Plex Mono', size: 10 };
const CHART_MONO_FONT_AXIS_TITLE = { family: 'IBM Plex Mono', size: 11 };
const CHART_MONO_FONT_TOOLTIP = { family: 'IBM Plex Mono', size: 12 };
const CHART_AXIS_TICK_STYLE = { color: THEME.paperDim, font: CHART_MONO_FONT_AXIS };
const CHART_AXIS_TITLE_STYLE = { color: THEME.paperDim, font: CHART_MONO_FONT_AXIS_TITLE };
const CHART_GRID_STYLE = { color: THEME.lineSoft };
const CHART_TOOLTIP_STYLE = {
  backgroundColor: THEME.panel2,
  borderColor: THEME.line,
  borderWidth: 1,
  titleFont: CHART_MONO_FONT_TOOLTIP,
  bodyFont: CHART_MONO_FONT_TOOLTIP,
};

// =====================================================================
// DOM REFERENCES
// =====================================================================

const els = {
  age: document.getElementById('age'),
  retireAge: document.getElementById('retireAge'),
  salary: document.getElementById('salary'),
  balance: document.getElementById('balance'),
  inflation: document.getElementById('inflation'),
  earlyStartRate: document.getElementById('earlyStartRate'),
  earlyIncrement: document.getElementById('earlyIncrement'),
  earlyGrowth: document.getElementById('earlyGrowth'),
  lateIncrement: document.getElementById('lateIncrement'),
  lateCap: document.getElementById('lateCap'),
  lateGrowth: document.getElementById('lateGrowth'),
  capitalGainRate: document.getElementById('capitalGainRate'),
  dividendYield: document.getElementById('dividendYield'),
  swrRate: document.getElementById('swrRate'),
};
const valEls = {
  age: document.getElementById('val-age'),
  retireAge: document.getElementById('val-retireAge'),
  inflation: document.getElementById('val-inflation'),
  earlyStartRate: document.getElementById('val-earlyStartRate'),
  earlyIncrement: document.getElementById('val-earlyIncrement'),
  earlyGrowth: document.getElementById('val-earlyGrowth'),
  lateIncrement: document.getElementById('val-lateIncrement'),
  lateCap: document.getElementById('val-lateCap'),
  lateGrowth: document.getElementById('val-lateGrowth'),
  capitalGainRate: document.getElementById('val-capitalGainRate'),
  dividendYield: document.getElementById('val-dividendYield'),
  swrRate: document.getElementById('val-swrRate'),
};

// The HTML's own `value="..."` attributes are the single source of truth
// for default values — snapshot them here instead of re-typing the same
// numbers into a separate JS object, so the two never drift apart.
const DEFAULTS = {};
Object.keys(els).forEach((key) => { DEFAULTS[key] = els[key].value; });
const DEFAULT_TAX_TREATMENT = TAX_TREATMENT_PRETAX;
const DEFAULT_EQUALIZE_NET_PAY = false;

// =====================================================================
// SMALL DOM HELPERS
// =====================================================================

const setText = (id, text) => { document.getElementById(id).textContent = text; };
const setHTML = (id, html) => { document.getElementById(id).innerHTML = html; };
const fmtMoney = (n) => '$' + Math.round(n).toLocaleString('en-US');
const fmtPct = (n, decimals = 1) => n.toFixed(decimals) + '%';

// =====================================================================
// APPLICATION STATE
// =====================================================================

let chart = null;
let chartPct = null;
let taxTreatment = DEFAULT_TAX_TREATMENT; // TAX_TREATMENT_PRETAX | TAX_TREATMENT_ROTH | TAX_TREATMENT_TAXABLE
let equalizeNetPay = DEFAULT_EQUALIZE_NET_PAY; // when true, Roth/Taxable contribution is solved to match Pre-tax net take-home
let costUnit = 'day'; // 'day' | 'month' — which "cost of waiting" framing is currently displayed

// =====================================================================
// DOM -> ENGINE ADAPTER
// This is the ONLY place that connects the two layers: read every slider/
// input into a plain object, hand it to the pure engine, get back a plain
// result object. No calculation happens here — just plumbing.
// =====================================================================

function project(){
  let age = parseInt(els.age.value);
  let retireAge = parseInt(els.retireAge.value);
  if (retireAge <= age) retireAge = age + 1;

  return RetirementEngine.runProjection({
    age,
    retireAge,
    salary0: parseFloat(els.salary.value) || 0,
    balance0: parseFloat(els.balance.value) || 0,
    inflationRate: parseFloat(els.inflation.value) / 100,
    earlyStart: parseFloat(els.earlyStartRate.value) / 100,
    earlyIncrement: parseFloat(els.earlyIncrement.value) / 100,
    earlyGrowthSpread: parseFloat(els.earlyGrowth.value) / 100,
    lateIncrement: parseFloat(els.lateIncrement.value) / 100,
    lateCap: parseFloat(els.lateCap.value) / 100,
    lateGrowthSpread: parseFloat(els.lateGrowth.value) / 100,
    capitalGainSpread: parseFloat(els.capitalGainRate.value) / 100,
    dividendYield: parseFloat(els.dividendYield.value) / 100,
    swrRate: parseFloat(els.swrRate.value) / 100,
    taxTreatment,
    equalizeNetPay,
  });
}

// =====================================================================
// RENDER
// =====================================================================

function renderSliderLabels(){
  valEls.age.textContent = els.age.value;
  valEls.retireAge.textContent = els.retireAge.value;
  valEls.inflation.textContent = els.inflation.value + '%';
  valEls.earlyStartRate.textContent = els.earlyStartRate.value + '%';
  valEls.earlyIncrement.textContent = els.earlyIncrement.value + '%';
  valEls.earlyGrowth.textContent = els.earlyGrowth.value + '%';
  valEls.lateIncrement.textContent = els.lateIncrement.value + '%';
  valEls.lateCap.textContent = els.lateCap.value + '%';
  valEls.lateGrowth.textContent = els.lateGrowth.value + '%';
  valEls.capitalGainRate.textContent = els.capitalGainRate.value + '%';
  valEls.dividendYield.textContent = els.dividendYield.value + '%';
  valEls.swrRate.textContent = els.swrRate.value + '%';
}

// Single source of truth for how each contribution type is described at
// withdrawal time, used by both the top summary panel and the detail
// breakdown so the wording can't drift between the two.
function swrTaxTreatmentLabel(){
  if (taxTreatment === TAX_TREATMENT_PRETAX) return 'Ordinary income tax';
  if (taxTreatment === TAX_TREATMENT_TAXABLE) return 'Capital gains tax + NIIT';
  return null; // Roth: withdrawals are tax-free, nothing to label
}

function renderTopStats(data){
  const inflationRate = parseFloat(els.inflation.value) / 100;
  const currentAge = parseInt(els.age.value);
  const retireAgeVal = parseInt(els.retireAge.value);
  const yearsToRetirement = Math.max(retireAgeVal - currentAge, 0);
  const finalSalaryAge = retireAgeVal - 1;
  setText('swr-panel-rate-label', fmtPct(data.swrRate * 100));
  setText('swr-panel-rate-label-2', fmtPct(data.swrRate * 100));
  const yearsElapsedFinalSalary = Math.max(finalSalaryAge - currentAge, 0);

  const realFinalSalary = data.finalYearSalary / Math.pow(1 + inflationRate, yearsElapsedFinalSalary);
  const realSwrIncome = data.swrIncomeNet / Math.pow(1 + inflationRate, yearsToRetirement);
  const realSwrTax = data.swrTax / Math.pow(1 + inflationRate, yearsToRetirement);
  const taxLabel = swrTaxTreatmentLabel();

  setText('stat-start-salary', fmtMoney(parseFloat(els.salary.value) || 0));
  setText('stat-final-salary-real', fmtMoney(realFinalSalary));
  setText('stat-final-salary-nominal-foot', 'Nominal at age ' + finalSalaryAge + ': ' + fmtMoney(data.finalYearSalary));
  setText('stat-swr-real', fmtMoney(realSwrIncome) + '/yr');
  setText('stat-swr-real-foot', 'Net nominal at age ' + retireAgeVal + ': ' + fmtMoney(data.swrIncomeNet) + '/yr');
  setText('stat-swr-real-tax-note', taxLabel
    ? taxLabel + ' removed: ' + fmtMoney(realSwrTax) + '/yr'
    : 'No tax removed — Roth withdrawals are tax-free');

  setText('stat-final', fmtMoney(data.final));
  setText('stat-contrib', fmtMoney(data.totalContrib + (parseFloat(els.balance.value) || 0)));
  setText('stat-growth', fmtMoney(data.totalGrowth));

  if (data.swrPctOfFinalSalary !== null){
    setText('stat-swr-pct', Math.round(data.swrPctOfFinalSalary) + '%');
    const swrTaxLine = taxLabel
      ? taxLabel + ' (est.): ' + fmtMoney(data.swrTax) + '/yr'
      : 'Roth withdrawal: tax-free';
    setHTML('stat-swr-detail',
      'Final salary: ' + fmtMoney(data.finalYearSalary) + '<br>' +
      'Savings rate: ' + fmtPct(data.finalYearRate * 100) + ' (' + fmtMoney(data.finalYearContribution) + ')<br>' +
      'Net take-home (final year): ' + fmtMoney(data.finalYearNetTakeHome) + '<br>' +
      fmtPct(data.swrRate * 100) + ' SWR gross income: ' + fmtMoney(data.swrIncomeGross) + '/yr<br>' +
      swrTaxLine + '<br>' +
      'Net SWR income: ' + fmtMoney(data.swrIncomeNet) + '/yr');
  } else {
    setText('stat-swr-pct', '—');
    setText('stat-swr-detail', 'n/a');
  }
}

function costFieldForUnit(row){
  return costUnit === 'day' ? row.costToBuyOneDay : row.costToBuyOneMonth;
}

// The headline panel uses REAL (today's-purchasing-power) figures rather than
// nominal ones. Nominal figures are individually honest (what you'd actually
// pay in that year's dollars) but not comparable to each other at a glance —
// the age-22 figure happens to already be in today's dollars (discounted the
// full horizon), while a near-retirement figure is expressed in dollars that
// have already absorbed decades of inflation. Deflating every row to today's
// terms is what makes the across-age comparison honest.
function costRealFieldForUnit(row){
  return costUnit === 'day' ? row.costToBuyOneDayReal : row.costToBuyOneMonthReal;
}

function renderTable(data){
  setHTML('year-table-body', data.yearRows.map(row => (
    '<tr>' +
      '<td class="age">' + row.age + '</td>' +
      '<td>' + fmtMoney(row.salary) + '</td>' +
      '<td class="tax">' + fmtMoney(row.federalTax) + '</td>' +
      '<td class="tax">' + fmtMoney(row.ficaTax) + '</td>' +
      '<td>' + fmtPct(row.rate * 100) + '</td>' +
      '<td>' + fmtMoney(row.contribution) + '</td>' +
      '<td class="net">' + fmtMoney(row.netTakeHome) + '</td>' +
      '<td class="fv">' + fmtMoney(row.futureValue) + '</td>' +
      '<td class="pct">' + fmtPct(row.pctOfPot) + '</td>' +
      '<td class="cost">' + fmtMoney(costFieldForUnit(row)) + '</td>' +
    '</tr>'
  )).join(''));

  if (data.peakRow){
    setText('peak-fv', fmtMoney(data.peakRow.futureValue));
    setText('peak-age', data.peakRow.age);
  } else {
    setText('peak-fv', '—');
    setText('peak-age', '—');
  }
}

// "The cost of waiting": pick a handful of reference years spread evenly
// across the working years (not fixed ages, since those may fall outside
// someone's actual career window) and show what it costs, contributed at
// each of those years, to fund one day/month of final salary in retirement.
// Shown in today's dollars (see costRealFieldForUnit above) — the table's
// "Cost: 1 day/month" column stays nominal, matching every other column in
// that table, but is explicitly labeled as such so the two don't look like
// they disagree.
function renderCostPanel(data){
  const unitLabel = costUnit === 'day' ? 'day' : 'month';
  setText('col-cost-header', 'Cost: 1 ' + unitLabel + ' (nominal)');
  setText('cost-panel-sub',
    'What it costs, in today\'s dollars, to fund exactly one ' + unitLabel +
    ' of your final salary as retirement income — contributed at a few different starting ages, then compounded to retirement.');

  const rows = data.yearRows;
  if (!rows.length){
    setHTML('cost-figures', '');
    setText('cost-panel-callout', 'n/a');
    return;
  }

  const n = rows.length;
  const indices = Array.from(new Set([
    0,
    Math.floor(n / 3),
    Math.floor((2 * n) / 3),
    n - 1,
  ])).sort((a, b) => a - b);

  setHTML('cost-figures', indices.map(i => {
    const row = rows[i];
    return (
      '<div class="cost-stat">' +
        '<div class="stat-label">Age ' + row.age + '</div>' +
        '<div class="stat-value">' + fmtMoney(costRealFieldForUnit(row)) + '</div>' +
      '</div>'
    );
  }).join(''));

  const first = rows[0];
  const last = rows[n - 1];
  const firstCost = costRealFieldForUnit(first);
  const lastCost = costRealFieldForUnit(last);
  const multiple = firstCost > 0 ? lastCost / firstCost : null;

  setHTML('cost-panel-callout',
    'At age ' + first.age + ', buying one ' + unitLabel + ' of your final salary in retirement income costs ' +
    '<strong>' + fmtMoney(firstCost) + '</strong> in today\'s dollars. Wait until ' + last.age + ', and the same ' + unitLabel + ' costs ' +
    '<strong>' + fmtMoney(lastCost) + '</strong>' +
    (multiple !== null ? ' — ' + multiple.toFixed(1) + 'x as much, even after adjusting for inflation.' : ' in today\'s dollars.'));
}

function renderBalanceChart(data){
  const startBalance = parseFloat(els.balance.value) || 0;
  const contribSeries = data.cumContrib.map(c => c + startBalance);
  const growthSeries = data.cumGrowth;

  if (chart){
    chart.data.labels = data.ages;
    chart.data.datasets[0].data = contribSeries;
    chart.data.datasets[1].data = growthSeries;
    chart.update();
    return;
  }

  const ctx = document.getElementById('chart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.ages,
      datasets: [
        {
          label: 'Contributions',
          data: contribSeries,
          borderColor: THEME.teal,
          backgroundColor: THEME.tealFill,
          fill: true,
          stack: 'stack1',
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 2,
        },
        {
          label: 'Investment growth',
          data: growthSeries,
          borderColor: THEME.gold,
          backgroundColor: THEME.goldFill,
          fill: true,
          stack: 'stack1',
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 2,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          title: { display: true, text: 'Age', ...CHART_AXIS_TITLE_STYLE },
          ticks: CHART_AXIS_TICK_STYLE,
          grid: CHART_GRID_STYLE
        },
        y: {
          stacked: true,
          ticks: { ...CHART_AXIS_TICK_STYLE, callback: (v) => '$' + (v / 1000).toFixed(0) + 'k' },
          grid: CHART_GRID_STYLE
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...CHART_TOOLTIP_STYLE,
          callbacks: {
            title: (items) => 'Age ' + items[0].label,
            label: (item) => item.dataset.label + ': ' + fmtMoney(item.parsed.y)
          }
        }
      }
    }
  });
}

function renderPctChart(data){
  const pctAges = data.yearRows.map(r => r.age);
  const pctValues = data.yearRows.map(r => r.pctOfPot);

  if (chartPct){
    chartPct.data.labels = pctAges;
    chartPct.data.datasets[0].data = pctValues;
    chartPct.update();
    return;
  }

  const ctxPct = document.getElementById('chart-pct').getContext('2d');
  chartPct = new Chart(ctxPct, {
    type: 'bar',
    data: {
      labels: pctAges,
      datasets: [
        {
          label: '% of pot',
          data: pctValues,
          backgroundColor: THEME.gold,
          borderRadius: 2,
          maxBarThickness: 18,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          title: { display: true, text: 'Age', ...CHART_AXIS_TITLE_STYLE },
          ticks: CHART_AXIS_TICK_STYLE,
          grid: { display: false }
        },
        y: {
          ticks: { ...CHART_AXIS_TICK_STYLE, callback: (v) => v.toFixed(1) + '%' },
          grid: CHART_GRID_STYLE
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...CHART_TOOLTIP_STYLE,
          callbacks: {
            title: (items) => 'Age ' + items[0].label,
            label: (item) => 'Share of pot: ' + item.parsed.y.toFixed(1) + '%'
          }
        }
      }
    }
  });
}

function render(){
  renderSliderLabels();
  const data = project();
  renderTopStats(data);
  renderTable(data);
  renderCostPanel(data);
  renderBalanceChart(data);
  renderPctChart(data);
}

// =====================================================================
// SEGMENTED TOGGLE CONTROL
// Shared wiring for every "pick one of N buttons" control on the page
// (chart tabs, tax treatment, equalize net pay) instead of three
// near-identical hand-written implementations.
// =====================================================================

function createSegmentedToggle(buttonConfigs, onSelect){
  function select(value){
    buttonConfigs.forEach(({ value: v, el }) => {
      const isActive = v === value;
      el.classList.toggle('active', isActive);
      el.setAttribute('aria-selected', isActive);
    });
    onSelect(value);
  }
  buttonConfigs.forEach(({ value, el }) => {
    el.addEventListener('click', () => select(value));
  });
  return select;
}

// --- Chart tabs ---
const paneBalance = document.getElementById('pane-balance');
const panePct = document.getElementById('pane-pct');
const selectChartTab = createSegmentedToggle(
  [
    { value: 'balance', el: document.getElementById('tab-balance') },
    { value: 'pct', el: document.getElementById('tab-pct') },
  ],
  (value) => {
    const isBalance = value === 'balance';
    paneBalance.style.display = isBalance ? '' : 'none';
    panePct.style.display = isBalance ? 'none' : '';
    if (isBalance && chart) chart.resize();
    if (!isBalance && chartPct) chartPct.resize();
  }
);

// --- Contribution type toggle: Pre-tax / Roth / Taxable ---
const selectTaxTreatment = createSegmentedToggle(
  [
    { value: TAX_TREATMENT_PRETAX, el: document.getElementById('toggle-pretax') },
    { value: TAX_TREATMENT_ROTH, el: document.getElementById('toggle-roth') },
    { value: TAX_TREATMENT_TAXABLE, el: document.getElementById('toggle-taxable') },
  ],
  (value) => {
    taxTreatment = value;
    render();
  }
);

// --- Equalize net pay toggle ---
const equalizeHint = document.getElementById('equalize-hint');
const EQUALIZE_HINT_TEXT = {
  off: 'Same dollar contribution either way — Roth and Taxable cost more net pay than Traditional since neither is tax-deductible.',
  on: 'Roth/Taxable contribution is reduced so your net take-home pay matches Pre-tax at the same rate — the Traditional side never changes.',
};
const selectEqualizeNetPay = createSegmentedToggle(
  [
    { value: false, el: document.getElementById('toggle-equalize-off') },
    { value: true, el: document.getElementById('toggle-equalize-on') },
  ],
  (value) => {
    equalizeNetPay = value;
    equalizeHint.textContent = value ? EQUALIZE_HINT_TEXT.on : EQUALIZE_HINT_TEXT.off;
    render();
  }
);

// --- "Cost of waiting" unit toggle: per day / per month ---
const selectCostUnit = createSegmentedToggle(
  [
    { value: 'day', el: document.getElementById('toggle-cost-day') },
    { value: 'month', el: document.getElementById('toggle-cost-month') },
  ],
  (value) => {
    costUnit = value;
    render();
  }
);

// =====================================================================
// RESET
// =====================================================================

document.getElementById('reset-btn').addEventListener('click', () => {
  Object.keys(DEFAULTS).forEach(key => {
    if (els[key]) els[key].value = DEFAULTS[key];
  });
  selectTaxTreatment(DEFAULT_TAX_TREATMENT);
  selectEqualizeNetPay(DEFAULT_EQUALIZE_NET_PAY);
  selectCostUnit('day');
});

// =====================================================================
// INIT
// =====================================================================

Object.values(els).forEach(el => el.addEventListener('input', render));
render();

# Retirement Savings Projection

A single-page calculator that projects retirement savings growth, income
tax (federal, FICA, capital gains, NIIT), 401(k) contribution limits, and
withdrawal income across Traditional, Roth, and Taxable account types.

Open `index.html` in a browser — no build step or server required.

## Code structure

`index.html` contains two `<script>` blocks, deliberately separated:

- **`#engine-script`** — `RetirementEngine`, the entire tax/investment
  calculation engine. Pure functions only: no `document`, no DOM, no
  Chart.js. Every function is a plain function of its arguments. This is
  the block to read if you're reviewing the math, and the block to copy
  into a test file if you want to unit-test it — it runs standalone in
  plain Node with zero mocking.
- **`#ui-script`** — DOM wiring, rendering, chart setup, and event
  handling. Contains no tax/investment logic of its own; it reads form
  inputs, calls `RetirementEngine.runProjection(inputs)`, and displays
  the result. The one function that bridges the two layers is `project()`
  near the top of this block — everything above it is engine, everything
  below it is display.

This split exists so a reviewer checking the calculations doesn't have to
wade through UI code to find them, and so the engine can be tested in
isolation from the browser entirely.

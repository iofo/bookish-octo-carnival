# Retirement Savings Projection

A single-page calculator that projects retirement savings growth, income
tax (federal, FICA, capital gains, NIIT), 401(k) contribution limits, and
withdrawal income across Traditional, Roth, and Taxable account types.

Open `index.html` in a browser — no build step or server required. It loads
`engine.js` and `ui.js` as plain `<script>` tags, so all three files need to
stay together in the same folder.

## Code structure

- **`engine.js`** — the entire tax/investment calculation engine
  (`RetirementEngine`). Pure functions only: no `document`, no DOM, no
  Chart.js, no dependency on index.html or the browser at all. This is the
  file to read if you're reviewing the math, and it runs standalone —
  `node engine.js` or `require('./engine.js')` from a test file both work
  with zero mocking.
- **`ui.js`** — DOM wiring, rendering, chart setup, and event handling.
  Contains no tax/investment logic of its own; it reads form inputs, calls
  `RetirementEngine.runProjection(inputs)`, and displays the result. The
  `project()` function near the top is the only place the two files touch.
- **`index.html`** — markup and styling, plus `<script src="engine.js">`
  followed by `<script src="ui.js">` (in that order — ui.js depends on the
  `RetirementEngine` global engine.js defines).

This split exists so a reviewer checking the calculations only needs to
open `engine.js`, and so the engine can be tested in complete isolation
from the browser.

## Tests

`test.js` exercises `engine.js` directly via `require('./engine.js')` — no
browser, no build step, no external dependencies (just Node's built-in
`assert`). Run it with:

```
node test.js
```

Exits `0` if everything passes, `1` if anything fails, so it's safe to wire
into CI. Covers the 401(k) contribution limits (including the age 60–63
super catch-up), federal income tax, FICA, capital gains tax, NIIT,
qualified dividend tax, the savings-rate schedule, and full end-to-end
projections for all three contribution types — including known reference
figures (e.g. "$100,000 salary owes $13,170 in 2026 federal tax") rather
than just re-asserting whatever the code currently happens to return.

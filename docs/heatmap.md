# Step-coverage heat map

The Heat Map page shows which parts of your coverage matrix the tests exercised, on four levels:
**Component → Scenario × Feature ▸ Area**. Each cell shows `passed/hits`, coloured by
Settings → Health thresholds → Heat map cell.

Try it with synthetic data: `npx qaily-report demo --out report-data` also writes example mapping rules and a planned
matrix with a few gaps.

## How a step gets a cell

Two sources. An explicit label on a step wins over the rules for that step.

### 1. Mapping rules (no test changes; works on old runs too)

Settings → **For the team** → Coverage heat map → Mapping rules. Each rule has:

- **Conditions** (regular expressions; all the filled ones must match): **Step** title, test **Tag** (any tag),
  **Test title**, spec **File**, plus "Aa" to ignore case.
- **Assignments**: Component, Scenario, Feature, Area.

Evaluation: each level comes from the **first** rule, top to bottom, that matches and sets it. A step only counts
as a hit when a rule with a **Step** condition matches it. Rules without a Step condition only add
Component/Scenario to the steps other rules match (for example, a scenario per test title). Levels that no rule
sets show as "(unspecified)".

Rules are applied in the browser when the page loads, so editing them updates the heat map at once, with no rebuild.
The heat map evaluates them with DuckDB (RE2), so lookaround and backreferences aren't allowed.

Helpers:

- **Try it** under the rules table shows which cell a step title (plus optional test title and tags) lands in.
- **Unmapped steps** on the Heat Map page lists the most common steps no rule maps yet. **Copy rule** copies a rule
  whose Step regex matches that title, ready to fill in.
- Settings → For the team → Import JSON loads rules from a file; review them, then save them (Save to bucket, Save to settings.json or Commit to GitHub, depending on where the report keeps team settings).

### 2. Explicit step labels (most precise)

With Playwright 1.58+, label steps in the tests:

```ts
import { coverage } from '@qaily/playwright-html-reporter';

await test.step('Archive board', async (step) => {
  coverage(step, { component: 'Permissions', scenario: 'Workspace owners', feature: 'Boards', area: 'Archive' });
  // ...
});
```

`coverage()` pushes step annotations of type Component / Test Name / Feature / Area. Plain
`step.annotations.push({ type: 'Feature', description: 'Boards' })` works too; `Scenario` is accepted for
`Test Name`. A step is labelled when it (or a step nested in it) has at least a Component. The reporter writes
`<run>/step-coverage.jsonl`, and `qaily-report build` merges it into the steps rollup. Custom level names:
reporter option `coverage: { levels: ['Component', 'Test Name', 'Feature', 'Area'] }`, and the same `levels` as the
third argument of `coverage()`.

## Counting

- A cell counts **once per test per attempt**, however many steps hit it; the worst step status wins.
- Only the **final attempt** (the one that decided the result) counts as a hit. **⚠ flaky** = failed on an earlier
  attempt, passed on the final one.
- Skipped steps never ran and don't count.
- Known limitation: when a step fails, the later steps of that test never run, so their cells show **fewer hits**,
  not failures.

Click a cell to see the tests and steps behind it, with links to the Tests page.

## Layouts

- **Sheet** (default): the planned matrix as you keep it in a spreadsheet — merged *Component → Scenario →
  Feature*, one row per *Area*, in the sheet's own order, with a **Coverage** cell at the end of each
  row (`passed/hits`, ⚠ flaky, hatched "not covered" for planned rows without hits). Hit cells the sheet doesn't plan
  are added under their scenario with a dashed border. Feature lines without an Area are rows of their own. Component and scenario names stay in view while scrolling; click them to collapse.
- **Grid**: one component at a time, Feature ▸ Area rows × scenario columns (compare scenarios side by side).

The choice is in the URL (`layout=grid`) and remembered per browser. Rows only show coverage when the rules (or step
annotations) produce **the same names as the sheet** — e.g. a scenario "Checkout" needs a rule that sets
`scenario: "Checkout"`.

## Planned matrix (gaps)

Keep the planned matrix in a spreadsheet, export it as CSV and turn it into `<data>/coverage-catalog.json`:

```bash
npx qaily-report catalog --csv matrix.csv --out report-data/coverage-catalog.json
```

The CSV has a header row and four columns, the levels top first. Empty cells (for example from merged cells) are
filled from the row above:

```csv
Component,Scenario,Feature,Area
Tasks,Task lifecycle,Tasks,Create
,,,Assign
,,Authentication,Login
```

With a catalog the map also shows:

- **planned cells with no hits** (hatched);
- **hit cells that aren't in the catalog** (dashed border, often a label or rule typo);
- **planned cells hit** in the summary.

Without a catalog it shows only the cells that were hit.

## Data

`qaily-report build` writes `rollups/steps-YYYY-MM.parquet`: one row per top-level step of each attempt (title,
status, duration, final attempt), plus any explicit labels.

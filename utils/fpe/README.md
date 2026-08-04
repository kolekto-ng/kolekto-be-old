# utils/fpe — vendored Financial Projection Engine

**Do not edit these files.** They are compiled output of the canonical package
`kolekto-fe-old/kolekto-shared-financial` (TypeScript). This backend consumes
the engine through `utils/financial.js`, which is a thin adapter over
`utils/fpe/index.js`.

To update after an engine change:

```
cd ../kolekto-fe-old/kolekto-shared-financial
npm run build && npm run vendor:backend
```

Equivalence to the source is guaranteed by the golden-vector conformance suite
and the differential parity tests in the package.

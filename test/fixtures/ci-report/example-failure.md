## CI (test): ❌ Checks failed

**Run:** [https://github.com/test/test/actions/runs/12345](https://github.com/test/test/actions/runs/12345)

## Typecheck

**Status:** ❌ Failed

```
src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/bar.ts(45,10): error TS2345: Argument of type 'X' is not assignable to parameter of type 'Y'.
```

## Tests

**Status:** ❌ Failed | 1 passed, 2 failed, 0 skipped

### Failed Tests

| Test | File | Error |
|------|------|-------|
| should handle empty input | test/tier1/parser.test.ts | Expected '' to equal 'foo' |
| should validate config | test/tier2/config.test.ts | TypeError: Cannot read property 'x' of undefined |

### Failure Details

#### test/tier1/parser.test.ts > should handle empty input

```
AssertionError: expected '' to equal 'foo'
    at test/tier1/parser.test.ts:15:20
    at processTicksAndRejections (node:internal/process/task_queues:95:5)
```

#### test/tier2/config.test.ts > should validate config

```
TypeError: Cannot read property 'x' of undefined
    at validateConfig (src/config.ts:42:15)
    at test/tier2/config.test.ts:10:5
```

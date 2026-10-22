# Open issues (exported from the tracker)

## #41 Crash when file doesn't exist
```
node:fs:573
  return binding.open(
                 ^
Error: ENOENT: no such file or directory, open 'sales.csv'
    at Object.openSync (node:fs:573:18)
    at Object.readFileSync (node:fs:452:35)
    at file:///usr/lib/node_modules/csvstat/bin/csvstat.js:6:24
```
I just typo'd the filename. Took me a while to figure out what this meant.

## #44 "Error: bad row 17"?
Huge stack trace and "bad row 17". Is that line 17 of my file? Line 18? What's wrong with it? (It had a quoted comma.)

## #47 mean prints NaN
`csvstat data.csv Price` prints `mean  NaN`. The column is called `price`.

## #48 no usage message
Running `csvstat` with no args gives `TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string`.

# Checksums

SHA-256 hashes of the files in this repository that actually execute, so you can
confirm the copy you downloaded is the copy that was published here.

| File | SHA-256 | Size | Last changed in |
| --- | --- | --- | --- |
| `PbN-Mapper.user.js` | `be13794c97b3a24ff7ea9b154709da62389f6b98611d8ecdd0fbb73d2f228833` | 92,266 bytes | [`571ceec`](https://github.com/Vargess/PhillyByNight/commit/571ceec) |
| `map-viewer.html` | `476be60425d1d1eee1e3439b602bd334f335d1483e4b48b2336d0fa55d02195b` | 96,493 bytes | [`309dec1`](https://github.com/Vargess/PhillyByNight/commit/309dec1) |

Only these two are listed. They're the files that run code — one in your browser on
the game site, one locally against your map data. The documentation and licence
aren't listed because nothing executes them, and including them would mean this file
went stale every time a typo was fixed, which trains people to ignore a mismatch.

## Verifying

Hash **the file you downloaded**, then compare it with the table above.

**Windows (PowerShell)**

```powershell
Get-FileHash .\PbN-Mapper.user.js -Algorithm SHA256
```

**macOS / Linux**

```bash
shasum -a 256 PbN-Mapper.user.js
```

Compare case-insensitively — PowerShell prints uppercase, `shasum` lowercase.

## If it doesn't match

Before assuming anything is wrong, check **line endings**. These hashes are of the
bytes GitHub serves, which use Unix line endings (LF). Two things commonly change
them:

- **`git clone` on Windows.** Git's default `core.autocrlf=true` rewrites LF to CRLF
  as it writes files to disk, which changes every line and therefore the hash. A
  cloned `PbN-Mapper.user.js` is about 2 KB larger than the published one for this
  reason alone.
- **Copy-pasting into an editor** that saves with CRLF, or that adds a trailing
  newline.

So verify the file as it arrived from the
[raw link](https://raw.githubusercontent.com/Vargess/PhillyByNight/main/PbN-Mapper.user.js),
not one that has been through a Windows clone. If you want to check a clone anyway,
hash what Git has stored rather than what's on disk:

```bash
git show main:PbN-Mapper.user.js | shasum -a 256
```

or clone with line endings left alone in the first place:

```bash
git -c core.autocrlf=input clone https://github.com/Vargess/PhillyByNight
```

## What this does and doesn't tell you

A match confirms the file reached you **intact and unaltered in transit** — not
corrupted mid-download, not modified by a proxy or mirror, and not a stale cached
copy.

It does **not** prove the file is safe, and it isn't protection against this
repository itself being compromised: anyone able to change the script could change
this page too. It verifies that you got what was published, not that what was
published is trustworthy. For that, read the source — it's plain, unminified
JavaScript, and that's deliberate.

This file also can't contain its own hash, so it carries no guarantee of itself.

## Regenerating

After changing either file, update the table:

```bash
sha256sum PbN-Mapper.user.js map-viewer.html
```

```powershell
Get-FileHash .\PbN-Mapper.user.js, .\map-viewer.html -Algorithm SHA256 | Format-List
```

On Windows, hash what Git has stored rather than the working copy, or the published
value will be wrong for everyone else:

```bash
git show HEAD:PbN-Mapper.user.js | sha256sum
git show HEAD:map-viewer.html | sha256sum
```

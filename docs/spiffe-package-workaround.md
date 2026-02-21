# SPIFFE Package Workaround

## Issue

The `spiffe` npm package (v0.5.0) has broken exports in its `package.json`:
- Declares `"main": "./dist/index.js"` and `"exports.import": "./dist/index.js"`
- But only ships `index.mjs` and `index.cjs` files (no `index.js`)
- This causes import failures in Bun and other runtimes

## Workaround

We use a `postinstall` script in `package.json` to create a symlink:

```json
{
  "scripts": {
    "postinstall": "test -L node_modules/spiffe/dist/index.js || ln -sf index.mjs node_modules/spiffe/dist/index.js"
  }
}
```

This runs automatically after `bun install` or `npm install`, ensuring the symlink is always present.

## Permanent Fix

Upstream issue should be reported to: https://github.com/depot/node-spiffe

The package.json should be updated to:
```json
{
  "main": "./dist/index.mjs",
  "module": "./dist/index.mjs",
  "exports": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.mjs",
    "require": "./dist/index.cjs"
  }
}
```

## Verification

After install, verify the import works:
```bash
bun -e "import('spiffe').then(() => console.log('OK')).catch(e => console.error(e))"
```

# png-squeeze

A lossless PNG re-encoder for the make.fun **png-squeeze-01** competition.
For every instance in `$MAKEFUN_INPUT_DIR` (default `/input`) it writes a
pixel-identical PNG to `$MAKEFUN_OUTPUT_DIR` (default `/output`), as small as
it can make it, in the checker's stated format: bit depth 8, not interlaced,
only `IHDR`/`PLTE`/`tRNS`/`IDAT`/`IEND` chunks, one zlib stream in `IDAT`.

## How it works

Everything is a function of the input pixels — no clock, no environment, no
randomness — so two runs write the same bytes.

1. **Decode** the stored screenshot (its own PNG decoder: inflate + unfilter).
2. **Forms.** Every lossless form that can hold the image is a candidate:
   palette (colour-count and luminance orders) when it has at most 256
   distinct RGBA colours, grey / grey+alpha, RGB / RGBA, and single-colour
   `tRNS` keying when exactly one fully transparent colour occurs.
3. **Filter screen.** Each form is filtered seven ways (the five fixed PNG
   filters, the minimum-signed-sum heuristic, and the fewest-distinct-pairs
   heuristic) and screened with zlib level 6. The winner goes forward.
4. **Deflate.** The winning filtered data is compressed twice: with zlib
   level 9, and with this file's own optimal-parse deflate — hash-chain match
   finding that records both the longest match and the longest near match
   (distance ≤ 2048) at every position, a shortest-path parse under Huffman
   costs gathered from the data (iterated), package-merge length-limited
   Huffman codes, and dynamic/fixed/stored block choice by exact bit count.
   The smaller stream wins, and it is only used after an inflation check
   proves it reproduces the filtered data byte for byte.

Work budgets inside the match finder are counted in compared bytes and chain
steps, never in time, so the output does not depend on the machine's speed.

## Running

```
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

Node 22 (the file is plain JavaScript in a `.ts` name; Node's type stripping
runs it as-is). No dependencies beyond Node's built-in modules.

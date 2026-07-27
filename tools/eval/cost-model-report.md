================================================================================
PER-FILE LANE TOKEN COST MODEL
================================================================================

Total files in inventory: 1035
  Hunt-eligible:         713
  Skip (non-executable): 322

SIZE BUCKET TABLE (hunt-eligible files only)
--------------------------------------------------------------------------------
Bucket                     Count   Avg Size  Input Tok Output Tok     Subtotal
--------------------------------------------------------------------------------
under 2 KB                   311        988    807,873  1,166,343    1,974,216
2-3 KB                        65      2,567    209,284    243,770      453,054
3-8 KB                       160      4,966    666,189    600,048    1,266,237
8-24 KB                      106     13,966    816,558    397,532    1,214,090
over 24 KB                    71    220,258  7,069,231    266,271    9,305,246
--------------------------------------------------------------------------------
TOTAL                        713             9,569,135  2,673,964   14,212,842

SCENARIO COMPARISON
--------------------------------------------------------------------------------
SCENARIO NARROW (evidence-driven categories, avg 1.5/file):
  Total predicted tokens:   14,212,842

SCENARIO BROAD (full category universe, 21 categories/file):
  Total predicted tokens:   24,973,400

Ratio BROAD/NARROW: 1.8x

COST BREAKDOWN -- NARROW SCENARIO
--------------------------------------------------------------------------------
  fixed_overhead                 746,169 tokens (  5.2%)
  content_variable             7,995,231 tokens ( 56.3%)
  playbook_category              827,735 tokens (  5.8%)
  chunking_overhead            1,969,744 tokens ( 13.9%)
  output_findings              2,673,964 tokens ( 18.8%)

COST BREAKDOWN -- BROAD SCENARIO
--------------------------------------------------------------------------------
  fixed_overhead                 746,169 tokens (  3.0%)
  content_variable             7,995,231 tokens ( 32.0%)
  playbook_category           11,588,293 tokens ( 46.4%)
  chunking_overhead            1,969,744 tokens (  7.9%)
  output_findings              2,673,964 tokens ( 10.7%)

CHUNKING MULTIPLIER IMPACT
--------------------------------------------------------------------------------
  NARROW:    1,969,744 tokens from multi-pass overhead (13.9% of total)
  BROAD:     1,969,744 tokens from multi-pass overhead (7.9% of total)

SKIP SAVINGS
--------------------------------------------------------------------------------
  322 non-executable files skipped
  Tokens saved by skipping:   11,198,294
  This represents 44.1% of what a naive full-scan (no skips)
  would cost under NARROW

CALIBRATION
--------------------------------------------------------------------------------
  Tokens per prompt byte: 0.342
  Avg playbook size: 2,263 bytes
  Fixed overhead per lane: 3,060 bytes
  Avg output tokens per finding: 1,389
  Avg findings per lane: 2.7
  Single pass line budget: 500 lines
  Chunk overlap: 20 lines

KEY ASSUMPTIONS & RISK FLAGS
--------------------------------------------------------------------------------
  1. TOKENS_PER_PROMPT_BYTE (0.342): If the LLM model changes (different
     tokenization or model tier), this ratio shifts. Re-calibrate per model.
  2. narrow_categories_per_file (1.5): If recon evidence is sparse, more
     files fall to universe_default, pushing actual cost toward BROAD.
  3. category_universe_count (21): If the framework set grows, BROAD
     scenario cost scales linearly with this count (major cost driver).
  4. AVG_FINDINGS_PER_LANE (2.7): If find rate changes, output tokens
     scale proportionally. Currently ~7% of total cost; low sensitivity.
  5. FIXED_OVERHEAD_BYTES (3,060): If prompt templates change significantly,
     re-measure. In v2 this is paid ~N times (once per file), making it
     the dominant per-file cost driver even though it is small per unit.
  6. CHUNK_OVERLAP_LINES (20): If overlap changes, multi-pass cost shifts.
  7. SINGLE_PASS_LINE_BUDGET (500): Lower budget means more files need
     chunking, which amplifies fixed overhead payment frequency.

================================================================================
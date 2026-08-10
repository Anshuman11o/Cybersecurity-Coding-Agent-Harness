#!/usr/bin/env python3
"""
v3 -- the dispatcher track.

v1 (`task_loop.py`) and v2 (`wave_plan.py` + `wave_runner.py`) are untouched and
stay load-bearing. v3 lives beside them because the thing it changes is not a
parameter of either: **planning moves offline**, and the orchestrator stops
being a judge.

  v1  orchestrator plans nothing, runs one task at a time, gates every phase
  v2  orchestrator computes a wave plan at runtime, runs a wave, gates the merge
  v3  the plan is a checked-in artefact; the orchestrator dispatches, monitors,
      and merges. It runs no patcher gate at all.

See `docs/patcher/ARCHITECTURE-V3.md` for the specification and for what this
gives up in exchange.

The modules import their v1/v2 neighbours flat (`import integrator`), exactly as
`wave_runner.py` does, so `src/` has to be importable. Importing `v3` at all
already requires that, but the bootstrap below makes a direct
`python3 src/v3/dispatcher.py` work too, and costs nothing when it is redundant.
"""
from __future__ import annotations

import os
import sys

_SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)

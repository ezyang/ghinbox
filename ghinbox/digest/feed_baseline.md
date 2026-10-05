# What a normal Feed looks like for ezyang

My Feed is ambient PyTorch traffic: mostly module cc's (I am one of many names
on a cc list), plus threads I once commented on or subscribed to. I don't want
a summary of it. I want to know when something departs from this baseline.

## Routine (do not flag)

- A steady stream of bug reports and fixes in PT2: Dynamo graph breaks and
  guard failures, Inductor codegen/perf issues, export/AOTAutograd edge cases,
  fake tensor / meta kernel gaps, dynamic-shape data-dependent errors.
  Individually these are normal, even when they are crashes.
- Fix PRs, relands, and their CI churn; "[reland]" and "Revert" by the
  author's own stack while landing is normal.
- Backend/platform work (ROCm, XPU, MPS, Windows, CUDA graphs, distributed)
  moving along, including design back-and-forth among the people who own it.
- Old issues getting a "me too", a workaround, a stale-bot bump, or an
  occasional new fix attempt by an outside contributor.
- Bot activity: pytorchbot merges, CI status, auto-labeling, Dr. CI comments.
- Discussions in someone else's area that are proceeding without me.

## Out of the ordinary (worth flagging)

- **Clusters**: several independent reports of the same symptom, or a burst
  of activity in one area well above its usual trickle (e.g. three different
  people hitting the same symbolic_shapes or fake tensor error in a day).
- **Regressions with breadth**: something that used to work broke for many
  users, a nightly/release regression, a perf or correctness regression in a
  widely used path, a silent-wrong-results report.
- **Reverts of other people's work** that landed in my areas (dynamic shapes,
  fake tensor, dispatcher/subclasses, codegen, PT2 logging, FX), or a revert
  war.
- **Decisions and direction changes**: an RFC, a deprecation, a policy change,
  an API being removed or redesigned, a maintainer saying "we should stop
  doing X", a new owner taking over an area.
- **Unusual people or places**: a new major contributor or company showing up,
  activity in a long-dormant thread from someone who matters, heated or
  escalating threads, security reports.
- **My code, indirectly**: someone building on, working around, or ripping out
  something I wrote, even if they did not mention me.

When nothing departs from the baseline, say so; an empty list is the right
answer on a normal day.

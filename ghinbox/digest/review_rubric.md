# How ezyang triages External review requests

These are pull requests from people without write access to pytorch/pytorch
where GitHub requested my review (often automatically, via CODEOWNERS or a
module cc). Most of them I will never get to. Tell me which ones I should
actually look at.

A PR is worth a look if it fits at least one of these buckets:

- **easy**: Small, self-contained, obviously correct, and low-risk: a clear
  bug fix with a test, a docs/typing/error-message fix, a narrowly scoped
  cleanup. Even if the impact is modest, I'll shepherd it in because it costs
  me a few minutes. A large diff is not easy, however mechanical, unless it
  is trivially reviewable (e.g. a pure rename) and has a clear motivation.
- **context**: It touches code where I have a LOT of context, so I can review
  it quickly and well. Areas where I have deep context:
  - Dynamic shapes / symbolic shapes: `torch/fx/experimental/symbolic_shapes.py`,
    `torch/fx/experimental/sym_node.py`, `torch/utils/_sympy/`, SymInt/SymFloat/
    SymBool (`c10/core/SymInt*`, `torch/__init__.py` sym helpers), unbacked
    SymInts, guards, `torch/_dynamo/pgo.py` / automatic dynamic.
  - Fake tensor and meta: `torch/_subclasses/fake_tensor.py`,
    `torch/_subclasses/fake_impls.py`, `torch/_subclasses/meta_utils.py`,
    `torch/_meta_registrations.py`, `torch/_prims_common/`.
  - Dispatcher, Python dispatcher and subclasses: `torch/_ops.py`,
    `torch/utils/_python_dispatch.py`, `__torch_dispatch__` /
    `__torch_function__`, `c10/core/DispatchKey*`, `aten/src/ATen/core/dispatch/`,
    functionalization.
  - Codegen: `torchgen/`, `native_functions.yaml`, `derivatives.yaml`,
    `tools/autograd/`.
  - PT2 logging and debuggability: `torch/_logging/`, `trace_structured`,
    tlparse, compile-time instrumentation, `torch/_utils_internal.py`.
  - FX core: `torch/fx/graph.py`, `torch/fx/proxy.py`,
    `torch/fx/experimental/proxy_tensor.py` (make_fx).
- **important**: The PR matters regardless of who reviews it: it fixes a
  silent correctness bug, a crash or hang that users hit, a security issue, a
  regression, or something maintainers are clearly waiting on (linked high-pri
  issue, a maintainer asked for it in the comments). We definitely want it in,
  so make me look even if it is big or outside my areas.

Skip it (no bucket) when:

- It is a large feature or refactor in an area I don't know, without an
  obvious champion asking for it.
- It is speculative, a drive-by "improvement" without a motivating bug, or
  AI-generated churn (generic descriptions, many unrelated small edits,
  no tests).
- Someone else who owns the area is clearly already reviewing it, and nothing
  in the thread asks for me.
- It is a backend/device/platform port (ROCm, XPU, MPS, Windows build) or a
  CI/infra tweak, unless it is in one of my context areas.

When in doubt between "skip" and a bucket, skip: the cost of a false "look" is
my time, and I can always browse the skipped list.

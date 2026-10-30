## Merge failed
**Reason**: Command `git -C /home/runner/work/pytorch/pytorch cherry-pick -x 20f3e550fb86ebe2d23635045e6a0bd137d630d6` returned non-zero exit code 1
```
Auto-merging .ci/pytorch/common_utils.sh
CONFLICT (content): Merge conflict in .ci/pytorch/common_utils.sh
Auto-merging .ci/pytorch/test.sh
CONFLICT (content): Merge conflict in .ci/pytorch/test.sh
error: could not apply 20f3e550fb8... [ci] Install nccl4py in the CI images instead of at test time
hint: After resolving the conflicts, mark them with
hint: "git add/rm <pathspec>", then run
hint: "git cherry-pick --continue".
hint: You can instead skip this commit with "git cherry-pick --skip".
hint: To abort and get back to the state before "git cherry-pick",
hint: run "git cherry-pick --abort".
hint: Disable this message with "git config set advice.mergeConflict false"
```

<details><summary>Details for Dev Infra team</summary>

Raised by <a href="https://github.com/pytorch/pytorch/actions/runs/40990148670">workflow job</a>
</details>

<!-- mergebot-status: merge failure comment=6513229413 -->

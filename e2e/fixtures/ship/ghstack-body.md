Stack from [ghstack](https://github.com/ezyang/ghstack/tree/0.18.0) (oldest at bottom):
* #200218
* #200217
* #200216
* #200193
* #200192
* #200191
* #200190
* __->__ #200189
* #200188
* #200173
* #200103
* #200167

`register_users_of` defined a nested `register` that calls itself, so each
call created a function kept alive by its own closure cell, together with
the `GraphLowering` it captures (and through it the graph's constants,
which can be real tensors), until the cyclic GC ran. It runs for every
lowered node.

Make the helper a private method; the body is unchanged. (The same change
is part of the broader lambda-lifting in pytorch#200100.)

Test plan: compiling an `optimizer.step()` with gc disabled and
gc.DEBUG_SAVEALL no longer leaves real tensors in cyclic garbage;
test_torchinductor.py.

cc @voznesenskym @penguinwu @EikanWang @jgong5 @Guobing-Chen @XiaobingSuper @zhuhaozhe @blzheng @wenzhe-nrv @jiayisunx @ipiszy @kadeng @muchulee8 @amjames @chauhang @aakhundov @coconutruben @jataylo
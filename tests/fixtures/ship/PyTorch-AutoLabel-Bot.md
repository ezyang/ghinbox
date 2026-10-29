# PyTorch AutoLabel Bot
**Page maintainer(s):** @ZainRizvi
**Last updated:** 10/21/22

PyTorch maintainers use GitHub labeling for several organizational purposes, such as triaging issues to the right module owners, assigning priority to certain tasks, and categorizing pull requests (PRs). Labeling has much potential! Thus, this is a technical guide for how it works and how you can join in and improve our labeling.

Apart from [Github's default labels](https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/managing-labels#about-default-labels), here are some we use at PyTorch:

- **actionable**: A solution has been identified but needs implementation
- **triaged**: The issue has been reviewed for validity, feasibilty and priority
- **needs reproduction**: This label calls for a reproduction of the issue by someone other than the author.
- **oncall: <module>**: Includes this issue on the specified oncall's triage queue
- **module: <module>**: Denotes which PyTorch module or surface relates to this issue
- **release notes: <module>**: Denotes a change that should be added to the release notes for the given module ([more details](#why-categorize-for-release-notes-and-how-does-it-work)).
- **feature** : Request for a new feature
- **function** : Request for a new function, or modifying an existing function
- **enhancement** : Not as big of a feature, but technically not a bug
- **bug**
- **topic: not user facing**: used on PRs for release note prep
- **triage review**: Queued for discussion

## Why categorize (for release notes)? And how does it work?
**Why categorize?** The purpose of categorizing is so that during the release notes process, commits/PRs are routed to the right module owner whose job is to clean up the commit message and include additional information regarding bc-breaking changes or deprecations. 

**When and how?** Categorizing a PR to the right module should happen before it is landed and can be done by adding a single `release notes: <module name>` label. Labels corresponding to the modules are prefixed with `release notes:`. To find a full list of all the labels see: https://github.com/pytorch/pytorch/labels?q=release+notes%3A.
- Optionally add a single `topic: blah` to make the module owners lives easier later. 
- For PRs that are not user facing and are not intended to be a part of the release notes, the `topic: not user facing` should be added. In that case, the `release notes: <module name>` label is not required.

If you are unsure of which label should be added, please ask your PR reviewer for help. One can also search existing PRs for examples: https://github.com/pytorch/pytorch/pulls?q=is%3Apr+is%3Aopen+label%3A%22release+notes%3A+nn%22

**Maintainers: Automate the categorization**
If a regex against the file path can identify the module your PR affects, you can automate the labeling process by [adding an entry in this list](https://github.com/pytorch/test-infra/blob/9c1616a9664ba4c1a9ccdf953db37257fa266022/torchci/lib/bot/autoLabelBot.ts#L12-L106)

The current heuristics we use are mainly defined in the [`getReleaseNotesCategoryAndTopic`](https://github.com/pytorch/test-infra/blob/main/torchci/lib/bot/autoLabelBot.ts#L130) function. You can always help extend our heuristics by making conditions more specific, extending our bot to categorize more by looking at existing labels/title patterns/features of the pull request.

Please file an issue and tag @soulitzer/@ZainRizvi if you find that your PRs are being mislabeled

## How it works
Our autolabel bot hinges on Probot webhooks. You can read all about [Probot in the GitHub docs](https://probot.github.io/docs/), but the docs contain more details than you need to know for developing on the autolabel bot and could confuse you. It suffices to know that Probot allows you to plug into [GitHub webhooks](https://docs.github.com/en/developers/webhooks-and-events/webhooks/about-webhooks), where webhooks notify you of GitHub-related events such as "a PR has been pushed!" or "a label has been added to an issue!" or "someone edited a PR title!". 

Our autolabel bot merely tells Probot to add labels when certain events have occurred. For example, on the event that an issue title has been modified to include the phrase `DISABLED test...`, we tell the bot to add the `skipped` label denoting a skipped test in CI (if you're curious about the disable test infra, see [our Continuous Integration wiki](https://github.com/pytorch/pytorch/wiki/Continuous-Integration#disabled-tests-in-ci)).

It is at this point where looking at the code becomes more helpful, so open another tab for the bot code that lives in our open source `test-infra` repo: [https://github.com/pytorch/test-infra/blob/main/torchci/lib/bot/autoLabelBot.ts](https://github.com/pytorch/test-infra/blob/main/torchci/lib/bot/autoLabelBot.ts). Note all the `app.on("some.event", async(context) =>` lines. When "some event" occurs, we get a `context`, which gives us information about what happened in the form of a `payload`. For what payloads look like for differing events, please check out [Webhook events & Payloads](https://docs.github.com/en/developers/webhooks-and-events/webhooks/webhook-events-and-payloads#pull_request). 

## How to work it
The primary reason for this wiki is to enable you to help us make our autolabel bot better! One of the most impactful tasks our autolabel bot takes on is categorizing PRs for release notes. As our codebase is large and not one person has enough context or time to know all the right mappings, we encourage you to improve our heuristics and submit changes. 

### How to submit a change
Once you have an improvement in mind, please follow the instructions in our [bot README](https://github.com/pytorch/test-infra/tree/main/torchci#developing-probot). Add test cases in [https://github.com/pytorch/test-infra/blob/main/torchci/test/autoLabelBot.test.ts](https://github.com/pytorch/test-infra/blob/main/torchci/test/autoLabelBot.test.ts) to verify your change. We use nock along with pretend payloads in [https://github.com/pytorch/test-infra/tree/main/torchci/test/fixtures](https://github.com/pytorch/test-infra/tree/main/torchci/test/fixtures) to mock API calls. Nock was confusing when I first started out, and looking at existing test cases (hint hint: copy paste is your friend) was helpful. To run the test file, enter the following command once you're in the `torchci` directory in the commandline:
```
yarn test test/autoLabelBot.test.ts
```

When your change is ready, open up a pull request to [our test-infra repo](https://github.com/pytorch/test-infra) and tag @pytorch/pytorch-dev-infra for a review.





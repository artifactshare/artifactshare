# Show proposal validation status clearly

## Situation

I submitted a proposal from a fork and waited for the repository checks before a maintainer could review it.

## Problem

It was not clear which checks only verified the proposal boundary and which checks validated the full repository. That made it difficult to tell whether the proposal itself needed changes or was simply waiting for the maintainer workflow.

## Expected change

Show a short, public explanation of the proposal validation stages and what action, if any, the contributor should take at each stage.

## Additional context

A concise check summary in the pull request is enough. It should not expose private implementation or operational details.

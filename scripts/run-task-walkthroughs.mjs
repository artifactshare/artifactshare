import { captureTaskWalkthroughs } from './task-walkthrough-capture.mjs'

captureTaskWalkthroughs().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  },
)

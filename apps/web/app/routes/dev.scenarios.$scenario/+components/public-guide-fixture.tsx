import {
  GuideHomeLink,
  GuideProse,
  GuideShell,
  GuideTopbar,
} from '~/components/app/guide-shell'
import { CopyableCodeBlock } from '~/components/app/copyable-code-block'
import { FixtureFooter } from './fixture-footer'

export function PublicGuideFixture() {
  return (
    <>
      <div data-regression-region="header">
        <GuideTopbar>
          <GuideHomeLink homeLabel="Artifact Share home" />
        </GuideTopbar>
      </div>
      <div data-regression-region="main">
        <GuideShell prose>
          <GuideProse>
            <h1>Publishing and reviewing a shared artifact</h1>
            <p>
              This fixture keeps a deliberately long guide body in the public
              document shell so narrow layouts expose wrapping, code overflow,
              and the relationship between the header, article, and footer.
            </p>
            {Array.from({ length: 7 }, (_, index) => (
              <section key={index}>
                <h2>{index + 1}. A predictable publishing workflow</h2>
                <p>
                  Start with a small artifact, publish it from a trusted tool,
                  and send the resulting URL to the people who need to review
                  it. The document remains readable when a heading, paragraph,
                  link, and inline code token all appear together at the
                  smallest supported width.
                </p>
                <CopyableCodeBlock
                  code={`artifactshare publish --name fixture-section-${index + 1}-with-a-deliberately-long-name.md`}
                  name={`Publishing command ${index + 1}`}
                  labels={{
                    copy: 'Copy command',
                    copied: 'Copied',
                    failed: 'Copy failed',
                  }}
                  compact
                />
                <ul>
                  <li>
                    Keep the source and the shared presentation easy to
                    identify.
                  </li>
                  <li>
                    Use comments and version updates to continue the review.
                  </li>
                </ul>
              </section>
            ))}
          </GuideProse>
        </GuideShell>
      </div>
      <FixtureFooter />
    </>
  )
}

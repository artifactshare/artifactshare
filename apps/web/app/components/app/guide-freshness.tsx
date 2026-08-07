import type { Locale } from '~/i18n/messages'
import { guideFreshnessClassName } from './guide-styles'

export type GuideFreshnessProps =
  | {
      kind: 'verified'
      locale: Locale
      verifiedDate: string
      targetUi?: string
      note?: string
    }
  | {
      kind: 'cli'
      locale: Locale
      version: string
      generatedDate: string
    }

export function GuideFreshness(props: GuideFreshnessProps) {
  if (props.kind === 'cli') {
    return (
      <div className={guideFreshnessClassName} data-guide-freshness="cli">
        <p>
          {props.locale === 'ja' ? 'CLI バージョン' : 'CLI version'}:
          @artifactshare/cli {props.version} ·{' '}
          {props.locale === 'ja' ? '生成日' : 'Generated'}:{' '}
          {props.generatedDate}
        </p>
      </div>
    )
  }

  return (
    <div className={guideFreshnessClassName} data-guide-freshness="verified">
      <p>
        {props.locale === 'ja' ? '最終確認日' : 'Last verified'}:{' '}
        {props.verifiedDate}
        {props.targetUi && (
          <>
            {' · '}
            {props.locale === 'ja' ? '対象 UI' : 'Target UI'}: {props.targetUi}
          </>
        )}
      </p>
      {props.note && <p>{props.note}</p>}
    </div>
  )
}

export function GuideHtmlWithFreshness({
  html,
  freshness,
}: {
  html: string
  freshness: GuideFreshnessProps
}) {
  const closingHeading = html.search(/<\/h1>/i)
  if (closingHeading < 0) {
    return (
      <div
        // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered from checked-in Markdown only.
        // react-doctor-disable-next-line react-doctor/dangerous-html-sink
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }

  const headingEnd = closingHeading + '</h1>'.length
  return (
    <>
      <div
        // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered from checked-in Markdown only.
        // react-doctor-disable-next-line react-doctor/dangerous-html-sink
        dangerouslySetInnerHTML={{ __html: html.slice(0, headingEnd) }}
      />
      <GuideFreshness {...freshness} />
      <div
        // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered from checked-in Markdown only.
        // react-doctor-disable-next-line react-doctor/dangerous-html-sink
        dangerouslySetInnerHTML={{ __html: html.slice(headingEnd) }}
      />
    </>
  )
}

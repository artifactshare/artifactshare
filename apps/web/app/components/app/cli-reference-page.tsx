import { Link } from 'react-router'
import { CopyableCodeBlock } from './copyable-code-block'
import { GuideLanguageSwitcher } from './guide-language-switcher'
import { GuideFreshness } from './guide-freshness'
import { GuideRail, GuideTocMobile } from './guide-toc'
import {
  GuideHomeLink,
  GuideMain,
  GuideProse,
  GuideShell,
  GuideTopbar,
} from './guide-shell'
import {
  guideHeroClassName,
  guideLeadClassName,
  guideSectionClassName,
  guideSectionFollowClassName,
  guideSubClassName,
} from './guide-styles'
import { Stack } from '~/components/layout/stack'
import { useT } from '~/hooks/use-t'
import { withLang } from '~/lib/connect-link'
import {
  CLI_REFERENCE_SECTION_IDS,
  CLI_REFERENCE_ENTRY_POINT,
  cliReferenceUsage,
  cliReferenceContent,
} from '~/lib/cli-reference-content'
import type { Locale } from '~/i18n/messages'
import surface from '~/lib/cli-reference-surface.generated.json'

const surfaceByPath = new Map(
  surface.commands.map((command) => [command.path, command]),
)

export function CliReferencePage({ locale }: { locale: Locale }) {
  const { t } = useT()
  const content = cliReferenceContent(locale)
  const toc = CLI_REFERENCE_SECTION_IDS.map((id) => ({
    id,
    label: content.sections[id].title,
  }))
  return (
    <>
      <GuideTopbar>
        <GuideHomeLink homeLabel={t('vw.homeLink')} />
      </GuideTopbar>
      <GuideShell>
        <GuideMain>
          <header className={guideHeroClassName}>
            <h1>{content.title}</h1>
            <GuideFreshness
              kind="cli"
              locale={locale}
              version={surface.package_version}
              generatedDate={surface.generated_date}
            />
            <p className={guideLeadClassName}>{content.intro}</p>
          </header>
          <GuideTocMobile items={toc} title={content.tocTitle} />
          {CLI_REFERENCE_SECTION_IDS.map((id) => {
            const section = content.sections[id]
            if (id === 'related') return null
            const sectionClassName =
              id === 'introduction'
                ? guideSectionClassName
                : guideSectionFollowClassName
            if (id === 'introduction')
              return (
                <section
                  key={id}
                  id={id}
                  data-toc-section
                  className={sectionClassName}
                  aria-labelledby={`${id}-heading`}
                >
                  <GuideProse className="[&_h2]:mt-0">
                    <h2 id={`${id}-heading`}>{section.title}</h2>
                    <p>{section.body}</p>
                    <p>
                      <strong>{content.commandUsageLabel}</strong>
                    </p>
                    <code className="bg-muted block min-w-0 overflow-x-auto rounded-[var(--r-sm)] p-[var(--spacing-2)] text-xs whitespace-pre">
                      {CLI_REFERENCE_ENTRY_POINT.usage}
                    </code>
                    <p>
                      <strong>{content.commandOptionsLabel}</strong>
                    </p>
                    <p>{CLI_REFERENCE_ENTRY_POINT.options.join(' · ')}</p>
                  </GuideProse>
                </section>
              )
            if (id === 'commands')
              return (
                <section
                  key={id}
                  id={id}
                  data-toc-section
                  className={sectionClassName}
                  aria-labelledby={`${id}-heading`}
                >
                  <h2 id={`${id}-heading`}>{section.title}</h2>
                  <p className={guideSubClassName}>{section.body}</p>
                  <h3 className="mt-[var(--spacing-6)] mb-0 text-base font-semibold">
                    {content.commandsHeading}
                  </h3>
                  <div className="mt-[var(--spacing-4)]">
                    <Stack gap="3">
                      {content.commands.map((command) => {
                        const surfaceCommand = surfaceByPath.get(command.path)
                        if (!surfaceCommand) return null
                        const usage = cliReferenceUsage(
                          command.path,
                          surfaceCommand.usage,
                        )
                        return (
                          <article
                            key={command.path}
                            className="border-border bg-card min-w-0 rounded-[var(--r-lg)] border p-[var(--spacing-5)]"
                          >
                            <h3 className="m-0 font-mono text-sm font-semibold break-all">
                              {command.path}
                            </h3>
                            <p className="text-muted-foreground mt-[var(--spacing-2)] mb-0 text-sm">
                              {command.role}
                            </p>
                            {command.example && (
                              <CopyableCodeBlock
                                code={command.example}
                                name={content.commandExampleLabel}
                                labels={content.copyLabels}
                                className="min-w-0"
                              />
                            )}
                            <p className="text-foreground mt-[var(--spacing-3)] mb-1 text-xs font-semibold">
                              {content.commandUsageLabel}
                            </p>
                            <code className="bg-muted block min-w-0 overflow-x-auto rounded-[var(--r-sm)] p-[var(--spacing-2)] text-xs whitespace-pre">
                              {usage}
                            </code>
                            <p className="text-foreground mt-[var(--spacing-3)] mb-1 text-xs font-semibold">
                              {content.commandOptionsLabel}
                            </p>
                            <p className="text-muted-foreground m-0 text-xs break-words">
                              {surfaceCommand.options.join(' · ')}
                            </p>
                          </article>
                        )
                      })}
                    </Stack>
                  </div>
                </section>
              )
            return (
              <section
                key={id}
                id={id}
                data-toc-section
                className={sectionClassName}
                aria-labelledby={`${id}-heading`}
              >
                <h2 id={`${id}-heading`}>{section.title}</h2>
                <p className={guideSubClassName}>{section.body}</p>
              </section>
            )
          })}
          <Stack gap="12">
            <section
              className={guideSectionFollowClassName}
              aria-labelledby="token-guide-heading"
            >
              <GuideProse>
                <h2 id="token-guide-heading">
                  {locale === 'ja'
                    ? '非対話環境で使うAPIトークンを作成'
                    : 'Create an API token for non-interactive use'}
                </h2>
                <p>
                  {locale === 'ja'
                    ? 'CIなど、ブラウザでログインできない環境でCLIを使う場合は、APIトークンを作成してください。'
                    : 'If you use the CLI in CI or another environment without browser sign-in, create an API token.'}
                </p>
                <Link
                  to={withLang('/settings/tokens', locale)}
                  className="text-link underline"
                >
                  {locale === 'ja'
                    ? 'APIトークンを作成'
                    : 'Create an API token'}
                </Link>
              </GuideProse>
            </section>
            <section
              id="related"
              data-toc-section
              className={guideSectionFollowClassName}
              aria-labelledby="related-heading"
            >
              <GuideProse>
                <h2 id="related-heading">{content.sections.related.title}</h2>
                <p>{content.sections.related.body}</p>
                <nav aria-label={content.sections.related.title}>
                  <ul>
                    <li>
                      <Link
                        to={withLang(content.links.shareWithAi.href, locale)}
                      >
                        {content.links.shareWithAi.label}
                      </Link>
                    </li>
                    <li>
                      <Link to={withLang(content.links.connect.href, locale)}>
                        {content.links.connect.label}
                      </Link>
                    </li>
                    <li>
                      <Link to={withLang(content.links.updates.href, locale)}>
                        {content.links.updates.label}
                      </Link>
                    </li>
                    <li>
                      <Link
                        to={withLang(content.links.privateHandoff.href, locale)}
                      >
                        {content.links.privateHandoff.label}
                      </Link>
                    </li>
                    <li>
                      <a href={content.links.npm.href}>
                        {content.links.npm.label}
                      </a>
                    </li>
                  </ul>
                </nav>
              </GuideProse>
            </section>
            <GuideLanguageSwitcher
              locale={locale}
              hrefFor={(next) => withLang('/guides/cli', next)}
            />
          </Stack>
        </GuideMain>
        <GuideRail items={toc} title={content.tocTitle} />
      </GuideShell>
    </>
  )
}

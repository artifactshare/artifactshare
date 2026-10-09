import { useT } from '~/hooks/use-t'
import type { CspViolationMessage } from '~/lib/csp-reporter'

export interface ViolationEntry extends CspViolationMessage {
  id: string
  classification: 'artifact' | 'environment'
}

const groups = [
  {
    kind: 'artifact',
    label: 'csp.banner.fileGroup',
    summary: 'csp.banner.summary',
  },
  {
    kind: 'environment',
    label: 'csp.banner.environmentGroup',
    summary: 'csp.banner.environmentSummary',
  },
] as const

export function CspBanner({ violations }: { violations: ViolationEntry[] }) {
  const { t, tPlural } = useT()
  return (
    <aside
      className="text-foreground max-w-sandbox-toast-max border-border bg-card bottom-sandbox-banner-bottom fixed right-4 left-4 z-50 max-h-96 overflow-y-auto rounded-[var(--r-md)] border px-3.5 py-2.5 text-sm shadow-[var(--shadow-lg)] sm:left-auto"
      role="status"
    >
      {groups.map((group) => {
        const entries = violations.filter(
          (v) => v.classification === group.kind,
        )
        if (entries.length === 0) return null
        return (
          <section key={group.kind} className="my-1.5">
            <span className="block font-medium">
              {tPlural(group.summary, entries.length)}
            </span>
            {group.kind === 'environment' && (
              <p className="text-muted-foreground mt-1.5">
                {tPlural('csp.banner.environmentNote', entries.length)}
              </p>
            )}
            <details className="text-muted-foreground mt-1.5">
              <summary className="cursor-pointer select-none">
                {t('csp.banner.detailsSummary')} · {t(group.label)}
              </summary>
              <ul className="mt-2 list-disc pl-4">
                {entries.map((v) => (
                  <li key={v.id} className="my-0.5 break-all">
                    {t('csp.banner.blockedResource', {
                      directive: '{directive}',
                      uri: '{uri}',
                    })
                      .split(/(\{directive\}|\{uri\})/g)
                      .map((part, index) =>
                        part === '{directive}' || part === '{uri}' ? (
                          <code key={index} className="font-mono text-xs">
                            {part === '{directive}'
                              ? v.directive
                              : v.blockedURI}
                          </code>
                        ) : (
                          part
                        ),
                      )}
                    {v.sample && (
                      <div>
                        {t('csp.banner.sampleLabel')}:{' '}
                        <code className="font-mono text-xs whitespace-pre-wrap">
                          {v.sample}
                        </code>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          </section>
        )
      })}
    </aside>
  )
}

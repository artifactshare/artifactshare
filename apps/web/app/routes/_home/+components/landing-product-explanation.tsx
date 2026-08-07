import { Link } from 'react-router'

import {
  landingProductBodyClassName,
  landingProductCardBodyClassName,
  landingProductCardClassName,
  landingProductCardContentClassName,
  landingProductCardImageClassName,
  landingProductCardLabelClassName,
  landingProductCardTitleClassName,
  landingProductCardGridClassName,
  landingProductColumnClassName,
  landingProductCtaGroupClassName,
  landingProductHeadingClassName,
  landingProductInnerClassName,
  landingProductIntroBodyClassName,
  landingProductLinkClassName,
  landingProductSectionClassName,
  landingProductSplitClassName,
  landingProductStepGridClassName,
} from '~/components/app/landing-styles'
import { useT } from '~/hooks/use-t'
import { withLang } from '~/lib/connect-link'
import { PRODUCT_OVERVIEW_STEPS } from '~/lib/product-overview-content'

const WORKFLOW_CARDS = [
  {
    id: 'research',
    image: '/landing/research-review.webp',
    label: 'lp.workflow.cards.research.label',
    title: 'lp.workflow.cards.research.title',
    body: 'lp.workflow.cards.research.body',
  },
  {
    id: 'kpi',
    image: '/landing/kpi-decisions.webp',
    label: 'lp.workflow.cards.kpi.label',
    title: 'lp.workflow.cards.kpi.title',
    body: 'lp.workflow.cards.kpi.body',
  },
  {
    id: 'design',
    image: '/landing/design-review.webp',
    label: 'lp.workflow.cards.design.label',
    title: 'lp.workflow.cards.design.title',
    body: 'lp.workflow.cards.design.body',
  },
] as const

export function LandingProductExplanation({
  eagerImages = false,
}: {
  eagerImages?: boolean
}) {
  const { locale, t } = useT()

  return (
    <div>
      <section id="landing-flow" className={landingProductSectionClassName}>
        <div className={landingProductInnerClassName}>
          <div className={landingProductColumnClassName}>
            <h2 className={landingProductHeadingClassName}>
              {t('lp.flow.title')}
            </h2>
            <p className={landingProductIntroBodyClassName}>
              {t('lp.flow.body')}
            </p>
          </div>
          <div className={landingProductStepGridClassName}>
            {PRODUCT_OVERVIEW_STEPS.map((step, index) => (
              <article key={step.id} className={landingProductCardClassName}>
                <img
                  src={step.image}
                  alt={t(step.imageAlt)}
                  width={960}
                  height={720}
                  loading={eagerImages ? 'eager' : 'lazy'}
                  decoding="async"
                  className={landingProductCardImageClassName}
                />
                <div className={landingProductCardContentClassName}>
                  <span className={landingProductCardLabelClassName}>
                    {index + 1}
                  </span>
                  <h3 className={landingProductCardTitleClassName}>
                    {t(step.title)}
                  </h3>
                  <p className={landingProductCardBodyClassName}>
                    {t(step.body)}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className={landingProductSectionClassName}>
        <div className={landingProductInnerClassName}>
          <div className={landingProductColumnClassName}>
            <h2 className={landingProductHeadingClassName}>
              {t('lp.workflow.title')}
            </h2>
            <p className={landingProductIntroBodyClassName}>
              {t('lp.workflow.body')}
            </p>
          </div>
          <div className={landingProductCardGridClassName}>
            {WORKFLOW_CARDS.map((card) => {
              const label = t(card.label)
              const title = t(card.title)
              return (
                <article key={card.id} className={landingProductCardClassName}>
                  <img
                    src={card.image}
                    alt={`${label}: ${title}`}
                    width={960}
                    height={720}
                    loading={eagerImages ? 'eager' : 'lazy'}
                    decoding="async"
                    className={landingProductCardImageClassName}
                  />
                  <div className={landingProductCardContentClassName}>
                    <span className={landingProductCardLabelClassName}>
                      {label}
                    </span>
                    <h3 className={landingProductCardTitleClassName}>
                      {title}
                    </h3>
                    <p className={landingProductCardBodyClassName}>
                      {t(card.body)}
                    </p>
                  </div>
                </article>
              )
            })}
          </div>
        </div>
      </section>

      <section className={landingProductSectionClassName}>
        <div className={landingProductInnerClassName}>
          <div className={landingProductSplitClassName}>
            <div className={landingProductColumnClassName}>
              <h2 className={landingProductHeadingClassName}>
                {t('lp.ai.title')}
              </h2>
              <p className={landingProductBodyClassName}>{t('lp.ai.body')}</p>
              <Link
                className={landingProductLinkClassName}
                to={withLang('/connect', locale)}
              >
                {t('lp.ai.cta')}
              </Link>
            </div>
            <div className={landingProductColumnClassName}>
              <h2 className={landingProductHeadingClassName}>
                {t('lp.access.title')}
              </h2>
              <p className={landingProductBodyClassName}>
                {t('lp.access.body')}
              </p>
              <p className={landingProductBodyClassName}>
                {t('lp.access.startMethods')}
              </p>
              <div className={landingProductCtaGroupClassName}>
                <Link
                  className={landingProductLinkClassName}
                  to={withLang('/start', locale)}
                >
                  {t('lp.access.startCta')}
                </Link>
                <Link
                  className={landingProductLinkClassName}
                  to={withLang('/pricing', locale)}
                >
                  {t('lp.access.pricingCta')}
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

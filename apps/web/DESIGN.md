# Artifact Share web design

This document locates the existing design system for UI work. Read [PRODUCT.md](PRODUCT.md) for product purpose, users, and constraints.

## Sources of Truth

- [Design system](../../docs/reference/design-system.md): visual vocabulary, typography, component usage, interaction patterns, copy, and accessibility expectations.
- [Component catalog](app/components/catalog.ts): existing components, variants, and intentional differences from upstream components.
- [Theme](app/styles/theme.css) and [tokens](app/styles/tokens.css): implemented colors, spacing, sizes, and other design-token values.
- [Application stylesheet](app/app.css): application typography and shared stylesheet composition.
- Existing React components and their nearby style modules: behavior, states, DOM structure, and accessibility details.

Use these sources together. Keep design-system rules and token values in their existing files rather than duplicating them here.

## Working Principles

Keep artifact content prominent and application controls restrained. Use familiar sharing and file-management vocabulary, existing components, semantic tokens, readable text, and accessible controls.

Preserve the application's shared header and the separate document iframe when refining viewers. The application and the artifact own different controls and content. Respect each surface's existing font and delivery policy.

## Design Work

Use Impeccable for UI design and review. Inspect the existing implementation and the references above before proposing changes. Follow the repository development workflow for validation and review.

Local previews, mockups, generated critiques, and tool runtime state live in ignored `.impeccable/` directories. They are working material; adopted product decisions belong in the relevant source document.

import type { GallerySection } from './kit'
import { formSections } from './form-sections'
import { layoutSections } from './layout-sections'
import { uiSections } from './ui-sections'
import { appSections } from './app-sections'

export type { GallerySection }

export const gallerySections: GallerySection[] = [
  ...uiSections,
  ...formSections,
  ...layoutSections,
  ...appSections,
]

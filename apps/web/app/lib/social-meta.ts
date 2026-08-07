// Shared Open Graph + Twitter card tags for the marketing pages (home, privacy,
// terms). Each page passes its own title, description, URL, and card image; the
// fixed tag shape lives here so the pages can't drift apart.
interface SocialMetaInput {
  title: string
  description: string
  url: string
  image: string
  imageAlt?: string
}

export function socialMeta({
  title,
  description,
  url,
  image,
  imageAlt = 'Artifact Share',
}: SocialMetaInput) {
  return [
    { property: 'og:type', content: 'website' },
    { property: 'og:site_name', content: 'Artifact Share' },
    { property: 'og:title', content: title },
    { property: 'og:description', content: description },
    { property: 'og:url', content: url },
    { property: 'og:image', content: image },
    { property: 'og:image:width', content: '1200' },
    { property: 'og:image:height', content: '630' },
    { property: 'og:image:alt', content: imageAlt },
    { name: 'twitter:card', content: 'summary_large_image' },
    { name: 'twitter:title', content: title },
    { name: 'twitter:description', content: description },
    { name: 'twitter:image', content: image },
  ]
}

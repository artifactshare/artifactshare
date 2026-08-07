# Project Status — Week 19

A quick check-in. Shareable read-only, internal team.

## Highlights

- Markdown rendering shipped inside the sandbox iframe
- View counts denormalized — home gallery skips the LEFT JOIN scan
- Sign-in scope tightened to OIDC only — no sensitive scope, no Marketplace verification gate

## Open Questions

1. Recording cadence post-launch — weekly status MDs or just incident notes?
2. Whether to backport Markdown rendering edge cases (older `text/plain` MIMEs)
3. v1.1 timing for connector discovery and CLI publish polish

## Snippet

```ts
// Example: detect the artifact type from MIME + filename
detectArtifactType('text/markdown', 'notes.md')   // → 'md'
detectArtifactType('text/html', 'index.html')      // → 'html'
detectArtifactType('application/pdf', 'doc.pdf')   // → null
```

## Links

- [Privacy policy](https://artifactshare.com/privacy)
- [Terms](https://artifactshare.com/terms)

---

_Drafted locally · shared via Artifact Share._
